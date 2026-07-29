import { describe, expect, it } from "vitest";
import { FileContentStore } from "./fileContentStore.js";
import {
  ImmutableObjectRepository,
  MAX_CHUNK_BYTES,
} from "./immutableObjectRepository.js";
import type {
  CreateObjectResult,
  ImmutableObjectStore,
  ObjectKey,
  ObjectListItem,
  ObjectMetadata,
} from "./objectStore.js";

class MemoryStore implements ImmutableObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly getKeys: ObjectKey[] = [];

  async create(
    key: ObjectKey,
    completeBytes: Uint8Array,
  ): Promise<CreateObjectResult> {
    this.objects.set(JSON.stringify(key), completeBytes);
    return "created";
  }

  async get(key: ObjectKey): Promise<Uint8Array> {
    this.getKeys.push(key);
    const bytes = this.objects.get(JSON.stringify(key));
    if (!bytes) {
      throw new Error("missing");
    }
    return bytes;
  }

  async head(key: ObjectKey): Promise<ObjectMetadata> {
    return { size: (await this.get(key)).byteLength };
  }

  async list(): Promise<ObjectListItem[]> {
    return [];
  }
}

function createContentStore() {
  const objectStore = new MemoryStore();
  const repository = new ImmutableObjectRepository(
    objectStore,
    "users/alice",
  );
  return { contentStore: new FileContentStore(repository), objectStore };
}

describe("FileContentStore", () => {
  it("stores files up to and including 64 MiB as one direct Chunk", async () => {
    const { contentStore } = createContentStore();
    const bytes = new Uint8Array(MAX_CHUNK_BYTES);
    bytes[0] = 1;
    bytes[bytes.length - 1] = 2;

    const content = await contentStore.putBytes(bytes);
    expect(content).toMatchObject({ kind: "chunk", size: MAX_CHUNK_BYTES });
    const chunks = [];
    for await (const chunk of contentStore.readChunks(content)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(bytes);
  });

  it("splits a file over 64 MiB and reads its verified Manifest chunks", async () => {
    const { contentStore, objectStore } = createContentStore();
    const bytes = new Uint8Array(MAX_CHUNK_BYTES + 1);
    bytes[0] = 3;
    bytes[bytes.length - 1] = 4;

    const content = await contentStore.putBytes(bytes);
    expect(content).toMatchObject({
      kind: "manifest",
      size: MAX_CHUNK_BYTES + 1,
    });
    expect(
      [...objectStore.objects.keys()].filter((key) => key.includes("chunks")),
    ).toHaveLength(2);
    expect(
      [...objectStore.objects.keys()].filter((key) => key.includes("manifests")),
    ).toHaveLength(1);

    const lengths = [];
    const boundaryValues = [];
    for await (const chunk of contentStore.readChunks(content)) {
      lengths.push(chunk.byteLength);
      boundaryValues.push(chunk[0], chunk[chunk.length - 1]);
    }
    expect(lengths).toEqual([MAX_CHUNK_BYTES, 1]);
    expect(boundaryValues).toEqual([3, 0, 4, 4]);
  });

  it("rejects file metadata that conflicts with immutable content", async () => {
    const { contentStore } = createContentStore();
    const content = await contentStore.putBytes(Buffer.from("notes"));

    const iterator = contentStore.readChunks({ ...content, size: 4 });
    await expect(iterator.next()).rejects.toMatchObject({
      code: "OBJECT_INTEGRITY_FAILURE",
    });
  });

  it("streams irregular input into fixed chunks without buffering the file", async () => {
    const { contentStore, objectStore } = createContentStore();
    const bytes = new Uint8Array(MAX_CHUNK_BYTES + 3);
    bytes[0] = 5;
    bytes[MAX_CHUNK_BYTES - 1] = 6;
    bytes[MAX_CHUNK_BYTES] = 7;
    bytes[bytes.length - 1] = 8;
    async function* source() {
      yield bytes.subarray(0, 17);
      yield bytes.subarray(17, MAX_CHUNK_BYTES);
      yield bytes.subarray(MAX_CHUNK_BYTES);
    }

    const content = await contentStore.putStream(
      source(),
      MAX_CHUNK_BYTES + 3,
    );
    expect(content).toMatchObject({
      kind: "manifest",
      size: MAX_CHUNK_BYTES + 3,
    });
    expect(
      [...objectStore.objects.keys()].filter((key) => key.includes("chunks")),
    ).toHaveLength(2);
    const chunks = [];
    for await (const chunk of contentStore.readChunks(content)) {
      chunks.push(chunk);
    }
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([
      MAX_CHUNK_BYTES,
      3,
    ]);
    expect(chunks[0][0]).toBe(5);
    expect(chunks[0][MAX_CHUNK_BYTES - 1]).toBe(6);
    expect([...chunks[1]]).toEqual([7, 0, 8]);
  });

  it("keeps an exact 64 MiB stream as one Chunk and enforces maxBytes", async () => {
    const { contentStore } = createContentStore();
    async function* exactBoundary() {
      yield new Uint8Array(MAX_CHUNK_BYTES);
    }
    await expect(
      contentStore.putStream(exactBoundary(), MAX_CHUNK_BYTES),
    ).resolves.toMatchObject({
      kind: "chunk",
      size: MAX_CHUNK_BYTES,
    });

    async function* tooLarge() {
      yield Uint8Array.from([1, 2, 3, 4]);
    }
    await expect(contentStore.putStream(tooLarge(), 3)).rejects.toMatchObject({
      code: "OBJECT_TOO_LARGE",
    });
  });

  it("reads an exact range from a direct Chunk", async () => {
    const { contentStore } = createContentStore();
    const content = await contentStore.putBytes(
      Uint8Array.from([0, 1, 2, 3, 4, 5]),
    );
    const parts = [];
    for await (const part of contentStore.readRange(content, 2, 4)) {
      parts.push(...part);
    }
    expect(parts).toEqual([2, 3, 4]);
  });

  it("reads only Manifest chunks intersecting a cross-boundary range", async () => {
    const { contentStore, objectStore } = createContentStore();
    const bytes = new Uint8Array(MAX_CHUNK_BYTES + 4);
    bytes[MAX_CHUNK_BYTES - 2] = 10;
    bytes[MAX_CHUNK_BYTES - 1] = 11;
    bytes[MAX_CHUNK_BYTES] = 12;
    bytes[MAX_CHUNK_BYTES + 1] = 13;
    const content = await contentStore.putBytes(bytes);
    objectStore.getKeys.length = 0;

    const parts = [];
    for await (const part of contentStore.readRange(
      content,
      MAX_CHUNK_BYTES - 2,
      MAX_CHUNK_BYTES + 1,
    )) {
      parts.push(...part);
    }

    expect(parts).toEqual([10, 11, 12, 13]);
    expect(objectStore.getKeys.map((key) => key.kind)).toEqual([
      "manifests",
      "chunks",
      "chunks",
    ]);
  });

  it("skips unrelated Manifest chunks for a tail range", async () => {
    const { contentStore, objectStore } = createContentStore();
    const bytes = new Uint8Array(MAX_CHUNK_BYTES + 3);
    bytes[MAX_CHUNK_BYTES + 1] = 21;
    bytes[MAX_CHUNK_BYTES + 2] = 22;
    const content = await contentStore.putBytes(bytes);
    objectStore.getKeys.length = 0;

    const parts = [];
    for await (const part of contentStore.readRange(
      content,
      MAX_CHUNK_BYTES + 1,
      MAX_CHUNK_BYTES + 2,
    )) {
      parts.push(...part);
    }

    expect(parts).toEqual([21, 22]);
    expect(objectStore.getKeys.map((key) => key.kind)).toEqual([
      "manifests",
      "chunks",
    ]);
  });

  it("rejects ranges outside the content snapshot", async () => {
    const { contentStore } = createContentStore();
    const content = await contentStore.putBytes(Uint8Array.from([1, 2, 3]));
    await expect(
      contentStore.readRange(content, 1, 3).next(),
    ).rejects.toMatchObject({ code: "OBJECT_INVALID" });
  });
});
