import {
  FileCapabilityError,
  FileCapabilityRegistry,
} from "./fileCapabilityRegistry.js";
import { FileContentStore } from "./fileContentStore.js";
import { loadCurrentEntryIndex } from "./entryIndex.js";
import { FileSystemTransactions } from "./fileSystemTransactions.js";
import type { ImmutableObjectRepository } from "./immutableObjectRepository.js";
import { ObjectStoreError } from "./objectStore.js";
import type { SqliteRefStore } from "./sqliteRefStore.js";

interface FileTransferServiceOptions {
  repository: ImmutableObjectRepository;
  refStore: SqliteRefStore;
  writerId: string;
  capabilities: FileCapabilityRegistry;
}

export interface FileWriteResult {
  entryId: string;
  revision: number;
  size: number;
  mtimeMs: number;
}

export class FileTransferService {
  readonly #repository: ImmutableObjectRepository;
  readonly #refStore: SqliteRefStore;
  readonly #capabilities: FileCapabilityRegistry;
  readonly #contentStore: FileContentStore;
  readonly #transactions: FileSystemTransactions;

  constructor(options: FileTransferServiceOptions) {
    this.#repository = options.repository;
    this.#refStore = options.refStore;
    this.#capabilities = options.capabilities;
    this.#contentStore = new FileContentStore(options.repository);
    this.#transactions = new FileSystemTransactions({
      repository: options.repository,
      refStore: options.refStore,
      writerId: options.writerId,
    });
  }

  async read(
    instanceToken: string,
    transferId: string,
  ): Promise<{
    size: number;
    chunks: AsyncGenerator<Uint8Array>;
  }> {
    const transfer = this.#capabilities.beginTransfer(
      instanceToken,
      transferId,
      "GET",
    );
    try {
      const index = await loadCurrentEntryIndex(
        this.#repository,
        this.#refStore,
      );
      if (!transfer.entryIdHex) {
        throw new FileCapabilityError(
          "HANDLE_EXPIRED",
          "Pending files cannot be read before their first save.",
        );
      }
      const entry = index.get(transfer.entryIdHex);
      if (
        !entry ||
        entry.kind !== "file" ||
        !entry.content ||
        entry.content.fidHex !== transfer.expectedContentFidHex
      ) {
        throw versionConflict();
      }
      const source = this.#contentStore.readChunks(entry.content);
      return {
        size: entry.content.size,
        chunks: this.#completeAfter(source, instanceToken, transferId),
      };
    } catch (error) {
      this.#capabilities.finishTransfer(instanceToken, transferId);
      throw error;
    }
  }

  async write(
    instanceToken: string,
    transferId: string,
    source: AsyncIterable<Uint8Array>,
    contentLength?: number,
  ): Promise<FileWriteResult> {
    const transfer = this.#capabilities.beginTransfer(
      instanceToken,
      transferId,
      "PUT",
      contentLength,
    );
    try {
      const pending =
        transfer.pendingParentEntryIdHex && transfer.pendingName
          ? {
              parentEntryIdHex: transfer.pendingParentEntryIdHex,
              name: transfer.pendingName,
            }
          : null;
      if (!pending) {
        if (!transfer.entryIdHex) {
          throw new FileCapabilityError(
            "HANDLE_EXPIRED",
            "File handle is invalid.",
          );
        }
        const before = await loadCurrentEntryIndex(
          this.#repository,
          this.#refStore,
        );
        const entry = before.get(transfer.entryIdHex);
        if (
          !entry ||
          entry.kind !== "file" ||
          !entry.content ||
          entry.content.fidHex !== transfer.expectedContentFidHex
        ) {
          throw versionConflict();
        }
      }
      const content = await this.#contentStore.putStream(
        source,
        transfer.maxBytes,
      );
      const published = pending
        ? await this.#transactions.createFile({
            parentEntryIdHex: pending.parentEntryIdHex,
            name: pending.name,
            content,
          })
        : await this.#transactions.setFileContent({
            entryIdHex: transfer.entryIdHex!,
            expectedContentFidHex: transfer.expectedContentFidHex!,
            content,
          });
      const after = await loadCurrentEntryIndex(
        this.#repository,
        this.#refStore,
      );
      const updated = after.get(published.entryIdHex);
      if (!updated || updated.kind !== "file") {
        throw new ObjectStoreError(
          "OBJECT_INTEGRITY_FAILURE",
          "Published file is missing from the current index.",
        );
      }
      if (pending) {
        this.#capabilities.commitPendingFileHandle(
          instanceToken,
          transfer.handleId,
          updated,
          published.ref.revision,
        );
      }
      return {
        entryId: updated.entryIdHex,
        revision: published.ref.revision,
        size: content.size,
        mtimeMs: updated.mtimeMs,
      };
    } catch (error) {
      if (
        error instanceof ObjectStoreError &&
        error.code === "OBJECT_TOO_LARGE"
      ) {
        throw new FileCapabilityError(
          "TRANSFER_TOO_LARGE",
          "Transfer exceeds its byte limit.",
        );
      }
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "REF_CONFLICT"
      ) {
        throw versionConflict();
      }
      throw error;
    } finally {
      this.#capabilities.finishTransfer(instanceToken, transferId);
    }
  }

  async *#completeAfter(
    source: AsyncIterable<Uint8Array>,
    instanceToken: string,
    transferId: string,
  ): AsyncGenerator<Uint8Array> {
    try {
      yield* source;
    } finally {
      this.#capabilities.finishTransfer(instanceToken, transferId);
    }
  }
}

function versionConflict(): FileCapabilityError {
  return new FileCapabilityError(
    "FILE_VERSION_CONFLICT",
    "文件已被其他窗口修改，请重新打开后再保存。",
  );
}
