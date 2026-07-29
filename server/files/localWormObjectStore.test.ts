import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalWormObjectStore } from "./localWormObjectStore.js";
import { ObjectStoreError, type ObjectKey } from "./objectStore.js";

const roots: string[] = [];
const key: ObjectKey = {
  namespace: "users/alice",
  kind: "chunks",
  fidHex: "0123456789abcdef0123456789abcdef",
};

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "biunivers-worm-"));
  roots.push(root);
  return { root, store: new LocalWormObjectStore(root) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("LocalWormObjectStore", () => {
  it("publishes complete bytes and supports head, get, and diagnostic list", async () => {
    const { store } = await createStore();

    await expect(store.create(key, Buffer.from("immutable"))).resolves.toBe(
      "created",
    );
    await expect(store.head(key)).resolves.toEqual({ size: 9 });
    await expect(store.get(key)).resolves.toEqual(Buffer.from("immutable"));
    await expect(store.list("users/alice")).resolves.toEqual([
      { ...key, size: 9 },
    ]);
  });

  it("treats an identical retry as deduplication without replacing the object", async () => {
    const { store } = await createStore();
    await store.create(key, Buffer.from("same"));

    await expect(store.create(key, Buffer.from("same"))).resolves.toBe(
      "already-exists-identical",
    );
    await expect(store.get(key)).resolves.toEqual(Buffer.from("same"));
  });

  it("rejects same-FID bytes that differ in length or content", async () => {
    const { store } = await createStore();
    await store.create(key, Buffer.from("first"));

    for (const bytes of [Buffer.from("longer"), Buffer.from("other")]) {
      await expect(store.create(key, bytes)).rejects.toMatchObject({
        code: "FID_COLLISION",
      } satisfies Partial<ObjectStoreError>);
    }
    await expect(store.get(key)).resolves.toEqual(Buffer.from("first"));
  });

  it("allows exactly one winner when different bytes race for one key", async () => {
    const { store } = await createStore();
    const results = await Promise.allSettled([
      store.create(key, Buffer.from("alpha")),
      store.create(key, Buffer.from("bravo")),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(
      1,
    );
    const persisted = Buffer.from(await store.get(key)).toString();
    expect(["alpha", "bravo"]).toContain(persisted);
  });

  it("never exposes staging files through list and cleans them after publish", async () => {
    const { root, store } = await createStore();
    await store.create(key, Buffer.from("complete"));

    await expect(readdir(join(root, "staging"))).resolves.toEqual([]);
    await expect(store.list("users/alice", "chunks")).resolves.toHaveLength(1);
  });

  it("rejects traversal and reports missing objects with stable codes", async () => {
    const { store } = await createStore();
    await expect(
      store.get({ ...key, namespace: "../escape" }),
    ).rejects.toMatchObject({ code: "INVALID_OBJECT_KEY" });
    await expect(store.get(key)).rejects.toMatchObject({
      code: "OBJECT_NOT_FOUND",
    });
  });
});
