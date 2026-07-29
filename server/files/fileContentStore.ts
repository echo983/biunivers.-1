import {
  ImmutableObjectRepository,
  MAX_CHUNK_BYTES,
} from "./immutableObjectRepository.js";
import { ObjectStoreError } from "./objectStore.js";
import { loadPvlogCore, type PvlogCore } from "./pvlogCore.js";

export interface FileContentRef {
  kind: "chunk" | "manifest";
  fidHex: string;
  size: number;
}

export class FileContentStore {
  constructor(
    private readonly repository: ImmutableObjectRepository,
    private readonly core: PvlogCore = loadPvlogCore(),
  ) {}

  async putBytes(bytes: Uint8Array): Promise<FileContentRef> {
    if (!Number.isSafeInteger(bytes.byteLength)) {
      throw integrityFailure("File size exceeds the JavaScript safe integer range.");
    }
    if (bytes.byteLength <= MAX_CHUNK_BYTES) {
      const persisted = await this.repository.put("chunks", bytes);
      return {
        kind: "chunk",
        fidHex: persisted.key.fidHex,
        size: bytes.byteLength,
      };
    }

    const chunkFids: Buffer[] = [];
    const chunkLengths: bigint[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += MAX_CHUNK_BYTES) {
      const chunk = bytes.subarray(
        offset,
        Math.min(offset + MAX_CHUNK_BYTES, bytes.byteLength),
      );
      const persisted = await this.repository.put("chunks", chunk);
      chunkFids.push(Buffer.from(persisted.key.fidHex, "hex"));
      chunkLengths.push(BigInt(chunk.byteLength));
    }
    const manifestBytes = this.core.encodeManifest(
      BigInt(bytes.byteLength),
      Buffer.concat(chunkFids),
      BigUint64Array.from(chunkLengths),
    );
    this.core.validateManifest(manifestBytes);
    const manifest = await this.repository.put("manifests", manifestBytes);
    this.core.validateManifest(
      await this.repository.get("manifests", manifest.key.fidHex),
    );
    return {
      kind: "manifest",
      fidHex: manifest.key.fidHex,
      size: bytes.byteLength,
    };
  }

  async *readChunks(content: FileContentRef): AsyncGenerator<Uint8Array> {
    validateContentRef(content);
    if (content.kind === "chunk") {
      const bytes = await this.repository.get("chunks", content.fidHex);
      if (bytes.byteLength !== content.size) {
        throw integrityFailure("Chunk length does not match the file metadata.");
      }
      yield bytes;
      return;
    }

    const manifestBytes = await this.repository.get(
      "manifests",
      content.fidHex,
    );
    this.core.validateManifest(manifestBytes);
    const fileSize = this.core.manifestFileSize(manifestBytes);
    if (fileSize !== BigInt(content.size)) {
      throw integrityFailure("Manifest size does not match the file metadata.");
    }
    const fidBytes = this.core.manifestChunkFids(manifestBytes);
    const lengths = this.core.manifestChunkLengths(manifestBytes);
    if (fidBytes.byteLength !== lengths.length * 16) {
      throw integrityFailure("Manifest chunk arrays are inconsistent.");
    }

    let total = 0;
    for (let index = 0; index < lengths.length; index += 1) {
      const expectedLength = Number(lengths[index]);
      const fidHex = Buffer.from(
        fidBytes.subarray(index * 16, (index + 1) * 16),
      ).toString("hex");
      const chunk = await this.repository.get("chunks", fidHex);
      if (chunk.byteLength !== expectedLength) {
        throw integrityFailure("Chunk length does not match its Manifest.");
      }
      total += chunk.byteLength;
      yield chunk;
    }
    if (total !== content.size) {
      throw integrityFailure("Read chunks do not add up to the file size.");
    }
  }
}

function validateContentRef(content: FileContentRef): void {
  if (
    !/^[0-9a-f]{32}$/.test(content.fidHex) ||
    !Number.isSafeInteger(content.size) ||
    content.size < 0
  ) {
    throw integrityFailure("File content reference is invalid.");
  }
  if (content.kind === "chunk" && content.size > MAX_CHUNK_BYTES) {
    throw integrityFailure("A direct Chunk reference exceeds 64 MiB.");
  }
  if (content.kind === "manifest" && content.size <= MAX_CHUNK_BYTES) {
    throw integrityFailure("A Manifest reference must exceed 64 MiB.");
  }
}

function integrityFailure(message: string): ObjectStoreError {
  return new ObjectStoreError("OBJECT_INTEGRITY_FAILURE", message);
}
