import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCurrentEntryIndex } from "./entryIndex.js";
import { FileCapabilityRegistry } from "./fileCapabilityRegistry.js";
import { FileContentStore } from "./fileContentStore.js";
import { FileSystemTransactions } from "./fileSystemTransactions.js";
import { initializeGenesisFileSystem } from "./genesisFileSystem.js";
import { ImmutableObjectRepository } from "./immutableObjectRepository.js";
import { InternalFileManagerService } from "./internalFileManagerService.js";
import { LocalWormObjectStore } from "./localWormObjectStore.js";

const roots: string[] = [];

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "biunivers-file-manager-"));
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
  const capabilities = new FileCapabilityRegistry();
  const service = new InternalFileManagerService({
    repository,
    refStore: genesis.store,
    capabilities,
    writerId: "test",
  });
  const instanceToken = capabilities.createInstance(
    "system.files",
    "files-window",
  ).instanceToken;
  return { repository, genesis, capabilities, service, instanceToken };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("InternalFileManagerService", () => {
  it("exports a directory tree from one immutable revision snapshot", async () => {
    const { repository, genesis, service, instanceToken } = await setup();
    const directory = await service.createDirectory(instanceToken, {
      parentEntryId: genesis.rootEntryIdHex,
      name: "资料",
      expectedRevision: 0,
    });
    await service.createDirectory(instanceToken, {
      parentEntryId: directory.entryId,
      name: "空目录",
      expectedRevision: 1,
    });
    const contentStore = new FileContentStore(repository);
    const before = await contentStore.putBytes(Buffer.from("before"));
    const transactions = new FileSystemTransactions({
      repository,
      refStore: genesis.store,
      writerId: "test",
    });
    const file = await transactions.createFile({
      parentEntryIdHex: directory.entryId,
      name: "note.txt",
      content: before,
      expectedRevision: 2,
    });

    const exported = await service.createZipExport(instanceToken, {
      entryIds: [directory.entryId],
      expectedRevision: 3,
    });
    const after = await contentStore.putBytes(Buffer.from("after"));
    await transactions.setFileContent({
      entryIdHex: file.entryIdHex,
      expectedContentFidHex: before.fidHex,
      content: after,
    });
    const bytes = await collectBytes(exported.archive.stream);

    expect(exported).toMatchObject({
      fileName: "资料.zip",
      revision: 3,
      entryCount: 3,
    });
    expect(bytes.byteLength).toBe(exported.archive.size);
    expect(readStoredZip(bytes)).toEqual({
      "资料/": "",
      "资料/note.txt": "before",
      "资料/空目录/": "",
    });
    genesis.store.close();
  });

  it("creates an empty file and copies content without changing its FID", async () => {
    const { repository, genesis, service, instanceToken } = await setup();
    const empty = await service.createFile(instanceToken, {
      parentEntryId: genesis.rootEntryIdHex,
      name: "empty.txt",
      expectedRevision: 0,
    });
    const content = await new FileContentStore(repository).putBytes(
      new TextEncoder().encode("shared content"),
    );
    const source = await new FileSystemTransactions({
      repository,
      refStore: genesis.store,
      writerId: "test",
    }).createFile({
      parentEntryIdHex: genesis.rootEntryIdHex,
      name: "source.txt",
      content,
      expectedRevision: 1,
    });
    const copied = await service.copyFile(
      instanceToken,
      source.entryIdHex,
      {
        newParentEntryId: genesis.rootEntryIdHex,
        newName: "copy.txt",
        expectedRevision: 2,
      },
    );

    const index = await loadCurrentEntryIndex(repository, genesis.store);
    expect(index.get(empty.entryId)).toMatchObject({
      name: "empty.txt",
      content: { kind: "chunk", size: 0 },
    });
    expect(copied.entryId).not.toBe(source.entryIdHex);
    expect(index.get(copied.entryId)?.content).toEqual(content);
    expect(index.get(source.entryIdHex)?.content).toEqual(content);
    genesis.store.close();
  });

  it("creates, renames, moves and removes directories with stable Entry IDs", async () => {
    const { repository, genesis, service, instanceToken } = await setup();
    const documents = await service.createDirectory(instanceToken, {
      parentEntryId: genesis.rootEntryIdHex,
      name: "Documents",
      expectedRevision: 0,
    });
    const nested = await service.createDirectory(instanceToken, {
      parentEntryId: documents.entryId,
      name: "Drafts",
      expectedRevision: 1,
    });
    const moved = await service.moveEntry(instanceToken, nested.entryId, {
      newParentEntryId: genesis.rootEntryIdHex,
      newName: "Notes",
      expectedRevision: 2,
    });
    expect(moved).toEqual({ entryId: nested.entryId, revision: 3 });

    const removed = await service.removeEntry(
      instanceToken,
      documents.entryId,
      { recursive: false, expectedRevision: 3 },
    );
    expect(removed).toEqual({ entryId: documents.entryId, revision: 4 });

    const index = await loadCurrentEntryIndex(repository, genesis.store);
    expect(index.get(nested.entryId)).toMatchObject({
      entryIdHex: nested.entryId,
      parentEntryIdHex: genesis.rootEntryIdHex,
      name: "Notes",
    });
    expect(index.has(documents.entryId)).toBe(false);
    genesis.store.close();
  });

  it("rejects stale, unauthorized, duplicate, root and cyclic operations", async () => {
    const { genesis, capabilities, service, instanceToken } = await setup();
    const parent = await service.createDirectory(instanceToken, {
      parentEntryId: genesis.rootEntryIdHex,
      name: "Parent",
      expectedRevision: 0,
    });
    const child = await service.createDirectory(instanceToken, {
      parentEntryId: parent.entryId,
      name: "Child",
      expectedRevision: 1,
    });

    await expect(
      service.createDirectory(instanceToken, {
        parentEntryId: genesis.rootEntryIdHex,
        name: "Stale",
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "FILE_VERSION_CONFLICT" });
    await expect(
      service.createDirectory(instanceToken, {
        parentEntryId: genesis.rootEntryIdHex,
        name: "Parent",
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    await expect(
      service.moveEntry(instanceToken, parent.entryId, {
        newParentEntryId: child.entryId,
        newName: "Parent",
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    await expect(
      service.removeEntry(instanceToken, parent.entryId, {
        recursive: false,
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    await expect(
      service.copyFile(instanceToken, parent.entryId, {
        newParentEntryId: genesis.rootEntryIdHex,
        newName: "Parent copy",
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    await expect(
      service.removeEntry(instanceToken, genesis.rootEntryIdHex, {
        recursive: true,
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

    const otherToken = capabilities.createInstance(
      "io.example.notes",
      "notes-window",
    ).instanceToken;
    await expect(
      service.createDirectory(otherToken, {
        parentEntryId: genesis.rootEntryIdHex,
        name: "Forbidden",
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    genesis.store.close();
  });

  it("copies, moves and removes multiple entries with one revision each", async () => {
    const { repository, genesis, service, instanceToken } = await setup();
    const source = await service.createDirectory(instanceToken, {
      parentEntryId: genesis.rootEntryIdHex,
      name: "Source",
      expectedRevision: 0,
    });
    const destination = await service.createDirectory(instanceToken, {
      parentEntryId: genesis.rootEntryIdHex,
      name: "Destination",
      expectedRevision: 1,
    });
    const file = await service.createFile(instanceToken, {
      parentEntryId: source.entryId,
      name: "note.txt",
      expectedRevision: 2,
    });
    const nested = await service.createDirectory(instanceToken, {
      parentEntryId: source.entryId,
      name: "Nested",
      expectedRevision: 3,
    });
    const nestedFile = await service.createFile(instanceToken, {
      parentEntryId: nested.entryId,
      name: "deep.txt",
      expectedRevision: 4,
    });

    const copied = await service.copyEntries(instanceToken, {
      entryIds: [source.entryId, nestedFile.entryId],
      newParentEntryId: destination.entryId,
      expectedRevision: 5,
    });
    expect(copied.revision).toBe(6);
    expect(copied.entryIds).toHaveLength(1);
    let index = await loadCurrentEntryIndex(repository, genesis.store);
    const copiedRoot = index.get(copied.entryIds[0]);
    expect(copiedRoot).toMatchObject({
      name: "Source",
      kind: "directory",
      parentEntryIdHex: destination.entryId,
    });
    const copiedFile = index
      .listChildren(copiedRoot!.entryIdHex)
      .find((entry) => entry.name === "note.txt");
    const copiedNested = index
      .listChildren(copiedRoot!.entryIdHex)
      .find((entry) => entry.name === "Nested");
    expect(copiedFile?.content).toEqual(index.get(file.entryId)?.content);
    expect(
      index
        .listChildren(copiedNested!.entryIdHex)
        .some((entry) => entry.name === "deep.txt"),
    ).toBe(true);

    const moved = await service.moveEntries(instanceToken, {
      entryIds: [file.entryId, nested.entryId],
      newParentEntryId: destination.entryId,
      expectedRevision: 6,
    });
    expect(moved.revision).toBe(7);
    index = await loadCurrentEntryIndex(repository, genesis.store);
    expect(index.get(file.entryId)?.parentEntryIdHex).toBe(destination.entryId);
    expect(index.get(nested.entryId)?.parentEntryIdHex).toBe(
      destination.entryId,
    );

    const removed = await service.removeEntries(instanceToken, {
      entryIds: [copiedRoot!.entryIdHex, copiedNested!.entryIdHex],
      expectedRevision: 7,
    });
    expect(removed).toEqual({
      entryIds: [copiedRoot!.entryIdHex],
      revision: 8,
    });
    index = await loadCurrentEntryIndex(repository, genesis.store);
    expect(index.has(copiedRoot!.entryIdHex)).toBe(false);
    genesis.store.close();
  });
});

async function collectBytes(
  source: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function readStoredZip(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const eocd = bytes.byteLength - 22;
  const count = view.getUint16(eocd + 10, true);
  let central = view.getUint32(eocd + 16, true);
  const files: Record<string, string> = {};
  for (let index = 0; index < count; index += 1) {
    const size = view.getUint32(central + 24, true);
    const nameLength = view.getUint16(central + 28, true);
    const extraLength = view.getUint16(central + 30, true);
    const commentLength = view.getUint16(central + 32, true);
    const local = view.getUint32(central + 42, true);
    const name = decoder.decode(
      bytes.subarray(central + 46, central + 46 + nameLength),
    );
    const localNameLength = view.getUint16(local + 26, true);
    const localExtraLength = view.getUint16(local + 28, true);
    const contentStart = local + 30 + localNameLength + localExtraLength;
    files[name] = decoder.decode(
      bytes.subarray(contentStart, contentStart + size),
    );
    central += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
