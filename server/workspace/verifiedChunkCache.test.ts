import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ImmutableObjectRepository } from "../files/immutableObjectRepository.js";
import type {
  CreateObjectResult,
  ImmutableObjectStore,
  ObjectKey,
  ObjectListItem,
  ObjectMetadata,
} from "../files/objectStore.js";
import { VerifiedChunkCache } from "./verifiedChunkCache.js";

const roots: string[] = [];

class MemoryStore implements ImmutableObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  getCalls = 0;

  async create(
    key: ObjectKey,
    completeBytes: Uint8Array,
  ): Promise<CreateObjectResult> {
    const encoded = JSON.stringify(key);
    const existing = this.objects.get(encoded);
    if (existing) return "already-exists-identical";
    this.objects.set(encoded, Uint8Array.from(completeBytes));
    return "created";
  }

  async get(key: ObjectKey): Promise<Uint8Array> {
    this.getCalls += 1;
    const bytes = this.objects.get(JSON.stringify(key));
    if (!bytes) throw new Error("missing");
    await Promise.resolve();
    return Uint8Array.from(bytes);
  }

  async head(key: ObjectKey): Promise<ObjectMetadata> {
    return { size: (await this.get(key)).byteLength };
  }

  async list(): Promise<ObjectListItem[]> {
    return [];
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "biunivers-chunk-cache-"));
  roots.push(root);
  const store = new MemoryStore();
  const repository = new ImmutableObjectRepository(store, "users/alice");
  return { root, store, repository, directory: join(root, "cache") };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("VerifiedChunkCache", () => {
  it("downloads once, coalesces concurrent misses, and serves exact ranges", async () => {
    const setupResult = await setup();
    const bytes = Buffer.from("verified chunk contents");
    const object = await setupResult.repository.put("chunks", bytes);
    const cache = new VerifiedChunkCache(setupResult);

    const [first, second] = await Promise.all([
      cache.get(object.key.fidHex, bytes.length),
      cache.get(object.key.fidHex, bytes.length),
    ]);
    expect(first).toBe(second);
    expect(setupResult.store.getCalls).toBe(1);
    expect(
      Buffer.from(
        await cache.readRange(object.key.fidHex, bytes.length, 9, 13),
      ).toString(),
    ).toBe("chunk");
    expect(setupResult.store.getCalls).toBe(1);
    expect(cache.metrics()).toMatchObject({
      misses: 1,
      hits: 1,
      downloadedBytes: bytes.length,
    });
  });

  it("rehashes cache files after restart and repairs same-size corruption", async () => {
    const setupResult = await setup();
    const bytes = Buffer.from("persistent verified chunk");
    const object = await setupResult.repository.put("chunks", bytes);
    const first = new VerifiedChunkCache(setupResult);
    const path = await first.get(object.key.fidHex, bytes.length);
    expect(setupResult.store.getCalls).toBe(1);

    const restarted = new VerifiedChunkCache(setupResult);
    await restarted.get(object.key.fidHex, bytes.length);
    expect(setupResult.store.getCalls).toBe(1);
    expect(restarted.metrics().verifiedBytes).toBe(bytes.length);

    await writeFile(path, Buffer.alloc(bytes.length, 0x78));
    const repairing = new VerifiedChunkCache(setupResult);
    await repairing.get(object.key.fidHex, bytes.length);
    expect(setupResult.store.getCalls).toBe(2);
    expect(repairing.metrics().corruptions).toBe(1);
    expect(
      Buffer.from(
        await repairing.readRange(
          object.key.fidHex,
          bytes.length,
          0,
          bytes.length - 1,
        ),
      ),
    ).toEqual(bytes);
  });

  it("evicts least-recently-used verified Chunks above capacity", async () => {
    const setupResult = await setup();
    const chunkBytes = 33 * 1024 * 1024;
    const firstBytes = Buffer.alloc(chunkBytes, 0x11);
    const secondBytes = Buffer.alloc(chunkBytes, 0x22);
    const first = await setupResult.repository.put("chunks", firstBytes);
    const second = await setupResult.repository.put("chunks", secondBytes);
    let now = 100;
    const cache = new VerifiedChunkCache({
      ...setupResult,
      maximumBytes: 64 * 1024 * 1024,
      now: () => now++,
    });

    await cache.get(first.key.fidHex, chunkBytes);
    await cache.get(second.key.fidHex, chunkBytes);
    expect(cache.metrics()).toMatchObject({
      evictions: 1,
      evictedBytes: chunkBytes,
    });
    await cache.get(first.key.fidHex, chunkBytes);
    expect(setupResult.store.getCalls).toBe(3);
  });
});
