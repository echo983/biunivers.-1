import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileContentStore } from "./fileContentStore.js";
import { FileServiceGcScanner } from "./fileServiceGcScanner.js";
import { FileSystemTransactions } from "./fileSystemTransactions.js";
import { initializeGenesisFileSystem } from "./genesisFileSystem.js";
import { ImmutableObjectRepository } from "./immutableObjectRepository.js";
import { LocalWormObjectStore } from "./localWormObjectStore.js";
import { loadPvlogCore } from "./pvlogCore.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("FileServiceGcScanner", () => {
  it("reports unreachable objects without deleting them", async () => {
    const root = await mkdtemp(join(tmpdir(), "biunivers-gc-"));
    roots.push(root);
    const repository = new ImmutableObjectRepository(
      new LocalWormObjectStore(join(root, "objects")),
      "users/alice",
    );
    const genesis = await initializeGenesisFileSystem({
      databasePath: join(root, "file-service.sqlite"),
      repository,
      writerId: "test",
    });
    const content = await new FileContentStore(repository).putBytes(
      Buffer.from("reachable"),
    );
    await new FileSystemTransactions({
      repository,
      refStore: genesis.store,
      writerId: "test",
    }).createFile({
      parentEntryIdHex: genesis.rootEntryIdHex,
      name: "note.txt",
      content,
    });
    const orphan = await repository.put("chunks", Buffer.from("orphan"));

    const report = await new FileServiceGcScanner({
      repository,
      refStore: genesis.store,
      now: () => new Date("2026-07-29T12:00:00.000Z"),
    }).scan();

    expect(report).toMatchObject({
      completedAt: "2026-07-29T12:00:00.000Z",
      complete: true,
      deletionAllowed: false,
      reachable: {
        heads: { count: 2 },
        segments: { count: 1 },
        checkpoints: { count: 2 },
        chunks: { count: 1 },
      },
      candidates: {
        chunks: { count: 1, bytes: 6 },
      },
      candidateFids: {
        chunks: [orphan.key.fidHex],
      },
      candidateFidsTruncated: false,
    });
    await expect(repository.get("chunks", orphan.key.fidHex)).resolves.toEqual(
      Buffer.from("orphan"),
    );
    genesis.store.close();
  });

  it("protects independent Workspace Ref histories instead of scanning only main", async () => {
    const root = await mkdtemp(join(tmpdir(), "biunivers-gc-workspace-"));
    roots.push(root);
    const repository = new ImmutableObjectRepository(
      new LocalWormObjectStore(join(root, "objects")),
      "users/alice",
    );
    const genesis = await initializeGenesisFileSystem({
      databasePath: join(root, "file-service.sqlite"),
      repository,
      writerId: "test",
    });
    const core = loadPvlogCore();
    const lineageId = Buffer.alloc(16, 0xb1);
    const rootEntryId = Buffer.alloc(16, 0xb2);
    const checkpointBytes = core.encodeGenesisCheckpoint(
      lineageId,
      rootEntryId,
      1_785_320_000_100n,
    );
    const checkpoint = await repository.put("checkpoints", checkpointBytes);
    const headBytes = core.encodeGenesisHead(
      lineageId,
      rootEntryId,
      Buffer.from(checkpoint.key.fidHex, "hex"),
      1_785_320_000_100n,
      "workspace-test",
    );
    const head = await repository.put("heads", headBytes);
    const workspaceIdHex = "b3".repeat(16);
    genesis.store.createWorkspace({
      workspaceIdHex,
      refId: `ws-${workspaceIdHex}`,
      name: "Independent",
      sourceRefId: "main",
      sourceHeadFidHex: genesis.ref.headFidHex,
      baselineHeadFidHex: head.key.fidHex,
      state: "READY",
      retention: "KEPT",
      activeWriteRunIdHex: null,
      createdAtMs: 1_785_320_000_100,
      updatedAtMs: 1_785_320_000_100,
      ref: {
        refId: `ws-${workspaceIdHex}`,
        lineageIdHex: lineageId.toString("hex"),
        headFidHex: head.key.fidHex,
        revision: 0,
        updatedAtMs: 1_785_320_000_100,
      },
    });

    const report = await new FileServiceGcScanner({
      repository,
      refStore: genesis.store,
    }).scan();

    expect(report.reachable.heads.count).toBe(2);
    expect(report.reachable.checkpoints.count).toBe(2);
    expect(report.candidates.heads.count).toBe(0);
    expect(report.candidates.checkpoints.count).toBe(0);
    genesis.store.close();
  });
});
