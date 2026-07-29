import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  ObjectStoreError,
  type CreateObjectResult,
  type ImmutableObjectStore,
  type ObjectKey,
  type ObjectKind,
  type ObjectListItem,
  type ObjectMetadata,
  validateNamespace,
  validateObjectKey,
} from "./objectStore.js";

export interface S3WormObjectStoreOptions {
  bucket: string;
  client: S3Client;
  keyPrefix?: string;
}

export class S3WormObjectStore implements ImmutableObjectStore {
  readonly #bucket: string;
  readonly #client: S3Client;
  readonly #keyPrefix: string;

  constructor(options: S3WormObjectStoreOptions) {
    if (!options.bucket.trim()) {
      throw new Error("S3 bucket must not be empty.");
    }
    this.#bucket = options.bucket;
    this.#client = options.client;
    this.#keyPrefix = normalizeKeyPrefix(options.keyPrefix);
  }

  async create(
    key: ObjectKey,
    completeBytes: Uint8Array,
  ): Promise<CreateObjectResult> {
    validateObjectKey(key);
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: this.#objectKey(key),
          Body: completeBytes,
          ContentLength: completeBytes.byteLength,
          IfNoneMatch: "*",
        }),
      );
      return "created";
    } catch (error) {
      if (!isPreconditionFailure(error)) {
        throw error;
      }
    }

    const existing = await this.get(key);
    if (
      existing.byteLength !== completeBytes.byteLength ||
      !Buffer.from(existing).equals(Buffer.from(completeBytes))
    ) {
      throw new ObjectStoreError(
        "FID_COLLISION",
        "An immutable object with this FID already exists with different bytes.",
      );
    }
    return "already-exists-identical";
  }

  async get(key: ObjectKey): Promise<Uint8Array> {
    validateObjectKey(key);
    try {
      const response = await this.#client.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: this.#objectKey(key),
        }),
      );
      if (!response.Body) {
        throw new Error("S3 returned an object without a response body.");
      }
      return await response.Body.transformToByteArray();
    } catch (error) {
      throw mapNotFound(error, key);
    }
  }

  async head(key: ObjectKey): Promise<ObjectMetadata> {
    validateObjectKey(key);
    try {
      const response = await this.#client.send(
        new HeadObjectCommand({
          Bucket: this.#bucket,
          Key: this.#objectKey(key),
        }),
      );
      if (response.ContentLength === undefined) {
        throw new Error("S3 returned object metadata without ContentLength.");
      }
      return { size: response.ContentLength };
    } catch (error) {
      throw mapNotFound(error, key);
    }
  }

  async list(namespace: string, kind?: ObjectKind): Promise<ObjectListItem[]> {
    validateNamespace(namespace);
    const kinds: ObjectKind[] = kind
      ? [kind]
      : ["heads", "segments", "checkpoints", "manifests", "chunks"];
    const result: ObjectListItem[] = [];

    for (const currentKind of kinds) {
      const prefix = this.#kindPrefix(namespace, currentKind);
      let continuationToken: string | undefined;
      do {
        const response = await this.#client.send(
          new ListObjectsV2Command({
            Bucket: this.#bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );
        for (const object of response.Contents ?? []) {
          const fidHex = object.Key?.slice(prefix.length);
          if (
            !fidHex ||
            !/^[0-9a-f]{2}\/[0-9a-f]{32}$/.test(fidHex) ||
            fidHex.slice(0, 2) !== fidHex.slice(3, 5) ||
            object.Size === undefined
          ) {
            continue;
          }
          result.push({
            namespace,
            kind: currentKind,
            fidHex: fidHex.slice(3),
            size: object.Size,
          });
        }
        continuationToken = response.IsTruncated
          ? response.NextContinuationToken
          : undefined;
        if (response.IsTruncated && !continuationToken) {
          throw new Error("S3 truncated a list response without a continuation token.");
        }
      } while (continuationToken);
    }

    return result.sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.fidHex.localeCompare(right.fidHex),
    );
  }

  #objectKey(key: ObjectKey): string {
    return `${this.#kindPrefix(key.namespace, key.kind)}${key.fidHex.slice(0, 2)}/${key.fidHex}`;
  }

  #kindPrefix(namespace: string, kind: ObjectKind): string {
    return `${this.#keyPrefix}${namespace}/objects/${kind}/xxh3-128/`;
  }
}

function normalizeKeyPrefix(prefix = ""): string {
  const trimmed = prefix.replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/` : "";
}

function isPreconditionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const metadata =
    "$metadata" in error &&
    typeof error.$metadata === "object" &&
    error.$metadata !== null &&
    "httpStatusCode" in error.$metadata
      ? error.$metadata.httpStatusCode
      : undefined;
  return (
    error.name === "PreconditionFailed" ||
    error.name === "ConditionalRequestConflict" ||
    metadata === 412
  );
}

function mapNotFound(error: unknown, key: ObjectKey): never {
  if (isNotFound(error)) {
    throw new ObjectStoreError(
      "OBJECT_NOT_FOUND",
      `Immutable ${key.kind} object was not found.`,
      { cause: error },
    );
  }
  throw error;
}

function isNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const metadata =
    "$metadata" in error &&
    typeof error.$metadata === "object" &&
    error.$metadata !== null &&
    "httpStatusCode" in error.$metadata
      ? error.$metadata.httpStatusCode
      : undefined;
  return error.name === "NoSuchKey" || error.name === "NotFound" || metadata === 404;
}
