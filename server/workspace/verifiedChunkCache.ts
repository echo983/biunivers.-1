import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { join } from "node:path";
import { createXXHash128 } from "hash-wasm";
import {
  MAX_CHUNK_BYTES,
  type ImmutableObjectRepository,
} from "../files/immutableObjectRepository.js";
import { ObjectStoreError } from "../files/objectStore.js";

const FID_PATTERN = /^[0-9a-f]{32}$/;

export interface VerifiedChunkCacheMetrics {
  hits: number;
  misses: number;
  downloadedBytes: number;
  verifiedBytes: number;
  corruptions: number;
  evictions: number;
  evictedBytes: number;
}

interface CacheRecord {
  size: number;
  mtimeMs: number;
  lastAccessMs: number;
}

export class VerifiedChunkCache {
  readonly #directory: string;
  readonly #repository: ImmutableObjectRepository;
  readonly #maximumBytes: number;
  readonly #now: () => number;
  readonly #inflight = new Map<string, Promise<string>>();
  readonly #verified = new Map<string, CacheRecord>();
  readonly #metrics: VerifiedChunkCacheMetrics = {
    hits: 0,
    misses: 0,
    downloadedBytes: 0,
    verifiedBytes: 0,
    corruptions: 0,
    evictions: 0,
    evictedBytes: 0,
  };

  constructor(options: {
    directory: string;
    repository: ImmutableObjectRepository;
    maximumBytes?: number;
    now?: () => number;
  }) {
    this.#directory = options.directory;
    this.#repository = options.repository;
    this.#maximumBytes = options.maximumBytes ?? 8 * 1024 * 1024 * 1024;
    this.#now = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.#maximumBytes) ||
      this.#maximumBytes < MAX_CHUNK_BYTES
    ) {
      throw new Error("Verified Chunk Cache capacity is invalid.");
    }
  }

  metrics(): VerifiedChunkCacheMetrics {
    return { ...this.#metrics };
  }

  async get(fidHex: string, expectedLength: number): Promise<string> {
    validateChunkIdentity(fidHex, expectedLength);
    const existing = this.#inflight.get(fidHex);
    if (existing) return await existing;
    const promise = this.#getOrPopulate(fidHex, expectedLength).finally(() => {
      this.#inflight.delete(fidHex);
    });
    this.#inflight.set(fidHex, promise);
    return await promise;
  }

  async readRange(
    fidHex: string,
    expectedLength: number,
    start: number,
    endInclusive: number,
  ): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(endInclusive) ||
      start < 0 ||
      endInclusive < start ||
      endInclusive >= expectedLength
    ) {
      throw invalid("Chunk cache read range is invalid.");
    }
    const path = await this.get(fidHex, expectedLength);
    const handle = await open(path, "r");
    try {
      const output = Buffer.allocUnsafe(endInclusive - start + 1);
      const { bytesRead } = await handle.read(
        output,
        0,
        output.byteLength,
        start,
      );
      if (bytesRead !== output.byteLength) {
        this.#verified.delete(fidHex);
        await rm(path, { force: true });
        throw integrityFailure("Verified Chunk cache file was truncated.");
      }
      return output;
    } finally {
      await handle.close();
    }
  }

  async #getOrPopulate(
    fidHex: string,
    expectedLength: number,
  ): Promise<string> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const path = this.#path(fidHex);
    if (await this.#validateExisting(path, fidHex, expectedLength)) {
      this.#metrics.hits += 1;
      return path;
    }
    this.#metrics.misses += 1;
    const bytes = await this.#repository.get("chunks", fidHex);
    this.#metrics.downloadedBytes += bytes.byteLength;
    if (bytes.byteLength !== expectedLength) {
      throw integrityFailure("Downloaded Chunk length does not match Manifest.");
    }
    const temporaryPath = join(
      this.#directory,
      `.${fidHex}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      if (!(await this.#validateExisting(path, fidHex, expectedLength))) {
        throw error;
      }
    }
    const metadata = await stat(path);
    this.#verified.set(fidHex, {
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      lastAccessMs: this.#now(),
    });
    await this.#evict();
    return path;
  }

  async #validateExisting(
    path: string,
    fidHex: string,
    expectedLength: number,
  ): Promise<boolean> {
    let metadata;
    try {
      metadata = await stat(path);
    } catch {
      this.#verified.delete(fidHex);
      return false;
    }
    if (!metadata.isFile() || metadata.size !== expectedLength) {
      this.#metrics.corruptions += 1;
      this.#verified.delete(fidHex);
      await rm(path, { force: true });
      return false;
    }
    const known = this.#verified.get(fidHex);
    if (
      !known ||
      known.size !== metadata.size ||
      known.mtimeMs !== metadata.mtimeMs
    ) {
      const actualFidHex = await hashFile(path);
      this.#metrics.verifiedBytes += metadata.size;
      if (actualFidHex !== fidHex) {
        this.#metrics.corruptions += 1;
        this.#verified.delete(fidHex);
        await rm(path, { force: true });
        return false;
      }
    }
    const accessedAt = this.#now();
    await utimes(path, metadata.atime, new Date(accessedAt));
    this.#verified.set(fidHex, {
      size: metadata.size,
      mtimeMs: accessedAt,
      lastAccessMs: accessedAt,
    });
    return true;
  }

  async #evict(): Promise<void> {
    const entries = await readdir(this.#directory, { withFileTypes: true });
    const candidates: Array<{
      fidHex: string;
      path: string;
      size: number;
      lastAccessMs: number;
    }> = [];
    let total = 0;
    for (const entry of entries) {
      const match = entry.isFile() && entry.name.match(/^([0-9a-f]{32})\.chunk$/);
      if (!match) continue;
      const path = join(this.#directory, entry.name);
      const metadata = await stat(path);
      total += metadata.size;
      candidates.push({
        fidHex: match[1],
        path,
        size: metadata.size,
        lastAccessMs:
          this.#verified.get(match[1])?.lastAccessMs ?? metadata.mtimeMs,
      });
    }
    candidates.sort(
      (left, right) =>
        left.lastAccessMs - right.lastAccessMs ||
        left.fidHex.localeCompare(right.fidHex),
    );
    for (const candidate of candidates) {
      if (total <= this.#maximumBytes) break;
      if (this.#inflight.has(candidate.fidHex)) continue;
      await rm(candidate.path, { force: true });
      this.#verified.delete(candidate.fidHex);
      total -= candidate.size;
      this.#metrics.evictions += 1;
      this.#metrics.evictedBytes += candidate.size;
    }
  }

  #path(fidHex: string): string {
    return join(this.#directory, `${fidHex}.chunk`);
  }
}

async function hashFile(path: string): Promise<string> {
  const hasher = await createXXHash128(0, 0);
  for await (const chunk of createReadStream(path)) {
    hasher.update(chunk as Buffer);
  }
  return hasher.digest("hex");
}

function validateChunkIdentity(fidHex: string, expectedLength: number): void {
  if (
    !FID_PATTERN.test(fidHex) ||
    !Number.isSafeInteger(expectedLength) ||
    expectedLength < 0 ||
    expectedLength > MAX_CHUNK_BYTES
  ) {
    throw invalid("Chunk identity or expected length is invalid.");
  }
}

function invalid(message: string): ObjectStoreError {
  return new ObjectStoreError("OBJECT_INVALID", message);
}

function integrityFailure(message: string): ObjectStoreError {
  return new ObjectStoreError("OBJECT_INTEGRITY_FAILURE", message);
}
