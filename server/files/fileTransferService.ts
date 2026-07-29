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
      const entry = index.get(transfer.entryIdHex);
      if (
        !entry ||
        entry.kind !== "file" ||
        !entry.content ||
        entry.content.fidHex !== transfer.expectedContentFidHex
      ) {
        throw new FileCapabilityError(
          "HANDLE_EXPIRED",
          "File changed after this handle was issued.",
        );
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
        throw new FileCapabilityError(
          "HANDLE_EXPIRED",
          "File changed after this handle was issued.",
        );
      }
      const content = await this.#contentStore.putStream(
        source,
        transfer.maxBytes,
      );
      const published = await this.#transactions.setFileContent({
        entryIdHex: transfer.entryIdHex,
        expectedContentFidHex: transfer.expectedContentFidHex,
        content,
      });
      const after = await loadCurrentEntryIndex(
        this.#repository,
        this.#refStore,
      );
      const updated = after.get(transfer.entryIdHex);
      if (!updated || updated.kind !== "file") {
        throw new ObjectStoreError(
          "OBJECT_INTEGRITY_FAILURE",
          "Published file is missing from the current index.",
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
