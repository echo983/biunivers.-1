// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
      { column: 2, row: 3 },
      initial.revision,
    );
    expect(added.revision).toBe(initial.revision + 1);
    expect(added.items[0]).toMatchObject({
      target: { type: "file", handle: "11".repeat(16) },
      position: { column: 2, row: 3 },
    });

    expect(() =>
      store.add(
        { type: "directory", handle: "22".repeat(16) },
        { column: 4, row: 5 },
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
});
