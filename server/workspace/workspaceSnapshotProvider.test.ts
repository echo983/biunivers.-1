import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileContentStore } from "../files/fileContentStore.js";
import { FileSystemTransactions } from "../files/fileSystemTransactions.js";
import { initializeGenesisFileSystem } from "../files/genesisFileSystem.js";
import { ImmutableObjectRepository } from "../files/immutableObjectRepository.js";
import { LocalWormObjectStore } from "../files/localWormObjectStore.js";
import { WorkspaceSnapshotProvider } from "./workspaceSnapshotProvider.js";

const roots: string[] = [];
const workspaceIdHex = "77".repeat(16);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "biunivers-snapshot-"));
  roots.push(root);
  const repository = new ImmutableObjectRepository(
    new LocalWormObjectStore(join(root, "objects")),
    "users/alice",
  );
  const genesisIds = [id(0x80), id(0x90)];
  const genesis = await initializeGenesisFileSystem({
    databasePath: join(root, "refs.sqlite"),
    repository,
    writerId: "test",
    createdAtMs: 100,
    randomId: () => genesisIds.shift()!,
  });
  const ids = [id(0xa0), id(0x20), id(0xa1), id(0x10)];
  const transactions = new FileSystemTransactions({
    refId: "main",
    repository,
    refStore: genesis.store,
    writerId: "test",
    now: () => 200,
    randomId: () => ids.shift()!,
  });
  const content = await new FileContentStore(repository).putBytes(
    Buffer.from("snapshot"),
  );
  const file = await transactions.createFile({
    parentEntryIdHex: genesis.rootEntryIdHex,
    name: "later-id.txt",
    content,
  });
  const directory = await transactions.createDirectory({
    parentEntryIdHex: genesis.rootEntryIdHex,
    name: "earlier-id",
  });
  const main = genesis.store.getRef("main");
  const refId = `ws-${workspaceIdHex}`;
  genesis.store.createWorkspace({
    workspaceIdHex,
    refId,
    name: "Snapshot test",
    sourceRefId: "main",
    sourceHeadFidHex: main.headFidHex,
    baselineHeadFidHex: main.headFidHex,
    state: "READY",
    retention: "TEMPORARY",
    activeWriteRunIdHex: null,
    createdAtMs: 300,
    updatedAtMs: 300,
    ref: { ...main, refId, updatedAtMs: 300 },
  });
  return {
    repository,
    refStore: genesis.store,
    rootEntryIdHex: genesis.rootEntryIdHex,
    file,
    directory,
    refId,
  };
}

describe("WorkspaceSnapshotProvider", () => {
  it("captures a fixed Workspace HEAD with stable Entry-ID-sorted inodes", async () => {
    const setupResult = await setup();
    const provider = new WorkspaceSnapshotProvider(setupResult);
    const first = await provider.capture(workspaceIdHex);
    const second = await provider.capture(workspaceIdHex);

    expect(first.headFidHex).toBe(second.headFidHex);
    expect(first.revision).toBe(2);
    expect(first.rootInode).toBe(1);
    const sortedChildren = [
      setupResult.directory.entryIdHex,
      setupResult.file.entryIdHex,
    ].sort();
    expect(
      first.entries.map((entry) => [entry.entryIdHex, entry.inode]),
    ).toEqual([
      [setupResult.rootEntryIdHex, 1],
      [sortedChildren[0], 2],
      [sortedChildren[1], 3],
    ]);
    expect(second.entries).toEqual(first.entries);
    expect(
      first.entries.find(
        (entry) => entry.entryIdHex === setupResult.file.entryIdHex,
      )?.content,
    ).toEqual(expect.objectContaining({ size: 8 }));
  });

  it("rejects a Workspace Ref change during snapshot construction", async () => {
    const setupResult = await setup();
    const provider = new WorkspaceSnapshotProvider({
      ...setupResult,
      beforeFinalRefRead: () => {
        const current = setupResult.refStore.getRef(setupResult.refId);
        setupResult.refStore.compareAndSwap({
          refId: setupResult.refId,
          expectedHeadFidHex: current.headFidHex,
          expectedRevision: current.revision,
          newHeadFidHex: "cc".repeat(16),
          newRevision: current.revision + 1,
          updatedAtMs: current.updatedAtMs + 1,
        });
      },
    });
    await expect(provider.capture(workspaceIdHex)).rejects.toMatchObject({
      code: "REF_CONFLICT",
    });
  });
});

function id(byte: number): Uint8Array {
  return new Uint8Array(16).fill(byte);
}
