import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCurrentEntryIndex } from "./entryIndex.js";
import { FileCapabilityRegistry } from "./fileCapabilityRegistry.js";
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
});
