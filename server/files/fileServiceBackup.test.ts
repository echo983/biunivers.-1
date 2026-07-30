import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCurrentEntryIndex } from "./entryIndex.js";
import { FileContentStore } from "./fileContentStore.js";
import { FileServiceBackup } from "./fileServiceBackup.js";
import { FileSystemTransactions } from "./fileSystemTransactions.js";
import { initializeGenesisFileSystem } from "./genesisFileSystem.js";
import { ImmutableObjectRepository } from "./immutableObjectRepository.js";
import { LocalWormObjectStore } from "./localWormObjectStore.js";
import { SqliteRefStore } from "./sqliteRefStore.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("FileServiceBackup", () => {
  it("creates and independently validates a point-in-time RefStore backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "biunivers-backup-"));
    roots.push(root);
    const repository = new ImmutableObjectRepository(
      new LocalWormObjectStore(join(root, "objects")),
      "users/alice",
    );
    const livePath = join(root, "live", "file-service.sqlite");
    const backupPath = join(root, "backups", "latest.sqlite");
    const genesis = await initializeGenesisFileSystem({
      databasePath: livePath,
      repository,
      writerId: "test",
    });
    const content = await new FileContentStore(repository).putBytes(
      Buffer.from("revision one"),
    );
    await new FileSystemTransactions({
      refId: "main",
      repository,
      refStore: genesis.store,
      writerId: "test",
    }).createFile({
      parentEntryIdHex: genesis.rootEntryIdHex,
      name: "note.txt",
      content,
    });

    const service = new FileServiceBackup({
      repository,
      refStore: genesis.store,
      backupPath,
      now: () => new Date("2026-07-29T12:00:00.000Z"),
    });
    await expect(service.createLatest()).resolves.toMatchObject({
      createdAt: "2026-07-29T12:00:00.000Z",
      revision: 1,
      rootEntryIdHex: genesis.rootEntryIdHex,
      fileName: "latest.sqlite",
    });

    const laterContent = await new FileContentStore(repository).putBytes(
      Buffer.from("revision two"),
    );
    await new FileSystemTransactions({
      refId: "main",
      repository,
      refStore: genesis.store,
      writerId: "test",
    }).createFile({
      parentEntryIdHex: genesis.rootEntryIdHex,
      name: "later.txt",
      content: laterContent,
    });

    const backup = await SqliteRefStore.openExisting(backupPath);
    await expect(loadCurrentEntryIndex(repository, backup, "main")).resolves.toMatchObject({
      revision: 1,
      rootEntryIdHex: genesis.rootEntryIdHex,
    });
    backup.close();
    genesis.store.close();
  });
});
