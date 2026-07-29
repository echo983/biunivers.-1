import { describe, expect, it } from "vitest";
import { ImmutableObjectRepository, validatePersistenceSize } from "./immutableObjectRepository.js";
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
    const encoded = JSON.stringify(key);
    const previous = this.objects.get(encoded);
    if (previous) {
      return "already-exists-identical";
    }
    this.objects.set(encoded, Uint8Array.from(completeBytes));
    return "created";
  }

  async get(key: ObjectKey): Promise<Uint8Array> {
    const value = this.objects.get(JSON.stringify(key));
    if (!value) {
      throw new Error("missing");
    }
    return Uint8Array.from(value);
  }

  async head(key: ObjectKey): Promise<ObjectMetadata> {
    return { size: (await this.get(key)).byteLength };
  }

  async list(): Promise<ObjectListItem[]> {
    return [];
  }
}

describe("ImmutableObjectRepository", () => {
  it("computes the FID before create and verifies it after get", async () => {
    const store = new MemoryStore();
    const repository = new ImmutableObjectRepository(store, "users/alice");
    const bytes = Buffer.from("Biunivers");

    const persisted = await repository.put("chunks", bytes);
    expect(persisted).toMatchObject({
      key: {
        namespace: "users/alice",
        kind: "chunks",
        fidHex: "a4ff15b821d21370db519c84c1a8498c",
      },
      size: bytes.length,
      result: "created",
    });
    await expect(
      repository.get("chunks", persisted.key.fidHex),
    ).resolves.toEqual(Uint8Array.from(bytes));
  });

  it("rejects corrupted bytes returned by the object backend", async () => {
    const store = new MemoryStore();
    const repository = new ImmutableObjectRepository(store, "users/alice");
    const persisted = await repository.put("chunks", Buffer.from("original"));
    store.objects.set(JSON.stringify(persisted.key), Buffer.from("corrupted"));

    await expect(
      repository.get("chunks", persisted.key.fidHex),
    ).rejects.toMatchObject({ code: "OBJECT_INTEGRITY_FAILURE" });
  });

  it("uses incremental XXH3 for streamed chunk input", async () => {
    const repository = new ImmutableObjectRepository(
      new MemoryStore(),
      "users/alice",
    );
    async function* chunks() {
      yield Buffer.from("Biu");
      yield Buffer.from("nivers");
    }

    await expect(repository.putChunkStream(chunks())).resolves.toMatchObject({
      key: {
        kind: "chunks",
        fidHex: "a4ff15b821d21370db519c84c1a8498c",
      },
      size: 9,
      result: "created",
    });
  });

  it("enforces the fixed persistence size limits without allocating large buffers", () => {
    expect(() => validatePersistenceSize("chunks", 64 * 1024 * 1024)).not.toThrow();
    expect(() =>
      validatePersistenceSize("chunks", 64 * 1024 * 1024 + 1),
    ).toThrow();
    expect(() =>
      validatePersistenceSize("heads", 32 * 1024 * 1024 + 1),
    ).toThrow();
  });
});
