import { extname } from "node:path";
import { randomBytes } from "node:crypto";
import { FileContentStore } from "../files/fileContentStore.js";
import {
  FileSystemTransactions,
  type BatchFileSystemOperation,
} from "../files/fileSystemTransactions.js";
import {
  loadCurrentEntryIndex,
  type EntryIndex,
  type IndexedEntry,
} from "../files/entryIndex.js";
import type { ImmutableObjectRepository } from "../files/immutableObjectRepository.js";
import type { SqliteRefStore } from "../files/sqliteRefStore.js";

interface WormholeFileServiceOptions {
  repository: ImmutableObjectRepository;
  refStore: SqliteRefStore;
  writerId: string;
  maxFileBytes?: number;
}

export interface WebDavResource {
  entryId: string;
  name: string;
  kind: "file" | "directory";
  createdAtMs: number;
  mtimeMs: number;
  size: number;
  etag: string;
  contentType?: string;
  segments: string[];
}

export interface WebDavListing {
  revision: number;
  resource: WebDavResource;
  children: WebDavResource[];
}

export interface WebDavRead {
  resource: WebDavResource;
  chunks: AsyncIterable<Uint8Array>;
}

export class WormholeFileService {
  readonly #repository: ImmutableObjectRepository;
  readonly #refStore: SqliteRefStore;
  readonly #contentStore: FileContentStore;
  readonly #transactions: FileSystemTransactions;
  readonly #maxFileBytes: number;

  constructor(options: WormholeFileServiceOptions) {
    this.#repository = options.repository;
    this.#refStore = options.refStore;
    this.#contentStore = new FileContentStore(options.repository);
    this.#transactions = new FileSystemTransactions({
      refId: "main",
      repository: options.repository,
      refStore: options.refStore,
      writerId: options.writerId,
    });
    this.#maxFileBytes = options.maxFileBytes ?? 4 * 1024 ** 3;
  }

  async list(
    segments: readonly string[],
    includeChildren: boolean,
  ): Promise<WebDavListing> {
    const index = await loadCurrentEntryIndex(
      this.#repository,
      this.#refStore,
      "main",
    );
    const entry = resolveEntry(index, segments);
    return {
      revision: index.revision,
      resource: publicResource(entry, segments, index.revision),
      children:
        includeChildren && entry.kind === "directory"
          ? index.listChildren(entry.entryIdHex).map((child) =>
              publicResource(
                child,
                [...segments, child.name],
                index.revision,
              ),
            )
          : [],
    };
  }

  async read(segments: readonly string[]): Promise<WebDavRead> {
    const index = await loadCurrentEntryIndex(
      this.#repository,
      this.#refStore,
      "main",
    );
    const entry = requireFile(resolveEntry(index, segments));
    return {
      resource: publicResource(entry, segments, index.revision),
      chunks: this.#contentStore.readChunks(entry.content!),
    };
  }

  async readRange(
    segments: readonly string[],
    start: number,
    endInclusive: number,
  ): Promise<WebDavRead> {
    const index = await loadCurrentEntryIndex(
      this.#repository,
      this.#refStore,
      "main",
    );
    const entry = requireFile(resolveEntry(index, segments));
    return {
      resource: publicResource(entry, segments, index.revision),
      chunks: this.#contentStore.readRange(entry.content!, start, endInclusive),
    };
  }

  async put(
    segments: readonly string[],
    source: AsyncIterable<Uint8Array>,
    mtimeMs?: number,
    precondition?: { ifMatch?: string; ifNoneMatch?: string },
  ): Promise<{ created: boolean; etag: string }> {
    const { index, parent, name, existing } = await this.#destination(segments);
    if (existing?.kind === "directory") {
      throw new WormholeFileError("IS_DIRECTORY", "Resource is a directory.");
    }
    const currentEtag = existing?.content ? `"${existing.content.fidHex}"` : undefined;
    if (
      (precondition?.ifNoneMatch === "*" && existing) ||
      (precondition?.ifMatch &&
        precondition.ifMatch !== "*" &&
        precondition.ifMatch !== currentEtag)
    ) {
      throw new WormholeFileError("PRECONDITION", "File precondition failed.");
    }
    const content = await this.#contentStore.putStream(source, this.#maxFileBytes);
    if (existing) {
      await this.#transactions.setFileContent({
        entryIdHex: existing.entryIdHex,
        expectedContentFidHex: existing.content!.fidHex,
        content,
        mtimeMs,
      });
      return { created: false, etag: `"${content.fidHex}"` };
    }
    await this.#transactions.createFile({
      parentEntryIdHex: parent.entryIdHex,
      name,
      content,
      mtimeMs,
      expectedRevision: index.revision,
    });
    return { created: true, etag: `"${content.fidHex}"` };
  }

  async createDirectory(segments: readonly string[], mtimeMs?: number) {
    const { index, parent, name, existing } = await this.#destination(segments);
    if (existing) throw new WormholeFileError("ALREADY_EXISTS", "Resource exists.");
    await this.#transactions.createDirectory({
      parentEntryIdHex: parent.entryIdHex,
      name,
      mtimeMs,
      expectedRevision: index.revision,
    });
  }

  async setMtime(segments: readonly string[], mtimeMs: number) {
    const index = await loadCurrentEntryIndex(
      this.#repository,
      this.#refStore,
      "main",
    );
    const entry = requireFile(resolveEntry(index, segments));
    await this.#transactions.setFileContent({
      entryIdHex: entry.entryIdHex,
      expectedContentFidHex: entry.content!.fidHex,
      content: entry.content!,
      mtimeMs,
    });
  }

  async remove(segments: readonly string[]) {
    const index = await loadCurrentEntryIndex(
      this.#repository,
      this.#refStore,
      "main",
    );
    const entry = resolveEntry(index, segments);
    if (entry.parentEntryIdHex === null) {
      throw new WormholeFileError("ROOT_FORBIDDEN", "Root cannot be removed.");
    }
    await this.#transactions.removeEntry({
      entryIdHex: entry.entryIdHex,
      recursive: true,
      expectedRevision: index.revision,
    });
  }

  async move(
    sourceSegments: readonly string[],
    destinationSegments: readonly string[],
    overwrite: boolean,
  ) {
    const index = await loadCurrentEntryIndex(
      this.#repository,
      this.#refStore,
      "main",
    );
    const source = resolveEntry(index, sourceSegments);
    if (source.parentEntryIdHex === null) {
      throw new WormholeFileError("ROOT_FORBIDDEN", "Root cannot be moved.");
    }
    const { parent, name, existing } = destination(index, destinationSegments);
    ensureNotDescendant(index, source, parent);
    if (existing?.entryIdHex === source.entryIdHex) return;
    if (existing && !overwrite) {
      throw new WormholeFileError("PRECONDITION", "Destination exists.");
    }
    if (existing && existing.kind === "directory" && index.listChildren(existing.entryIdHex).length) {
      throw new WormholeFileError("DIRECTORY_NOT_EMPTY", "Destination directory is not empty.");
    }
    const operations: BatchFileSystemOperation[] = [];
    if (existing) {
      operations.push({ kind: "remove", entryIdHex: existing.entryIdHex, recursive: true });
    }
    operations.push({
      kind: "move",
      entryIdHex: source.entryIdHex,
      newParentEntryIdHex: parent.entryIdHex,
      newName: name,
    });
    await this.#transactions.applyBatch({
      operations,
      expectedRevision: index.revision,
    });
  }

  async copy(
    sourceSegments: readonly string[],
    destinationSegments: readonly string[],
    overwrite: boolean,
  ) {
    const index = await loadCurrentEntryIndex(
      this.#repository,
      this.#refStore,
      "main",
    );
    const source = resolveEntry(index, sourceSegments);
    const { parent, name, existing } = destination(index, destinationSegments);
    ensureNotDescendant(index, source, parent);
    if (existing && !overwrite) {
      throw new WormholeFileError("PRECONDITION", "Destination exists.");
    }
    if (existing && existing.kind === "directory" && index.listChildren(existing.entryIdHex).length) {
      throw new WormholeFileError("DIRECTORY_NOT_EMPTY", "Destination directory is not empty.");
    }
    const operations: BatchFileSystemOperation[] = [];
    if (existing) {
      operations.push({ kind: "remove", entryIdHex: existing.entryIdHex, recursive: true });
    }
    appendCopyOperations(index, source, parent.entryIdHex, name, operations);
    await this.#transactions.applyBatch({
      operations,
      expectedRevision: index.revision,
    });
  }

  async #destination(segments: readonly string[]) {
    const index = await loadCurrentEntryIndex(
      this.#repository,
      this.#refStore,
      "main",
    );
    return { index, ...destination(index, segments) };
  }
}

export class WormholeFileError extends Error {
  constructor(
    public readonly code:
      | "NOT_FOUND"
      | "IS_DIRECTORY"
      | "ALREADY_EXISTS"
      | "ROOT_FORBIDDEN"
      | "PRECONDITION"
      | "DIRECTORY_NOT_EMPTY"
      | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "WormholeFileError";
  }
}

function destination(index: EntryIndex, segments: readonly string[]) {
  if (segments.length === 0) {
    throw new WormholeFileError("ROOT_FORBIDDEN", "Root is not a destination.");
  }
  const parent = resolveEntry(index, segments.slice(0, -1));
  if (parent.kind !== "directory") {
    throw new WormholeFileError("CONFLICT", "Parent is not a directory.");
  }
  const name = segments.at(-1)!;
  const folded = name.toLocaleLowerCase("und");
  const existing = index
    .listChildren(parent.entryIdHex)
    .find((entry) => entry.name.toLocaleLowerCase("und") === folded);
  return { parent, name, existing };
}

function ensureNotDescendant(
  index: EntryIndex,
  source: IndexedEntry,
  destinationParent: IndexedEntry,
) {
  let current: IndexedEntry | undefined = destinationParent;
  while (current) {
    if (current.entryIdHex === source.entryIdHex) {
      throw new WormholeFileError("CONFLICT", "Destination is inside source.");
    }
    current = current.parentEntryIdHex
      ? index.get(current.parentEntryIdHex)
      : undefined;
  }
}

function appendCopyOperations(
  index: EntryIndex,
  source: IndexedEntry,
  parentEntryIdHex: string,
  name: string,
  operations: BatchFileSystemOperation[],
) {
  const entryIdHex = randomBytes(16).toString("hex");
  if (source.kind === "file") {
    operations.push({
      kind: "create-file",
      entryIdHex,
      parentEntryIdHex,
      name,
      content: source.content!,
      mtimeMs: source.mtimeMs,
    });
    return;
  }
  operations.push({
    kind: "create-directory",
    entryIdHex,
    parentEntryIdHex,
    name,
    mtimeMs: source.mtimeMs,
  });
  for (const child of index.listChildren(source.entryIdHex)) {
    appendCopyOperations(index, child, entryIdHex, child.name, operations);
  }
}

function resolveEntry(
  index: EntryIndex,
  segments: readonly string[],
): IndexedEntry {
  let entry = index.get(index.rootEntryIdHex)!;
  for (const segment of segments) {
    if (entry.kind !== "directory") {
      throw new WormholeFileError("NOT_FOUND", "Resource was not found.");
    }
    const child = index
      .listChildren(entry.entryIdHex)
      .find((candidate) => candidate.name === segment);
    if (!child) {
      throw new WormholeFileError("NOT_FOUND", "Resource was not found.");
    }
    entry = child;
  }
  return entry;
}

function requireFile(entry: IndexedEntry): IndexedEntry {
  if (entry.kind !== "file" || !entry.content) {
    throw new WormholeFileError("IS_DIRECTORY", "Resource is a directory.");
  }
  return entry;
}

function publicResource(
  entry: IndexedEntry,
  segments: readonly string[],
  revision: number,
): WebDavResource {
  return {
    entryId: entry.entryIdHex,
    name: entry.name,
    kind: entry.kind,
    createdAtMs: entry.createdAtMs,
    mtimeMs: entry.mtimeMs,
    size: entry.content?.size ?? 0,
    etag:
      entry.kind === "file" && entry.content
        ? `"${entry.content.fidHex}"`
        : `"dir-${entry.entryIdHex}-r${revision}"`,
    ...(entry.kind === "file" ? { contentType: contentType(entry.name) } : {}),
    segments: [...segments],
  };
}

function contentType(name: string): string {
  return {
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".json": "application/json",
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".mp4": "video/mp4",
    ".mkv": "video/x-matroska",
    ".zip": "application/zip",
  }[extname(name).toLowerCase()] ?? "application/octet-stream";
}
