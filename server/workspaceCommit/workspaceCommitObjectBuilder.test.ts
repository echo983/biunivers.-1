import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EntryIndex, parsePackedEntries } from "../files/entryIndex.js";
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
import { loadPvlogCore } from "../files/pvlogCore.js";
import { WorkspaceCommitObjectBuilder } from "./workspaceCommitObjectBuilder.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("WorkspaceCommitObjectBuilder", () => {
  it("builds and verifies immutable metadata without publishing the Ref", async () => {
    const root = await mkdtemp(join(tmpdir(), "biunivers-commit-objects-"));
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
    const content = await new FileContentStore(repository).putBytes(
      Buffer.from("workspace output"),
    );
    const before = genesis.store.getRef("main");
    const entryIdHex = "30".repeat(16);

    const result = await new WorkspaceCommitObjectBuilder({
      repository,
      writerId: "workspace-runtime",
      randomId: () => id(0x40),
    }).build({
      baseHeadFidHex: before.headFidHex,
      expectedRevision: before.revision,
      timestampMs: 200,
      operations: [
        {
          kind: "create-file",
          entryIdHex,
          parentEntryIdHex: genesis.rootEntryIdHex,
          name: "result.txt",
          content,
          mtimeMs: 200,
        },
      ],
    });

    expect(genesis.store.getRef("main")).toEqual(before);
    expect(result).toMatchObject({
      baseHeadFidHex: before.headFidHex,
      revision: 1,
    });
    const core = loadPvlogCore();
    const head = await repository.get("heads", result.headFidHex);
    expect(core.headRevision(head)).toBe(1n);
    expect(Buffer.from(core.headParentFid(head)).toString("hex")).toBe(
      before.headFidHex,
    );
    const checkpoint = await repository.get(
      "checkpoints",
      result.checkpointFidHex,
    );
    const index = new EntryIndex(
      result.revision,
      parsePackedEntries(core.checkpointEntriesPacked(checkpoint)),
    );
    expect(index.get(entryIdHex)).toMatchObject({
      name: "result.txt",
      content,
    });
    genesis.store.close();
  });

  it("rejects a base Head whose revision does not match the fixed input", async () => {
    const root = await mkdtemp(join(tmpdir(), "biunivers-commit-objects-"));
    roots.push(root);
    const repository = new ImmutableObjectRepository(
      new MemoryStore(),
      "users/alice",
    );
    const ids = [id(0x11), id(0x21)];
    const genesis = await initializeGenesisFileSystem({
      databasePath: join(root, "refs.sqlite"),
      repository,
      writerId: "genesis",
      createdAtMs: 100,
      randomId: () => ids.shift()!,
    });

    await expect(
      new WorkspaceCommitObjectBuilder({
        repository,
        writerId: "workspace-runtime",
        randomId: () => id(0x41),
      }).build({
        baseHeadFidHex: genesis.ref.headFidHex,
        expectedRevision: 1,
        timestampMs: 200,
        operations: [
          {
            kind: "remove",
            entryIdHex: genesis.rootEntryIdHex,
            recursive: true,
          },
        ],
      }),
    ).rejects.toThrow("revision");
    genesis.store.close();
  });
});

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
