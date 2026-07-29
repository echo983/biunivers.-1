import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
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

export class LocalWormObjectStore implements ImmutableObjectStore {
  readonly #objectsDirectory: string;
  readonly #stagingDirectory: string;

  constructor(rootDirectory: string) {
    this.#objectsDirectory = join(rootDirectory, "objects");
    this.#stagingDirectory = join(rootDirectory, "staging");
  }

  async create(
    key: ObjectKey,
    completeBytes: Uint8Array,
  ): Promise<CreateObjectResult> {
    validateObjectKey(key);
    const destination = this.#objectPath(key);
    const destinationDirectory = this.#kindDirectory(key.namespace, key.kind);
    await Promise.all([
      mkdir(destinationDirectory, { recursive: true }),
      mkdir(this.#stagingDirectory, { recursive: true }),
    ]);

    const stagingPath = join(this.#stagingDirectory, randomUUID());
    const handle = await open(stagingPath, "wx", 0o600);
    try {
      await handle.writeFile(completeBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await link(stagingPath, destination);
      return "created";
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
      return await this.#verifyExisting(destination, completeBytes);
    } finally {
      await unlink(stagingPath).catch((error: unknown) => {
        if (!isNodeError(error, "ENOENT")) {
          throw error;
        }
      });
    }
  }

  async get(key: ObjectKey): Promise<Uint8Array> {
    validateObjectKey(key);
    try {
      return await readFile(this.#objectPath(key));
    } catch (error) {
      throw mapNotFound(error, key);
    }
  }

  async getRange(
    key: ObjectKey,
    start: number,
    endInclusive: number,
    expectedSize: number,
  ): Promise<Uint8Array> {
    validateObjectKey(key);
    const handle = await open(this.#objectPath(key), "r").catch((error) => {
      throw mapNotFound(error, key);
    });
    try {
      const metadata = await handle.stat();
      if (metadata.size !== expectedSize) {
        throw new ObjectStoreError(
          "OBJECT_INTEGRITY_FAILURE",
          "Immutable object size does not match its expected size.",
        );
      }
      const result = new Uint8Array(endInclusive - start + 1);
      const { bytesRead } = await handle.read(result, 0, result.length, start);
      if (bytesRead !== result.length) {
        throw new ObjectStoreError(
          "OBJECT_INTEGRITY_FAILURE",
          "Immutable object range was truncated.",
        );
      }
      return result;
    } finally {
      await handle.close();
    }
  }

  async head(key: ObjectKey): Promise<ObjectMetadata> {
    validateObjectKey(key);
    try {
      const metadata = await stat(this.#objectPath(key));
      return { size: metadata.size };
    } catch (error) {
      throw mapNotFound(error, key);
    }
  }

  async list(namespace: string, kind?: ObjectKind): Promise<ObjectListItem[]> {
    validateNamespace(namespace);
    const kinds: ObjectKind[] = kind
      ? [kind]
      : ["heads", "segments", "checkpoints", "manifests", "chunks"];
    const items = await Promise.all(
      kinds.map(async (currentKind) => {
        const directory = this.#kindDirectory(namespace, currentKind);
        const entries = await readdir(directory).catch((error: unknown) => {
          if (isNodeError(error, "ENOENT")) {
            return [];
          }
          throw error;
        });
        return await Promise.all(
          entries
            .filter((fidHex) => /^[0-9a-f]{32}$/.test(fidHex))
            .map(async (fidHex) => {
              const metadata = await stat(join(directory, fidHex));
              return {
                namespace,
                kind: currentKind,
                fidHex,
                size: metadata.size,
              };
            }),
        );
      }),
    );
    return items.flat().sort(compareListItems);
  }

  async #verifyExisting(
    destination: string,
    completeBytes: Uint8Array,
  ): Promise<CreateObjectResult> {
    const existingMetadata = await stat(destination);
    if (existingMetadata.size !== completeBytes.byteLength) {
      throw collision();
    }
    const existingBytes = await readFile(destination);
    if (!existingBytes.equals(Buffer.from(completeBytes))) {
      throw collision();
    }
    return "already-exists-identical";
  }

  #kindDirectory(namespace: string, kind: ObjectKind): string {
    return join(this.#objectsDirectory, ...validateNamespace(namespace), kind);
  }

  #objectPath(key: ObjectKey): string {
    return join(this.#kindDirectory(key.namespace, key.kind), key.fidHex);
  }
}

function collision(): ObjectStoreError {
  return new ObjectStoreError(
    "FID_COLLISION",
    "An immutable object with this FID already exists with different bytes.",
  );
}

function mapNotFound(error: unknown, key: ObjectKey): never {
  if (isNodeError(error, "ENOENT")) {
    throw new ObjectStoreError(
      "OBJECT_NOT_FOUND",
      `Immutable ${key.kind} object was not found.`,
      { cause: error },
    );
  }
  throw error;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function compareListItems(left: ObjectListItem, right: ObjectListItem): number {
  return (
    left.kind.localeCompare(right.kind) || left.fidHex.localeCompare(right.fidHex)
  );
}
