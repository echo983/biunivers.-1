import type { FileContentRef } from "../files/fileContentStore.js";
import type { ImmutableObjectRepository } from "../files/immutableObjectRepository.js";
import { loadPvlogCore, type PvlogCore } from "../files/pvlogCore.js";
import { ObjectStoreError } from "../files/objectStore.js";
import { VerifiedChunkCache } from "./verifiedChunkCache.js";

const DEFAULT_MAX_READ_BYTES = 1024 * 1024;

export class WorkspaceContentReader {
  readonly #repository: ImmutableObjectRepository;
  readonly #cache: VerifiedChunkCache;
  readonly #core: PvlogCore;
  readonly #maximumReadBytes: number;

  constructor(options: {
    repository: ImmutableObjectRepository;
    cache: VerifiedChunkCache;
    core?: PvlogCore;
    maximumReadBytes?: number;
  }) {
    this.#repository = options.repository;
    this.#cache = options.cache;
    this.#core = options.core ?? loadPvlogCore();
    this.#maximumReadBytes =
      options.maximumReadBytes ?? DEFAULT_MAX_READ_BYTES;
    if (
      !Number.isSafeInteger(this.#maximumReadBytes) ||
      this.#maximumReadBytes < 1
    ) {
      throw new Error("Workspace content read limit is invalid.");
    }
  }

  async read(
    content: FileContentRef,
    offset: number,
    size: number,
  ): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 0 ||
      size > this.#maximumReadBytes
    ) {
      throw invalid("Workspace content read is invalid.");
    }
    if (size === 0 || offset >= content.size) return new Uint8Array();
    const endExclusive = Math.min(content.size, offset + size);
    if (content.kind === "chunk") {
      return await this.#cache.readRange(
        content.fidHex,
        content.size,
        offset,
        endExclusive - 1,
      );
    }

    const manifestBytes = await this.#repository.get(
      "manifests",
      content.fidHex,
    );
    this.#core.validateManifest(manifestBytes);
    const fileSize = Number(this.#core.manifestFileSize(manifestBytes));
    if (fileSize !== content.size) {
      throw integrityFailure(
        "Manifest file size does not match the Workspace Entry.",
      );
    }
    const fids = this.#core.manifestChunkFids(manifestBytes);
    const lengths = this.#core.manifestChunkLengths(manifestBytes);
    if (fids.byteLength !== lengths.length * 16) {
      throw integrityFailure("Manifest Chunk projection is inconsistent.");
    }
    const parts: Uint8Array[] = [];
    let chunkStart = 0;
    for (let index = 0; index < lengths.length; index += 1) {
      const length = Number(lengths[index]);
      const chunkEnd = chunkStart + length;
      if (chunkEnd > offset && chunkStart < endExclusive) {
        const localStart = Math.max(0, offset - chunkStart);
        const localEnd = Math.min(length, endExclusive - chunkStart) - 1;
        const fidHex = Buffer.from(
          fids.subarray(index * 16, (index + 1) * 16),
        ).toString("hex");
        parts.push(
          await this.#cache.readRange(
            fidHex,
            length,
            localStart,
            localEnd,
          ),
        );
      }
      chunkStart = chunkEnd;
      if (chunkStart >= endExclusive) break;
    }
    const output = Buffer.concat(parts.map((part) => Buffer.from(part)));
    if (output.byteLength !== endExclusive - offset) {
      throw integrityFailure("Manifest read returned an incomplete range.");
    }
    return output;
  }
}

function invalid(message: string): ObjectStoreError {
  return new ObjectStoreError("OBJECT_INVALID", message);
}

function integrityFailure(message: string): ObjectStoreError {
  return new ObjectStoreError("OBJECT_INTEGRITY_FAILURE", message);
}
