import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RefStoreError,
  SqliteRefStore,
  type FilesystemRef,
} from "./sqliteRefStore.js";

const roots: string[] = [];
const initial: FilesystemRef = {
  refId: "main",
  lineageIdHex: "10101010101010101010101010101010",
  headFidHex: "20202020202020202020202020202020",
  revision: 0,
  updatedAtMs: 1_785_320_000_000,
};

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "biunivers-refstore-"));
  roots.push(root);
  return join(root, "file-service.sqlite");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("SqliteRefStore", () => {
  it("requires explicit first-time initialization and refuses reinitialization", async () => {
    const path = await databasePath();
    await expect(SqliteRefStore.openExisting(path)).rejects.toMatchObject({
      code: "REFSTORE_MISSING",
    });

    const store = await SqliteRefStore.initialize(path);
    store.close();
    await expect(SqliteRefStore.initialize(path)).rejects.toMatchObject({
      code: "REF_ALREADY_EXISTS",
    });
  });

  it("persists refs across clean close and restart", async () => {
    const path = await databasePath();
    const store = await SqliteRefStore.initialize(path);
    expect(store.createRef(initial)).toEqual(initial);
    store.close();

    const reopened = await SqliteRefStore.openExisting(path);
    expect(reopened.getRef("main")).toEqual(initial);
    reopened.close();
  });

  it("publishes with exact head and revision CAS and never overwrites a winner", async () => {
    const path = await databasePath();
    const store = await SqliteRefStore.initialize(path);
    store.createRef(initial);
    const winner = {
      refId: "main",
      expectedHeadFidHex: initial.headFidHex,
      expectedRevision: 0,
      newHeadFidHex: "30303030303030303030303030303030",
      newRevision: 1,
      updatedAtMs: initial.updatedAtMs + 1,
    };

    expect(store.compareAndSwap(winner)).toMatchObject({
      headFidHex: winner.newHeadFidHex,
      revision: 1,
    });
    expect(() =>
      store.compareAndSwap({
        ...winner,
        newHeadFidHex: "40404040404040404040404040404040",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "REF_CONFLICT" }) as RefStoreError,
    );
    expect(store.getRef("main").headFidHex).toBe(winner.newHeadFidHex);
    store.close();
  });

  it("allows only one winner across independent database connections", async () => {
    const path = await databasePath();
    const first = await SqliteRefStore.initialize(path);
    first.createRef(initial);
    const second = await SqliteRefStore.openExisting(path);
    const candidate = {
      refId: "main",
      expectedHeadFidHex: initial.headFidHex,
      expectedRevision: 0,
      newHeadFidHex: "30303030303030303030303030303030",
      newRevision: 1,
      updatedAtMs: initial.updatedAtMs + 1,
    };

    expect(first.compareAndSwap(candidate).headFidHex).toBe(
      candidate.newHeadFidHex,
    );
    expect(() =>
      second.compareAndSwap({
        ...candidate,
        newHeadFidHex: "40404040404040404040404040404040",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "REF_CONFLICT" }) as RefStoreError,
    );
    expect(second.getRef("main").headFidHex).toBe(candidate.newHeadFidHex);
    second.close();
    first.close();
  });

  it("rejects revision gaps before entering the publication transaction", async () => {
    const path = await databasePath();
    const store = await SqliteRefStore.initialize(path);
    store.createRef(initial);

    expect(() =>
      store.compareAndSwap({
        refId: "main",
        expectedHeadFidHex: initial.headFidHex,
        expectedRevision: 0,
        newHeadFidHex: "30303030303030303030303030303030",
        newRevision: 2,
        updatedAtMs: initial.updatedAtMs + 1,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_REF_VALUE" }) as RefStoreError,
    );
    expect(store.getRef("main")).toEqual(initial);
    store.close();
  });

  it("only snapshots the current Ref value and enforces unique names", async () => {
    const path = await databasePath();
    const store = await SqliteRefStore.initialize(path);
    store.createRef(initial);
    const snapshot = store.createSnapshot({
      snapshotIdHex: "50505050505050505050505050505050",
      refId: "main",
      name: "before-edit",
      headFidHex: initial.headFidHex,
      revision: initial.revision,
      createdAtMs: initial.updatedAtMs,
      pinned: true,
    });

    expect(store.listSnapshots("main")).toEqual([snapshot]);
    expect(() =>
      store.createSnapshot({
        ...snapshot,
        snapshotIdHex: "60606060606060606060606060606060",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "SNAPSHOT_ALREADY_EXISTS",
      }) as RefStoreError,
    );
    store.close();
  });

  it("creates a consistent validated backup that restores an earlier Ref", async () => {
    const path = await databasePath();
    const backupPath = join(join(path, ".."), "backups", "refstore.sqlite");
    const store = await SqliteRefStore.initialize(path);
    store.createRef(initial);
    await store.backupTo(backupPath);
    store.compareAndSwap({
      refId: "main",
      expectedHeadFidHex: initial.headFidHex,
      expectedRevision: 0,
      newHeadFidHex: "30303030303030303030303030303030",
      newRevision: 1,
      updatedAtMs: initial.updatedAtMs + 1,
    });
    store.close();

    const restored = await SqliteRefStore.openExisting(backupPath);
    expect(restored.getRef("main")).toEqual(initial);
    restored.close();
  });

  it("refuses a corrupt or unrelated database instead of silently recreating state", async () => {
    const path = await databasePath();
    await writeFile(path, "not a sqlite database");

    await expect(SqliteRefStore.openExisting(path)).rejects.toMatchObject({
      code: "REFSTORE_CORRUPT",
    });
  });
});
