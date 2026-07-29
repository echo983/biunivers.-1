import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeGenesisFileSystem } from "./genesisFileSystem.js";
import { ImmutableObjectRepository } from "./immutableObjectRepository.js";
import type {
  CreateObjectResult,
  ImmutableObjectStore,
  ObjectKey,
  ObjectListItem,
  ObjectMetadata,
} from "./objectStore.js";
import { loadPvlogCore } from "./pvlogCore.js";
import { SqliteRefStore } from "./sqliteRefStore.js";

const roots: string[] = [];

class MemoryStore implements ImmutableObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  failKind?: string;

  async create(
    key: ObjectKey,
    completeBytes: Uint8Array,
  ): Promise<CreateObjectResult> {
    if (key.kind === this.failKind) {
      throw new Error("injected object write failure");
    }
    this.objects.set(JSON.stringify(key), Uint8Array.from(completeBytes));
    return "created";
  }

  async get(key: ObjectKey): Promise<Uint8Array> {
    const value = this.objects.get(JSON.stringify(key));
    if (!value) {
      throw new Error("missing");
    }
    return Uint8Array.from(value);
  }

  async head(key: ObjectKey): Promise<ObjectMetadata> {
    return { size: (await this.get(key)).byteLength };
  }

  async list(): Promise<ObjectListItem[]> {
    return [];
  }
}

async function testPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "biunivers-genesis-"));
  roots.push(root);
  return join(root, "file-service.sqlite");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("initializeGenesisFileSystem", () => {
  it("persists checkpoint and head before atomically publishing main", async () => {
    const databasePath = await testPath();
    const objectStore = new MemoryStore();
    const repository = new ImmutableObjectRepository(
      objectStore,
      "users/alice",
    );
    const ids = [
      Uint8Array.from({ length: 16 }, () => 0x10),
      Uint8Array.from({ length: 16 }, () => 0x20),
    ];

    const result = await initializeGenesisFileSystem({
      databasePath,
      repository,
      writerId: "genesis-test",
      createdAtMs: 1_785_320_000_000,
      randomId: () => ids.shift()!,
    });

    expect(result.ref).toMatchObject({
      refId: "main",
      lineageIdHex: "10101010101010101010101010101010",
      revision: 0,
    });
    expect(result.rootEntryIdHex).toBe("20202020202020202020202020202020");
    expect(objectStore.objects.size).toBe(2);
    expect(result.store.getRef("main")).toEqual(result.ref);
    result.store.close();

    const reopened = await SqliteRefStore.openExisting(databasePath);
    expect(reopened.getRef("main")).toEqual(result.ref);
    reopened.close();
  });

  it("does not publish a Ref when immutable Head persistence fails", async () => {
    const databasePath = await testPath();
    const objectStore = new MemoryStore();
    objectStore.failKind = "heads";
    const repository = new ImmutableObjectRepository(
      objectStore,
      "users/alice",
    );
    const core = loadPvlogCore();

    await expect(
      initializeGenesisFileSystem({
        databasePath,
        repository,
        writerId: "genesis-test",
        createdAtMs: 1_785_320_000_000,
        core,
        randomId: () => Uint8Array.from({ length: 16 }, () => 0x10),
      }),
    ).rejects.toThrow("injected object write failure");
    await expect(SqliteRefStore.openExisting(databasePath)).rejects.toMatchObject(
      { code: "REFSTORE_MISSING" },
    );
  });
});
