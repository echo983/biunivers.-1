import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileContentStore } from "./fileContentStore.js";
import { loadCurrentEntryIndex } from "./entryIndex.js";
import { FileSystemTransactions } from "./fileSystemTransactions.js";
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
    if (!bytes) {
      throw new Error("missing");
    }
    return Uint8Array.from(bytes);
  }

  async head(key: ObjectKey): Promise<ObjectMetadata> {
    return { size: (await this.get(key)).byteLength };
  }

  async list(): Promise<ObjectListItem[]> {
    return [];
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "biunivers-transactions-"));
  roots.push(root);
  const databasePath = join(root, "file-service.sqlite");
  const objectStore = new MemoryStore();
  const repository = new ImmutableObjectRepository(
    objectStore,
    "users/alice",
  );
  const genesisIds = [id(0x10), id(0x20)];
  const genesis = await initializeGenesisFileSystem({
    databasePath,
    repository,
    writerId: "test",
    createdAtMs: 100,
    randomId: () => genesisIds.shift()!,
  });
  return {
    databasePath,
    objectStore,
    repository,
    refStore: genesis.store,
    rootEntryIdHex: genesis.rootEntryIdHex,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("FileSystemTransactions", () => {
  it("publishes create and content update through Segment, Checkpoint, Head, and CAS", async () => {
    const setupResult = await setup();
    const contentStore = new FileContentStore(setupResult.repository);
    const firstContent = await contentStore.putBytes(Buffer.from("first"));
    const transactionIds = [id(0x30), id(0x40), id(0x50)];
    const transactions = new FileSystemTransactions({
      refId: "main",
      repository: setupResult.repository,
      refStore: setupResult.refStore,
      writerId: "test",
      now: () => 200,
      randomId: () => transactionIds.shift()!,
    });

    const created = await transactions.createFile({
      parentEntryIdHex: setupResult.rootEntryIdHex,
      name: "notes.md",
      content: firstContent,
    });
    expect(created.ref.revision).toBe(1);
    expect(created.entryIdHex).toBe("30303030303030303030303030303030");

    const secondContent = await contentStore.putBytes(Buffer.from("second"));
    const updated = await transactions.setFileContent({
      entryIdHex: created.entryIdHex,
      expectedContentFidHex: firstContent.fidHex,
      content: secondContent,
      mtimeMs: 300,
    });
    expect(updated.ref.revision).toBe(2);

    const core = loadPvlogCore();
    const head = await setupResult.repository.get(
      "heads",
      updated.ref.headFidHex,
    );
    expect(core.headRevision(head)).toBe(2n);
    expect(() => core.validateHead(head)).not.toThrow();
    const checkpoint = await setupResult.repository.get(
      "checkpoints",
      updated.checkpointFidHex,
    );
    expect(() => core.validateCheckpoint(checkpoint)).not.toThrow();
    setupResult.refStore.close();
  });

  it("allows one concurrent publisher and returns REF_CONFLICT to the loser", async () => {
    const setupResult = await setup();
    const secondConnection = await SqliteRefStore.openExisting(
      setupResult.databasePath,
    );
    const contentStore = new FileContentStore(setupResult.repository);
    const content = await contentStore.putBytes(Buffer.from("content"));
    let releaseFirst!: () => void;
    let firstReachedPublish!: () => void;
    const waitForRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const reachedPublish = new Promise<void>((resolve) => {
      firstReachedPublish = resolve;
    });
    const firstIds = [id(0x31), id(0x41)];
    const first = new FileSystemTransactions({
      refId: "main",
      repository: setupResult.repository,
      refStore: setupResult.refStore,
      writerId: "first",
      now: () => 200,
      randomId: () => firstIds.shift()!,
      beforePublish: async () => {
        firstReachedPublish();
        await waitForRelease;
      },
    });
    const secondIds = [id(0x32), id(0x42)];
    const second = new FileSystemTransactions({
      refId: "main",
      repository: setupResult.repository,
      refStore: secondConnection,
      writerId: "second",
      now: () => 201,
      randomId: () => secondIds.shift()!,
    });

    const losingPublication = first.createFile({
      parentEntryIdHex: setupResult.rootEntryIdHex,
      name: "first.md",
      content,
    });
    await reachedPublish;
    const winner = await second.createFile({
      parentEntryIdHex: setupResult.rootEntryIdHex,
      name: "second.md",
      content,
    });
    releaseFirst();

    expect(winner.ref.revision).toBe(1);
    await expect(losingPublication).rejects.toMatchObject({
      code: "REF_CONFLICT",
    });
    expect(setupResult.refStore.getRef("main").headFidHex).toBe(
      winner.ref.headFidHex,
    );
    secondConnection.close();
    setupResult.refStore.close();
  });

  it("preserves Entry IDs through directory CRUD, move, rename, and recursive delete", async () => {
    const setupResult = await setup();
    const contentStore = new FileContentStore(setupResult.repository);
    const content = await contentStore.putBytes(Buffer.from("notes"));
    const ids = [
      id(0x31),
      id(0x41),
      id(0x32),
      id(0x42),
      id(0x43),
      id(0x33),
      id(0x44),
      id(0x45),
      id(0x46),
    ];
    const transactions = new FileSystemTransactions({
      refId: "main",
      repository: setupResult.repository,
      refStore: setupResult.refStore,
      writerId: "crud-test",
      now: () => 200,
      randomId: () => ids.shift()!,
    });

    const directory = await transactions.createDirectory({
      parentEntryIdHex: setupResult.rootEntryIdHex,
      name: "docs",
    });
    const file = await transactions.createFile({
      parentEntryIdHex: directory.entryIdHex,
      name: "notes.md",
      content,
    });
    await transactions.moveEntry({
      entryIdHex: file.entryIdHex,
      newParentEntryIdHex: setupResult.rootEntryIdHex,
      newName: "renamed.md",
    });
    const nested = await transactions.createDirectory({
      parentEntryIdHex: directory.entryIdHex,
      name: "nested",
    });

    await expect(
      transactions.removeEntry({
        entryIdHex: directory.entryIdHex,
        recursive: false,
      }),
    ).rejects.toThrow("recursive=true");
    const removed = await transactions.removeEntry({
      entryIdHex: directory.entryIdHex,
      recursive: true,
    });
    expect(removed.ref.revision).toBe(5);

    const index = await loadCurrentEntryIndex(
      setupResult.repository,
      setupResult.refStore,
      "main",
    );
    expect(index.revision).toBe(5);
    expect(index.has(directory.entryIdHex)).toBe(false);
    expect(index.has(nested.entryIdHex)).toBe(false);
    expect(index.get(file.entryIdHex)).toMatchObject({
      entryIdHex: file.entryIdHex,
      parentEntryIdHex: setupResult.rootEntryIdHex,
      name: "renamed.md",
      kind: "file",
      content,
    });
    expect(index.listChildren(setupResult.rootEntryIdHex).map((entry) => entry.name))
      .toEqual(["renamed.md"]);
    setupResult.refStore.close();
  });

  it("publishes only to its explicit Ref and leaves main unchanged", async () => {
    const setupResult = await setup();
    const core = loadPvlogCore();
    const lineageId = id(0x70);
    const rootEntryId = id(0x71);
    const checkpointBytes = core.encodeGenesisCheckpoint(
      lineageId,
      rootEntryId,
      150n,
    );
    const checkpoint = await setupResult.repository.put(
      "checkpoints",
      checkpointBytes,
    );
    const headBytes = core.encodeGenesisHead(
      lineageId,
      rootEntryId,
      Buffer.from(checkpoint.key.fidHex, "hex"),
      150n,
      "workspace",
    );
    const head = await setupResult.repository.put("heads", headBytes);
    const workspaceRefId = `ws-${"72".repeat(16)}`;
    setupResult.refStore.createRef({
      refId: workspaceRefId,
      lineageIdHex: Buffer.from(lineageId).toString("hex"),
      headFidHex: head.key.fidHex,
      revision: 0,
      updatedAtMs: 150,
    });
    const mainBefore = setupResult.refStore.getRef("main");
    const ids = [id(0x73), id(0x74)];
    const transactions = new FileSystemTransactions({
      refId: workspaceRefId,
      repository: setupResult.repository,
      refStore: setupResult.refStore,
      writerId: "workspace",
      now: () => 200,
      randomId: () => ids.shift()!,
    });

    const created = await transactions.createDirectory({
      parentEntryIdHex: Buffer.from(rootEntryId).toString("hex"),
      name: "output",
    });

    expect(created.ref).toMatchObject({
      refId: workspaceRefId,
      revision: 1,
    });
    expect(setupResult.refStore.getRef("main")).toEqual(mainBefore);
    const mainIndex = await loadCurrentEntryIndex(
      setupResult.repository,
      setupResult.refStore,
      "main",
    );
    const workspaceIndex = await loadCurrentEntryIndex(
      setupResult.repository,
      setupResult.refStore,
      workspaceRefId,
    );
    expect(mainIndex.listChildren(mainIndex.rootEntryIdHex)).toEqual([]);
    expect(
      workspaceIndex
        .listChildren(workspaceIndex.rootEntryIdHex)
        .map((entry) => entry.name),
    ).toEqual(["output"]);
    setupResult.refStore.close();
  });
});

function id(byte: number): Uint8Array {
  return Uint8Array.from({ length: 16 }, () => byte);
}
