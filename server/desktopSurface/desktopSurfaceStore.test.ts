// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  DesktopSurfaceError,
  DesktopSurfaceStore,
} from "./desktopSurfaceStore.js";

const directories: string[] = [];
const stores: DesktopSurfaceStore[] = [];

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "desktop-surface-"));
  directories.push(directory);
  const store = await DesktopSurfaceStore.open(
    join(directory, "desktop-surface.sqlite"),
  );
  stores.push(store);
  return store;
}

afterEach(async () => {
  stores.splice(0).forEach((store) => store.close());
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DesktopSurfaceStore", () => {
  it("initializes the legacy desktop app projection exactly once", async () => {
    const store = await createStore();
    const first = store.initialize([
      { type: "app", handle: "system.files" },
      { type: "app", handle: "system.about" },
    ]);
    expect(first.revision).toBe(1);
    expect(first.items.map((item) => item.target.handle)).toEqual([
      "system.files",
      "system.about",
    ]);

    const second = store.initialize([
      { type: "app", handle: "example.should-not-appear" },
    ]);
    expect(second).toEqual(first);
  });

  it("adds and removes references with revision CAS", async () => {
    const store = await createStore();
    const initial = store.initialize([]);
    const added = store.add(
      { type: "file", handle: "11".repeat(16) },
      { x: 212, y: 312 },
      initial.revision,
    );
    expect(added.revision).toBe(initial.revision + 1);
    expect(added.items[0]).toMatchObject({
      target: { type: "file", handle: "11".repeat(16) },
      position: { x: 212, y: 312 },
    });

    expect(() =>
      store.add(
        { type: "directory", handle: "22".repeat(16) },
        { x: 424, y: 520 },
        initial.revision,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "DESKTOP_SURFACE_CONFLICT" }),
    );

    const removed = store.remove([added.items[0].id], added.revision);
    expect(removed.items).toEqual([]);
  });

  it("moves a selected group atomically and supports position swaps", async () => {
    const store = await createStore();
    const initial = store.initialize([
      { type: "app", handle: "system.files" },
      { type: "app", handle: "system.about" },
    ]);
    const [first, second] = initial.items;
    const moved = store.move(
      [
        { itemId: first.id, position: second.position },
        { itemId: second.id, position: first.position },
      ],
      initial.revision,
    );
    expect(moved.items.find((item) => item.id === first.id)?.position).toEqual(
      second.position,
    );
    expect(moved.items.find((item) => item.id === second.id)?.position).toEqual(
      first.position,
    );
  });

  it("rolls back the whole mutation when one item is invalid", async () => {
    const store = await createStore();
    const initial = store.initialize([
      { type: "app", handle: "system.files" },
    ]);
    expect(() =>
      store.remove(
        [initial.items[0].id, "ff".repeat(16)],
        initial.revision,
      ),
    ).toThrow(DesktopSurfaceError);
    expect(store.read()).toEqual(initial);
  });

  it("migrates legacy grid coordinates to logical pixels", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-surface-"));
    directories.push(directory);
    const databasePath = join(directory, "desktop-surface.sqlite");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE desktop_surface (
        singleton INTEGER PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        initialized INTEGER NOT NULL
      );
      INSERT INTO desktop_surface VALUES (1, 1, 7, 1);
      CREATE TABLE desktop_items (
        id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL,
        target_handle TEXT NOT NULL,
        column_index INTEGER NOT NULL,
        row_index INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        UNIQUE (target_type, target_handle),
        UNIQUE (column_index, row_index)
      );
      INSERT INTO desktop_items VALUES (
        '${"11".repeat(16)}',
        'app',
        'system.files',
        3,
        2,
        1
      );
    `);
    legacy.close();

    const store = await DesktopSurfaceStore.open(databasePath);
    stores.push(store);
    expect(store.read()).toMatchObject({
      revision: 7,
      items: [{ position: { x: 318, y: 208 } }],
    });
  });
});
