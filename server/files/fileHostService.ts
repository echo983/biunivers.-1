import {
  FileCapabilityError,
  FileCapabilityRegistry,
  type PublicFileHandle,
  type PublicFileTransfer,
} from "./fileCapabilityRegistry.js";
import {
  loadCurrentEntryIndex,
  type IndexedEntry,
} from "./entryIndex.js";
import type { ImmutableObjectRepository } from "./immutableObjectRepository.js";
import type { SqliteRefStore } from "./sqliteRefStore.js";

interface FileHostServiceOptions {
  repository: ImmutableObjectRepository;
  refStore: SqliteRefStore;
  capabilities: FileCapabilityRegistry;
  maxWriteBytes?: number;
}

export interface PublicFileEntry {
  entryId: string;
  name: string;
  kind: "directory" | "file";
  size?: number;
  mtimeMs: number;
}

export class FileHostService {
  readonly #repository: ImmutableObjectRepository;
  readonly #refStore: SqliteRefStore;
  readonly #capabilities: FileCapabilityRegistry;
  readonly #maxWriteBytes: number;

  constructor(options: FileHostServiceOptions) {
    this.#repository = options.repository;
    this.#refStore = options.refStore;
    this.#capabilities = options.capabilities;
    this.#maxWriteBytes = options.maxWriteBytes ?? 4 * 1024 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.#maxWriteBytes) ||
      this.#maxWriteBytes <= 0
    ) {
      throw new Error("Maximum write size must be a positive safe integer.");
    }
  }

  async listDirectory(instanceToken: string, parentEntryId?: string) {
    this.#capabilities.authorizeInstance(instanceToken);
    const index = await loadCurrentEntryIndex(
      this.#repository,
      this.#refStore,
    );
    const parentId = parentEntryId ?? index.rootEntryIdHex;
    const parent = index.get(parentId);
    if (!parent || parent.kind !== "directory") {
      throw new FileCapabilityError(
        "HANDLE_NOT_FOUND",
        "Directory not found.",
      );
    }
    return {
      revision: index.revision,
      rootEntryId: index.rootEntryIdHex,
      parent: publicEntry(parent),
      entries: index.listChildren(parentId).map(publicEntry),
    };
  }

  async issueHandle(
    instanceToken: string,
    entryId: string,
    writable: boolean,
  ): Promise<PublicFileHandle> {
    this.#capabilities.authorizeInstance(instanceToken);
    const index = await loadCurrentEntryIndex(
      this.#repository,
      this.#refStore,
    );
    const entry = index.get(entryId);
    if (!entry || entry.kind !== "file") {
      throw new FileCapabilityError("HANDLE_NOT_FOUND", "File not found.");
    }
    return this.#capabilities.issueHandle(
      instanceToken,
      entry,
      index.revision,
      writable,
    );
  }

  async getMetadata(instanceToken: string, handleId: string) {
    const handle = this.#capabilities.authorizeHandle(
      instanceToken,
      handleId,
    );
    const index = await loadCurrentEntryIndex(
      this.#repository,
      this.#refStore,
    );
    const entry = index.get(handle.entryIdHex);
    if (!entry || entry.kind !== "file") {
      throw new FileCapabilityError(
        "HANDLE_EXPIRED",
        "File no longer exists.",
      );
    }
    return {
      ...publicEntry(entry),
      revision: index.revision,
      writable: handle.writable,
      changed: entry.content?.fidHex !== handle.expectedContentFidHex,
    };
  }

  releaseHandle(instanceToken: string, handleId: string): void {
    this.#capabilities.releaseHandle(instanceToken, handleId);
  }

  issueTransfer(
    instanceToken: string,
    handleId: string,
    method: "GET" | "PUT",
  ): PublicFileTransfer {
    return this.#capabilities.issueTransfer(
      instanceToken,
      handleId,
      method,
      method === "PUT" ? this.#maxWriteBytes : 0,
    );
  }
}

function publicEntry(entry: IndexedEntry): PublicFileEntry {
  return {
    entryId: entry.entryIdHex,
    name: entry.name,
    kind: entry.kind,
    ...(entry.content ? { size: entry.content.size } : {}),
    mtimeMs: entry.mtimeMs,
  };
}
