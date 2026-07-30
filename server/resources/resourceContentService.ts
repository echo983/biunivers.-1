import { FileContentStore } from "../files/fileContentStore.js";
import { loadCurrentEntryIndex } from "../files/entryIndex.js";
import { FileSystemTransactions } from "../files/fileSystemTransactions.js";
import type { ImmutableObjectRepository } from "../files/immutableObjectRepository.js";
import { ObjectStoreError } from "../files/objectStore.js";
import {
  type SqliteRefStore,
  RefStoreError,
} from "../files/sqliteRefStore.js";
import {
  ByteRangeError,
  parseSingleByteRange,
  type ByteRange,
} from "./byteRange.js";
import {
  ResourceSessionError,
  ResourceSessionRegistry,
  type ResourceSessionUse,
} from "./resourceSessionRegistry.js";

interface ResourceContentServiceOptions {
  repository: ImmutableObjectRepository;
  refStore: SqliteRefStore;
  writerId: string;
  sessions: ResourceSessionRegistry;
  maxWriteBytes?: number;
}

export interface ResourceReadResult {
  status: 200 | 206;
  size: number;
  contentLength: number;
  mediaType: string;
  range: ByteRange | null;
  chunks: AsyncGenerator<Uint8Array>;
}

export interface ResourceWriteResult {
  sessionId: string;
  revision: number;
  size: number;
  mtimeMs: number;
  contentVersion: string;
  expiresAt: string;
}

export class ResourceContentService {
  readonly #repository: ImmutableObjectRepository;
  readonly #refStore: SqliteRefStore;
  readonly #writerId: string;
  readonly #sessions: ResourceSessionRegistry;
  readonly #contentStore: FileContentStore;
  readonly #maxWriteBytes: number;

  constructor(options: ResourceContentServiceOptions) {
    this.#repository = options.repository;
    this.#refStore = options.refStore;
    this.#writerId = options.writerId;
    this.#sessions = options.sessions;
    this.#contentStore = new FileContentStore(options.repository);
    this.#maxWriteBytes = options.maxWriteBytes ?? 4 * 1024 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.#maxWriteBytes) ||
      this.#maxWriteBytes <= 0
    ) {
      throw new Error("Maximum resource write size must be positive.");
    }
  }

  async read(
    appId: string,
    sessionId: string,
    rangeHeader?: string,
  ): Promise<ResourceReadResult> {
    const use = this.#sessions.beginUse(appId, sessionId, "read");
    try {
      if (!use.content) {
        throw new ResourceSessionError(
          "RESOURCE_ACCESS_DENIED",
          "Pending resources cannot be read before their first save.",
        );
      }
      const range = parseSingleByteRange(rangeHeader, use.content.size);
      const source = range
        ? this.#contentStore.readRange(
            use.content,
            range.start,
            range.endInclusive,
          )
        : this.#contentStore.readChunks(use.content);
      return {
        status: range ? 206 : 200,
        size: use.content.size,
        contentLength: range?.length ?? use.content.size,
        mediaType: use.metadata.mediaType,
        range,
        chunks: this.#completeRead(source, use),
      };
    } catch (error) {
      this.#sessions.finishUse(use, false);
      throw error;
    }
  }

  async write(
    appId: string,
    sessionId: string,
    source: AsyncIterable<Uint8Array>,
    contentLength?: number,
  ): Promise<ResourceWriteResult> {
    if (
      contentLength !== undefined &&
      (!Number.isSafeInteger(contentLength) ||
        contentLength < 0 ||
        contentLength > this.#maxWriteBytes)
    ) {
      throw new ResourceSessionError(
        "RESOURCE_TRANSFER_TOO_LARGE",
        "Resource write exceeds its byte limit.",
      );
    }
    const use = this.#sessions.beginUse(appId, sessionId, "edit");
    let successful = false;
    try {
      const pending =
        use.pendingParentEntryIdHex && use.pendingName
          ? {
              parentEntryIdHex: use.pendingParentEntryIdHex,
              name: use.pendingName,
            }
          : null;
      if (!pending) {
        if (!use.entryIdHex || !use.expectedContentFidHex) {
          throw new ResourceSessionError(
            "RESOURCE_SESSION_NOT_FOUND",
            "Resource session does not contain a writable file.",
          );
        }
        const before = await loadCurrentEntryIndex(
          this.#repository,
          this.#refStore,
          "main",
        );
        const entry = before.get(use.entryIdHex);
        if (
          !entry ||
          entry.kind !== "file" ||
          entry.content?.fidHex !== use.expectedContentFidHex
        ) {
          throw conflict();
        }
      }

      const content = await this.#contentStore.putStream(
        abortable(source, use.signal),
        this.#maxWriteBytes,
      );
      assertNotRevoked(use.signal);
      const transactions = new FileSystemTransactions({
        refId: "main",
        repository: this.#repository,
        refStore: this.#refStore,
        writerId: this.#writerId,
        beforePublish: async () => assertNotRevoked(use.signal),
      });
      const published = pending
        ? await transactions.createFile({
            parentEntryIdHex: pending.parentEntryIdHex,
            name: pending.name,
            content,
            expectedRevision: use.issuedAtRevision,
          })
        : await transactions.setFileContent({
            entryIdHex: use.entryIdHex!,
            expectedContentFidHex: use.expectedContentFidHex!,
            content,
          });
      const after = await loadCurrentEntryIndex(
        this.#repository,
        this.#refStore,
        "main",
      );
      const updated = after.get(published.entryIdHex);
      if (!updated || updated.kind !== "file" || !updated.content) {
        throw new ObjectStoreError(
          "OBJECT_INTEGRITY_FAILURE",
          "Published resource is missing from the current index.",
        );
      }
      const session = this.#sessions.advanceAfterSave(
        appId,
        sessionId,
        updated,
        published.ref.revision,
      );
      successful = true;
      return {
        sessionId,
        revision: published.ref.revision,
        size: updated.content.size,
        mtimeMs: updated.mtimeMs,
        contentVersion: session.metadata.contentVersion,
        expiresAt: session.expiresAt,
      };
    } catch (error) {
      throw mapWriteError(error);
    } finally {
      this.#sessions.finishUse(use, successful);
    }
  }

  async *#completeRead(
    source: AsyncIterable<Uint8Array>,
    use: ResourceSessionUse,
  ): AsyncGenerator<Uint8Array> {
    let successful = false;
    try {
      for await (const chunk of source) {
        assertNotRevoked(use.signal);
        yield chunk;
      }
      successful = true;
    } finally {
      this.#sessions.finishUse(use, successful);
    }
  }
}

async function* abortable(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of source) {
    assertNotRevoked(signal);
    yield chunk;
  }
}

function assertNotRevoked(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ResourceSessionError(
      "RESOURCE_SESSION_REVOKED",
      "Resource session was revoked.",
    );
  }
}

function mapWriteError(error: unknown): unknown {
  if (
    error instanceof ResourceSessionError ||
    error instanceof ByteRangeError
  ) {
    return error;
  }
  if (
    error instanceof ObjectStoreError &&
    error.code === "OBJECT_TOO_LARGE"
  ) {
    return new ResourceSessionError(
      "RESOURCE_TRANSFER_TOO_LARGE",
      "Resource write exceeds its byte limit.",
    );
  }
  if (
    (error instanceof RefStoreError && error.code === "REF_CONFLICT") ||
    (error instanceof Error &&
      "code" in error &&
      error.code === "REF_CONFLICT")
  ) {
    return conflict();
  }
  return error;
}

function conflict(): ResourceSessionError {
  return new ResourceSessionError(
    "FILE_VERSION_CONFLICT",
    "File changed before the resource session could save it.",
  );
}
