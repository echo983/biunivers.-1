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

  async create(
    key: ObjectKey,
    completeBytes: Uint8Array,
  ): Promise<CreateObjectResult> {
    this.objects.set(JSON.stringify(key), completeBytes);
    return "created";
  }

  async get(key: ObjectKey): Promise<Uint8Array> {
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
});
