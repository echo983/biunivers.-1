import {
  FileCapabilityError,
  type FileCapabilityRegistry,
} from "./fileCapabilityRegistry.js";
import { loadCurrentEntryIndex, type EntryIndex } from "./entryIndex.js";
import { validateEntryName } from "./entryName.js";
import { FileSystemTransactions } from "./fileSystemTransactions.js";
import { FileContentStore } from "./fileContentStore.js";
import type { ImmutableObjectRepository } from "./immutableObjectRepository.js";
import {
  RefStoreError,
  type SqliteRefStore,
} from "./sqliteRefStore.js";
import { randomBytes } from "node:crypto";

const INTERNAL_FILE_APP_ID = "system.files";

interface InternalFileManagerServiceOptions {
  repository: ImmutableObjectRepository;
  refStore: SqliteRefStore;
  capabilities: FileCapabilityRegistry;
  writerId: string;
  transactions?: FileSystemTransactions;
  randomId?: () => Uint8Array;
}

export interface InternalFileMutationResult {
  entryId: string;
  revision: number;
}

export interface InternalBatchMutationResult {
  entryIds: string[];
  revision: number;
}

export class InternalFileManagerService {
  readonly #repository: ImmutableObjectRepository;
  readonly #refStore: SqliteRefStore;
  readonly #capabilities: FileCapabilityRegistry;
  readonly #contentStore: FileContentStore;
  readonly #transactions: FileSystemTransactions;
  readonly #randomId: () => Uint8Array;

  constructor(options: InternalFileManagerServiceOptions) {
    this.#repository = options.repository;
    this.#refStore = options.refStore;
    this.#capabilities = options.capabilities;
    this.#contentStore = new FileContentStore(options.repository);
    this.#transactions =
      options.transactions ??
      new FileSystemTransactions({
        repository: options.repository,
        refStore: options.refStore,
        writerId: options.writerId,
      });
    this.#randomId = options.randomId ?? (() => randomBytes(16));
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

  async createFile(
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
    const content = await this.#contentStore.putBytes(new Uint8Array());
    return await this.#publish(() =>
      this.#transactions.createFile({
        parentEntryIdHex: parent.entryIdHex,
        name: input.name,
        content,
        expectedRevision: input.expectedRevision,
      }),
    );
  }

  async copyFile(
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
    const source = index.get(entryId);
    if (!source) {
      throw notFound("Source file was not found.");
    }
    if (source.kind !== "file" || !source.content) {
      throw invalid("Only files can be copied.");
    }
    const content = source.content;
    const parent = index.get(input.newParentEntryId);
    if (!parent || parent.kind !== "directory") {
      throw notFound("Destination directory was not found.");
    }
    requireUniqueName(index, parent.entryIdHex, input.newName);
    return await this.#publish(() =>
      this.#transactions.createFile({
        parentEntryIdHex: parent.entryIdHex,
        name: input.newName,
        content,
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

  async moveEntries(
    instanceToken: string,
    input: {
      entryIds: string[];
      newParentEntryId: string;
      expectedRevision: number;
    },
  ): Promise<InternalBatchMutationResult> {
    this.#authorize(instanceToken);
    const index = await this.#loadExpected(input.expectedRevision);
    const entries = normalizeTopLevelEntries(index, input.entryIds);
    const parent = requireDirectory(index, input.newParentEntryId);
    requireBatchNamesAvailable(index, entries, parent.entryIdHex, true);
    for (const entry of entries) {
      if (entry.parentEntryIdHex === parent.entryIdHex) {
        throw invalid("An entry is already in the destination directory.");
      }
      requireAcyclicMove(index, entry.entryIdHex, parent.entryIdHex);
    }
    return await this.#publishBatch(
      entries.map((entry) => ({
        kind: "move" as const,
        entryIdHex: entry.entryIdHex,
        newParentEntryIdHex: parent.entryIdHex,
        newName: entry.name,
      })),
      input.expectedRevision,
      entries.map((entry) => entry.entryIdHex),
    );
  }

  async copyEntries(
    instanceToken: string,
    input: {
      entryIds: string[];
      newParentEntryId: string;
      expectedRevision: number;
    },
  ): Promise<InternalBatchMutationResult> {
    this.#authorize(instanceToken);
    const index = await this.#loadExpected(input.expectedRevision);
    const entries = normalizeTopLevelEntries(index, input.entryIds);
    const parent = requireDirectory(index, input.newParentEntryId);
    requireBatchNamesAvailable(index, entries, parent.entryIdHex, false);
    for (const entry of entries) {
      if (entry.kind === "directory") {
        requireAcyclicMove(index, entry.entryIdHex, parent.entryIdHex);
      }
    }
    const operations: Parameters<
      FileSystemTransactions["applyBatch"]
    >[0]["operations"] = [];
    const rootIds: string[] = [];
    const allocatedIds = new Set<string>();
    const append = (source: (typeof entries)[number], parentId: string) => {
      if (operations.length >= 10_000) {
        throw invalid("The copied tree exceeds 10000 entries.");
      }
      const entryIdHex = allocateEntryId(
        index,
        allocatedIds,
        this.#randomId,
      );
      if (parentId === parent.entryIdHex) rootIds.push(entryIdHex);
      if (source.kind === "directory") {
        operations.push({
          kind: "create-directory",
          entryIdHex,
          parentEntryIdHex: parentId,
          name: source.name,
          mtimeMs: source.mtimeMs,
        });
        for (const child of index.listChildren(source.entryIdHex)) {
          append(child, entryIdHex);
        }
      } else if (source.content) {
        operations.push({
          kind: "create-file",
          entryIdHex,
          parentEntryIdHex: parentId,
          name: source.name,
          content: source.content,
          mtimeMs: source.mtimeMs,
        });
      } else {
        throw invalid("A copied file has no content reference.");
      }
    };
    for (const entry of entries) append(entry, parent.entryIdHex);
    return await this.#publishBatch(
      operations,
      input.expectedRevision,
      rootIds,
    );
  }

  async removeEntries(
    instanceToken: string,
    input: {
      entryIds: string[];
      expectedRevision: number;
    },
  ): Promise<InternalBatchMutationResult> {
    this.#authorize(instanceToken);
    const index = await this.#loadExpected(input.expectedRevision);
    const entries = normalizeTopLevelEntries(index, input.entryIds);
    return await this.#publishBatch(
      entries.map((entry) => ({
        kind: "remove" as const,
        entryIdHex: entry.entryIdHex,
        recursive: entry.kind === "directory",
      })),
      input.expectedRevision,
      entries.map((entry) => entry.entryIdHex),
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

  async #publishBatch(
    operations: Parameters<FileSystemTransactions["applyBatch"]>[0]["operations"],
    expectedRevision: number,
    entryIds: string[],
  ): Promise<InternalBatchMutationResult> {
    try {
      const published = await this.#transactions.applyBatch({
        operations,
        expectedRevision,
      });
      return { entryIds, revision: published.ref.revision };
    } catch (error) {
      if (error instanceof RefStoreError && error.code === "REF_CONFLICT") {
        throw conflict();
      }
      throw error;
    }
  }
}

function normalizeTopLevelEntries(
  index: EntryIndex,
  entryIds: string[],
) {
  if (
    !Array.isArray(entryIds) ||
    entryIds.length === 0 ||
    entryIds.length > 1_000 ||
    entryIds.some((entryId) => typeof entryId !== "string")
  ) {
    throw invalid("entryIds must contain 1 to 1000 Entry IDs.");
  }
  const selected = new Set(entryIds);
  const entries = [...selected].map((entryId) => {
    const entry = index.get(entryId);
    if (!entry) throw notFound("A selected entry was not found.");
    if (entry.parentEntryIdHex === null) {
      throw denied("The root directory cannot be changed.");
    }
    return entry;
  });
  return entries.filter((entry) => {
    let parentId = entry.parentEntryIdHex;
    while (parentId !== null) {
      if (selected.has(parentId)) return false;
      parentId = index.get(parentId)?.parentEntryIdHex ?? null;
    }
    return true;
  });
}

function requireDirectory(index: EntryIndex, entryId: string) {
  const entry = index.get(entryId);
  if (!entry || entry.kind !== "directory") {
    throw notFound("Destination directory was not found.");
  }
  return entry;
}

function requireBatchNamesAvailable(
  index: EntryIndex,
  entries: ReturnType<typeof normalizeTopLevelEntries>,
  parentEntryId: string,
  ignoreSelected: boolean,
): void {
  const selectedIds = new Set(entries.map((entry) => entry.entryIdHex));
  const names = new Set<string>();
  for (const entry of entries) {
    if (names.has(entry.name)) {
      throw invalid("Selected entries contain duplicate destination names.");
    }
    names.add(entry.name);
  }
  for (const existing of index.listChildren(parentEntryId)) {
    if (ignoreSelected && selectedIds.has(existing.entryIdHex)) continue;
    if (names.has(existing.name)) {
      throw invalid(`Destination already contains “${existing.name}”.`);
    }
  }
}

function allocateEntryId(
  index: EntryIndex,
  allocatedIds: Set<string>,
  randomId: () => Uint8Array,
): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const value = randomId();
    if (value.length !== 16 || value.every((byte) => byte === 0)) continue;
    const entryIdHex = Buffer.from(value).toString("hex");
    if (!index.has(entryIdHex) && !allocatedIds.has(entryIdHex)) {
      allocatedIds.add(entryIdHex);
      return entryIdHex;
    }
  }
  throw invalid("Unable to generate a unique Entry ID.");
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
