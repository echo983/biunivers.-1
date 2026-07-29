import { createXXHash128, xxhash128 } from "hash-wasm";
import {
  ObjectStoreError,
  type CreateObjectResult,
  type ImmutableObjectStore,
  type ObjectKey,
  type ObjectKind,
  type ObjectListItem,
} from "./objectStore.js";

export const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
export const MAX_METADATA_OBJECT_BYTES = 32 * 1024 * 1024;

export interface PersistedObject {
  key: ObjectKey;
  size: number;
  result: CreateObjectResult;
}

export class ImmutableObjectRepository {
  constructor(
    private readonly store: ImmutableObjectStore,
    private readonly namespace: string,
  ) {}

  async put(kind: ObjectKind, completeBytes: Uint8Array): Promise<PersistedObject> {
    validatePersistenceSize(kind, completeBytes.byteLength);
    const fidHex = await xxhash128(completeBytes, 0, 0);
    const key: ObjectKey = { namespace: this.namespace, kind, fidHex };
    const result = await this.store.create(key, completeBytes);
    return { key, size: completeBytes.byteLength, result };
  }

  async get(kind: ObjectKind, fidHex: string): Promise<Uint8Array> {
    const key: ObjectKey = { namespace: this.namespace, kind, fidHex };
    const bytes = await this.store.get(key);
    validatePersistenceSize(kind, bytes.byteLength);
    const actualFid = await xxhash128(bytes, 0, 0);
    if (actualFid !== fidHex) {
      throw new ObjectStoreError(
        "OBJECT_INTEGRITY_FAILURE",
        "Immutable object bytes do not match their requested FID.",
      );
    }
    return bytes;
  }

  async list(kind?: ObjectKind): Promise<ObjectListItem[]> {
    return await this.store.list(this.namespace, kind);
  }

  async putChunkStream(
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<PersistedObject> {
    const hasher = await createXXHash128(0, 0);
    const parts: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of chunks) {
      size += chunk.byteLength;
      validatePersistenceSize("chunks", size);
      hasher.update(chunk);
      parts.push(chunk);
    }
    const bytes = Buffer.concat(parts.map((part) => Buffer.from(part)), size);
    const fidHex = hasher.digest("hex");
    const key: ObjectKey = {
      namespace: this.namespace,
      kind: "chunks",
      fidHex,
    };
    const result = await this.store.create(key, bytes);
    return { key, size, result };
  }
}

export function validatePersistenceSize(kind: ObjectKind, size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new ObjectStoreError(
      "INVALID_OBJECT_KEY",
      "Immutable object size is invalid.",
    );
  }
  const maximum =
    kind === "chunks" ? MAX_CHUNK_BYTES : MAX_METADATA_OBJECT_BYTES;
  if (size > maximum) {
    throw new ObjectStoreError(
      "INVALID_OBJECT_KEY",
      `Immutable ${kind} object exceeds its ${maximum}-byte limit.`,
    );
  }
}
