import {
  FileCapabilityError,
  type FileCapabilityRegistry,
} from "./fileCapabilityRegistry.js";
import { loadCurrentEntryIndex, type EntryIndex } from "./entryIndex.js";
import { validateEntryName } from "./entryName.js";
import { FileSystemTransactions } from "./fileSystemTransactions.js";
import type { ImmutableObjectRepository } from "./immutableObjectRepository.js";
import {
  RefStoreError,
  type SqliteRefStore,
} from "./sqliteRefStore.js";

const INTERNAL_FILE_APP_ID = "system.files";

interface InternalFileManagerServiceOptions {
  repository: ImmutableObjectRepository;
  refStore: SqliteRefStore;
  capabilities: FileCapabilityRegistry;
  writerId: string;
  transactions?: FileSystemTransactions;
}

export interface InternalFileMutationResult {
  entryId: string;
  revision: number;
}

export class InternalFileManagerService {
  readonly #repository: ImmutableObjectRepository;
  readonly #refStore: SqliteRefStore;
  readonly #capabilities: FileCapabilityRegistry;
  readonly #transactions: FileSystemTransactions;

  constructor(options: InternalFileManagerServiceOptions) {
    this.#repository = options.repository;
    this.#refStore = options.refStore;
    this.#capabilities = options.capabilities;
    this.#transactions =
      options.transactions ??
      new FileSystemTransactions({
        repository: options.repository,
        refStore: options.refStore,
        writerId: options.writerId,
      });
  }

  async createDirectory(
    instanceToken: string,
    input: {
      parentEntryId: string;
      name: string;
      expectedRevision: number;
    },
  ): Promise<InternalFileMutationResult> {
    this.#authorize(instanceToken);
    validateEntryName(input.name);
    const index = await this.#loadExpected(input.expectedRevision);
    const parent = index.get(input.parentEntryId);
    if (!parent || parent.kind !== "directory") {
      throw notFound("Parent directory was not found.");
    }
    requireUniqueName(index, parent.entryIdHex, input.name);
    return await this.#publish(() =>
      this.#transactions.createDirectory({
        parentEntryIdHex: parent.entryIdHex,
        name: input.name,
        expectedRevision: input.expectedRevision,
      }),
    );
  }

  async moveEntry(
    instanceToken: string,
    entryId: string,
    input: {
      newParentEntryId: string;
      newName: string;
      expectedRevision: number;
    },
  ): Promise<InternalFileMutationResult> {
    this.#authorize(instanceToken);
    validateEntryName(input.newName);
    const index = await this.#loadExpected(input.expectedRevision);
    const entry = index.get(entryId);
    if (!entry) {
      throw notFound("Entry was not found.");
    }
    if (entry.parentEntryIdHex === null) {
      throw denied("The root directory cannot be moved or renamed.");
    }
    const parent = index.get(input.newParentEntryId);
    if (!parent || parent.kind !== "directory") {
      throw notFound("Destination directory was not found.");
    }
    if (
      entry.parentEntryIdHex === parent.entryIdHex &&
      entry.name === input.newName
    ) {
      throw invalid("The entry already has this name and parent.");
    }
    requireUniqueName(index, parent.entryIdHex, input.newName, entryId);
    requireAcyclicMove(index, entryId, parent.entryIdHex);
    return await this.#publish(() =>
      this.#transactions.moveEntry({
        entryIdHex: entryId,
        newParentEntryIdHex: parent.entryIdHex,
        newName: input.newName,
        expectedRevision: input.expectedRevision,
      }),
    );
  }

  async removeEntry(
    instanceToken: string,
    entryId: string,
    input: {
      recursive: boolean;
      expectedRevision: number;
    },
  ): Promise<InternalFileMutationResult> {
    this.#authorize(instanceToken);
    const index = await this.#loadExpected(input.expectedRevision);
    const entry = index.get(entryId);
    if (!entry) {
      throw notFound("Entry was not found.");
    }
    if (entry.parentEntryIdHex === null) {
      throw denied("The root directory cannot be removed.");
    }
    if (
      entry.kind === "directory" &&
      !input.recursive &&
      index.listChildren(entry.entryIdHex).length > 0
    ) {
      throw invalid("A non-empty directory requires recursive removal.");
    }
    return await this.#publish(() =>
      this.#transactions.removeEntry({
        entryIdHex: entry.entryIdHex,
        recursive: input.recursive,
        expectedRevision: input.expectedRevision,
      }),
    );
  }

  #authorize(instanceToken: string): void {
    const identity = this.#capabilities.authorizeInstance(instanceToken);
    if (identity.appId !== INTERNAL_FILE_APP_ID) {
      throw denied("This file operation is restricted to the file manager.");
    }
  }

  async #loadExpected(expectedRevision: number): Promise<EntryIndex> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw invalid("Expected revision is invalid.");
    }
    const index = await loadCurrentEntryIndex(
      this.#repository,
      this.#refStore,
    );
    if (index.revision !== expectedRevision) {
      throw conflict();
    }
    return index;
  }

  async #publish(
    operation: () => ReturnType<FileSystemTransactions["createDirectory"]>,
  ): Promise<InternalFileMutationResult> {
    try {
      const published = await operation();
      return {
        entryId: published.entryIdHex,
        revision: published.ref.revision,
      };
    } catch (error) {
      if (error instanceof RefStoreError && error.code === "REF_CONFLICT") {
        throw conflict();
      }
      throw error;
    }
  }
}

function requireUniqueName(
  index: EntryIndex,
  parentEntryId: string,
  name: string,
  ignoredEntryId?: string,
): void {
  if (
    index
      .listChildren(parentEntryId)
      .some(
        (entry) =>
          entry.entryIdHex !== ignoredEntryId && entry.name === name,
      )
  ) {
    throw invalid("An entry with this name already exists.");
  }
}

function requireAcyclicMove(
  index: EntryIndex,
  entryId: string,
  parentEntryId: string,
): void {
  let current = index.get(parentEntryId);
  while (current) {
    if (current.entryIdHex === entryId) {
      throw invalid("A directory cannot be moved into itself or a descendant.");
    }
    current =
      current.parentEntryIdHex === null
        ? undefined
        : index.get(current.parentEntryIdHex);
  }
}

function invalid(message: string): FileCapabilityError {
  return new FileCapabilityError("REQUEST_INVALID", message);
}

function notFound(message: string): FileCapabilityError {
  return new FileCapabilityError("HANDLE_NOT_FOUND", message);
}

function denied(message: string): FileCapabilityError {
  return new FileCapabilityError("PERMISSION_DENIED", message);
}

function conflict(): FileCapabilityError {
  return new FileCapabilityError(
    "FILE_VERSION_CONFLICT",
    "The file system changed; refresh and try again.",
  );
}
