import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileContentStore } from "../files/fileContentStore.js";
import { initializeGenesisFileSystem } from "../files/genesisFileSystem.js";
import { ImmutableObjectRepository } from "../files/immutableObjectRepository.js";
import type {
  CreateObjectResult,
  ImmutableObjectStore,
  ObjectKey,
  ObjectListItem,
  ObjectMetadata,
} from "../files/objectStore.js";
import { TargetTreeProjector } from "./targetTreeProjector.js";
import { WorkspaceCommitCoordinator } from "./workspaceCommitCoordinator.js";
import { WorkspaceCommitObjectBuilder } from "./workspaceCommitObjectBuilder.js";

const roots: string[] = [];
const runIdHex = "30".repeat(16);
const workspaceIdHex = "40".repeat(16);
const limits = {
  maxEntries: 100,
  maxDepth: 10,
  maxFileBytes: 1024,
  maxTotalBytes: 4096,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("WorkspaceCommitCoordinator", () => {
  it("completes an unchanged Run without writing metadata or advancing revision", async () => {
    const fixture = await setup();
    const build = vi.fn();
    const coordinator = new WorkspaceCommitCoordinator({
      repository: fixture.repository,
      refStore: fixture.store,
      scanner: { scan: async () => emptyScan() },
      projector: new TargetTreeProjector({ now: () => 200 }),
      materializer: { materialize: async () => new Map() },
      builder: { build },
      limits,
      now: () => 200,
    });

    const result = await coordinator.commit({
      runIdHex,
      upperPath: `/runtime/${runIdHex}/upper`,
    });

    expect(result).toMatchObject({
      outcome: "committed",
      changed: false,
      operationCount: 0,
      ref: { revision: 0, headFidHex: fixture.headFidHex },
      run: { state: "COMMITTED", outputHeadFidHex: fixture.headFidHex },
    });
    expect(build).not.toHaveBeenCalled();
    expect(fixture.store.getWorkspace(workspaceIdHex).activeWriteRunIdHex)
      .toBeNull();
    fixture.store.close();
  });

  it("publishes a changed Upper as one verified Workspace revision", async () => {
    const fixture = await setup();
    const content = await new FileContentStore(fixture.repository).putBytes(
      Buffer.from("result"),
    );
    const coordinator = new WorkspaceCommitCoordinator({
      repository: fixture.repository,
      refStore: fixture.store,
      scanner: {
        scan: async () => ({
          schemaVersion: 1,
          totalFileBytes: content.size,
          entries: [
            {
              path: "result.txt",
              kind: "file",
              size: content.size,
              mtimeNs: "200000000",
              ctimeNs: "200000000",
              device: "1",
              inode: "2",
              opaque: false,
            },
          ],
        }),
      },
      projector: new TargetTreeProjector({
        now: () => 200,
        randomId: () => id(0x50),
      }),
      materializer: {
        materialize: async () => new Map([["result.txt", content]]),
      },
      builder: new WorkspaceCommitObjectBuilder({
        repository: fixture.repository,
        writerId: "workspace-runtime",
        randomId: () => id(0x60),
      }),
      limits,
      now: () => 200,
    });

    const result = await coordinator.commit({
      runIdHex,
      upperPath: `/runtime/${runIdHex}/upper`,
    });

    expect(result).toMatchObject({
      outcome: "committed",
      changed: true,
      operationCount: 1,
      ref: { revision: 1 },
      run: { state: "COMMITTED" },
    });
    expect(result.ref.headFidHex).toBe(result.objects?.headFidHex);
    expect(fixture.store.getWorkspace(workspaceIdHex).activeWriteRunIdHex)
      .toBeNull();
    fixture.store.close();
  });

  it("fails closed and releases the lease when Upper scanning fails", async () => {
    const fixture = await setup();
    const coordinator = new WorkspaceCommitCoordinator({
      repository: fixture.repository,
      refStore: fixture.store,
      scanner: {
        scan: async () => {
          throw new Error("unsafe Upper");
        },
      },
      projector: new TargetTreeProjector(),
      materializer: { materialize: async () => new Map() },
      builder: { build: vi.fn() },
      limits,
      now: () => 200,
    });

    await expect(
      coordinator.commit({
        runIdHex,
        upperPath: `/runtime/${runIdHex}/upper`,
      }),
    ).rejects.toThrow("unsafe Upper");
    expect(fixture.store.getWorkspaceRun(runIdHex)).toMatchObject({
      state: "FAILED",
      errorCode: "COW_COMMIT_FAILED",
      outputHeadFidHex: null,
    });
    expect(fixture.store.getRef(`ws-${workspaceIdHex}`)).toMatchObject({
      revision: 0,
      headFidHex: fixture.headFidHex,
    });
    expect(fixture.store.getWorkspace(workspaceIdHex).activeWriteRunIdHex)
      .toBeNull();
    fixture.store.close();
  });

  it("records a no-op publication race as CONFLICT without overwriting the winner", async () => {
    const fixture = await setup();
    const winnerHeadFidHex = "70".repeat(16);
    const coordinator = new WorkspaceCommitCoordinator({
      repository: fixture.repository,
      refStore: fixture.store,
      scanner: {
        scan: async () => {
          fixture.store.compareAndSwap({
            refId: `ws-${workspaceIdHex}`,
            expectedHeadFidHex: fixture.headFidHex,
            expectedRevision: 0,
            newHeadFidHex: winnerHeadFidHex,
            newRevision: 1,
            updatedAtMs: 190,
          });
          return emptyScan();
        },
      },
      projector: new TargetTreeProjector({ now: () => 200 }),
      materializer: { materialize: async () => new Map() },
      builder: { build: vi.fn() },
      limits,
      now: () => 200,
    });

    const result = await coordinator.commit({
      runIdHex,
      upperPath: `/runtime/${runIdHex}/upper`,
    });

    expect(result).toMatchObject({
      outcome: "conflict",
      changed: false,
      ref: { revision: 1, headFidHex: winnerHeadFidHex },
      run: { state: "CONFLICT", errorCode: "REF_CONFLICT" },
    });
    expect(fixture.store.getWorkspace(workspaceIdHex).activeWriteRunIdHex)
      .toBeNull();
    fixture.store.close();
  });
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "biunivers-commit-coordinator-"));
  roots.push(root);
  const repository = new ImmutableObjectRepository(
    new MemoryStore(),
    "users/alice",
  );
  const genesisIds = [id(0x10), id(0x20)];
  const genesis = await initializeGenesisFileSystem({
    databasePath: join(root, "refs.sqlite"),
    repository,
    writerId: "genesis",
    createdAtMs: 100,
    randomId: () => genesisIds.shift()!,
  });
  const refId = `ws-${workspaceIdHex}`;
  genesis.store.createWorkspace({
    workspaceIdHex,
    refId,
    name: "Commit fixture",
    sourceRefId: "main",
    sourceHeadFidHex: genesis.ref.headFidHex,
    baselineHeadFidHex: genesis.ref.headFidHex,
    state: "READY",
    retention: "KEPT",
    activeWriteRunIdHex: null,
    createdAtMs: 110,
    updatedAtMs: 110,
    ref: { ...genesis.ref, refId, updatedAtMs: 110 },
  });
  genesis.store.createWorkspaceRun({
    runIdHex,
    workspaceIdHex,
    executorId: "system.diagnostic",
    inputHeadFidHex: genesis.ref.headFidHex,
    createdAtMs: 120,
  });
  genesis.store.transitionWorkspaceRun({
    runIdHex,
    expectedState: "PREPARING",
    newState: "RUNNING",
    runtimeIdentity: "fixture-container",
    timestampMs: 130,
  });
  genesis.store.transitionWorkspaceRun({
    runIdHex,
    expectedState: "RUNNING",
    newState: "STOPPED",
    timestampMs: 140,
  });
  return {
    repository,
    store: genesis.store,
    headFidHex: genesis.ref.headFidHex,
  };
}

function emptyScan() {
  return {
    schemaVersion: 1 as const,
    entries: [],
    totalFileBytes: 0,
  };
}

class MemoryStore implements ImmutableObjectStore {
  readonly objects = new Map<string, Uint8Array>();

  async create(
    key: ObjectKey,
    completeBytes: Uint8Array,
  ): Promise<CreateObjectResult> {
    const encoded = JSON.stringify(key);
    const existing = this.objects.get(encoded);
    if (existing) {
      if (!Buffer.from(existing).equals(Buffer.from(completeBytes))) {
        throw new Error("collision");
      }
      return "already-exists-identical";
    }
    this.objects.set(encoded, Uint8Array.from(completeBytes));
    return "created";
  }

  async get(key: ObjectKey): Promise<Uint8Array> {
    const bytes = this.objects.get(JSON.stringify(key));
    if (!bytes) throw new Error("missing");
    return Uint8Array.from(bytes);
  }

  async head(key: ObjectKey): Promise<ObjectMetadata> {
    return { size: (await this.get(key)).byteLength };
  }

  async list(): Promise<ObjectListItem[]> {
    return [];
  }
}

function id(byte: number): Uint8Array {
  return Uint8Array.from({ length: 16 }, () => byte);
}
