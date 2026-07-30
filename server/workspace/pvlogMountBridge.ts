import { createServer, type Server, type Socket } from "node:net";
import { rm, writeFile } from "node:fs/promises";

import { FileContentStore } from "../files/fileContentStore.js";
import {
  loadCurrentEntryIndex,
  type EntryIndex,
  type IndexedEntry,
} from "../files/entryIndex.js";
import type { FileServiceRuntime } from "../files/fileServiceRuntime.js";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_READ_BYTES = 1024 * 1024;

export interface PvlogMountSnapshotEntry {
  inode: number;
  parentInode: number | null;
  entryIdHex: string;
  name: string;
  kind: "directory" | "file";
  size: number;
  mtimeMs: number;
}

export interface PvlogMountSnapshot {
  revision: number;
  headFidHex: string;
  rootInode: number;
  entries: PvlogMountSnapshotEntry[];
}

export interface PvlogMountBridgeMetrics {
  startedAt: string;
  indexLoadMs: number;
  snapshotBytes: number;
  entryCount: number;
  readRequests: number;
  bytesRead: number;
}

export class PvlogMountBridge {
  readonly snapshot: PvlogMountSnapshot;
  readonly #contentStore: FileContentStore;
  readonly #entriesById: Map<string, IndexedEntry>;
  readonly #socketPath: string;
  readonly #snapshotPath: string;
  readonly #startedAt = new Date();
  readonly #indexLoadMs: number;
  #snapshotBytes = 0;
  #readRequests = 0;
  #bytesRead = 0;
  #server?: Server;

  private constructor(options: {
    runtime: FileServiceRuntime;
    index: EntryIndex;
    headFidHex: string;
    socketPath: string;
    snapshotPath: string;
    indexLoadMs: number;
  }) {
    this.#contentStore = new FileContentStore(options.runtime.repository!);
    this.#socketPath = options.socketPath;
    this.#snapshotPath = options.snapshotPath;
    this.#indexLoadMs = options.indexLoadMs;
    const projected = projectEntries(options.index);
    this.snapshot = {
      revision: options.index.revision,
      headFidHex: options.headFidHex,
      rootInode: projected.rootInode,
      entries: projected.entries,
    };
    this.#entriesById = projected.entriesById;
  }

  static async create(options: {
    runtime: FileServiceRuntime;
    socketPath: string;
    snapshotPath: string;
  }): Promise<PvlogMountBridge> {
    if (
      options.runtime.status.mode !== "ready" ||
      !options.runtime.repository ||
      !options.runtime.refStore
    ) {
      throw new Error("File Service is not ready.");
    }
    const before = options.runtime.refStore.getRef("main");
    const started = performance.now();
    const index = await loadCurrentEntryIndex(
      options.runtime.repository,
      options.runtime.refStore,
    );
    const indexLoadMs = performance.now() - started;
    const after = options.runtime.refStore.getRef("main");
    if (
      before.headFidHex !== after.headFidHex ||
      before.revision !== after.revision ||
      after.revision !== index.revision
    ) {
      throw new Error("main Ref changed while the mount snapshot was loading.");
    }
    return new PvlogMountBridge({
      ...options,
      index,
      headFidHex: after.headFidHex,
      indexLoadMs,
    });
  }

  async listen(): Promise<void> {
    await Promise.all([
      rm(this.#socketPath, { force: true }),
      rm(this.#snapshotPath, { force: true }),
    ]);
    const snapshotJson = `${JSON.stringify(this.snapshot)}\n`;
    this.#snapshotBytes = Buffer.byteLength(snapshotJson);
    this.#server = createServer({ allowHalfOpen: true }, (socket) =>
      this.#accept(socket),
    );
    await new Promise<void>((resolve, reject) => {
      const server = this.#server!;
      server.once("error", reject);
      server.listen(this.#socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await writeFile(this.#snapshotPath, snapshotJson, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  }

  metrics(): PvlogMountBridgeMetrics {
    return {
      startedAt: this.#startedAt.toISOString(),
      indexLoadMs: this.#indexLoadMs,
      snapshotBytes: this.#snapshotBytes,
      entryCount: this.snapshot.entries.length,
      readRequests: this.#readRequests,
      bytesRead: this.#bytesRead,
    };
  }

  async close(): Promise<void> {
    if (this.#server) {
      const server = this.#server;
      this.#server = undefined;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await rm(this.#socketPath, { force: true });
  }

  #accept(socket: Socket): void {
    const chunks: Buffer[] = [];
    let size = 0;
    socket.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        socket.destroy(new Error("Mount bridge request is too large."));
        return;
      }
      chunks.push(chunk);
    });
    socket.on("end", () => {
      void this.#respond(socket, Buffer.concat(chunks).toString("utf8"));
    });
    socket.on("error", () => undefined);
  }

  async #respond(socket: Socket, input: string): Promise<void> {
    try {
      const request = parseRequest(input);
      if (request.op === "stats") {
        socket.end(`${JSON.stringify({ ok: true, metrics: this.metrics() })}\n`);
        return;
      }
      const entry = this.#entriesById.get(request.entryIdHex);
      if (!entry || entry.kind !== "file" || !entry.content) {
        throw new Error("Requested file is not in the fixed snapshot.");
      }
      const start = Math.min(request.offset, entry.content.size);
      const length = Math.min(request.size, entry.content.size - start);
      let bytes = new Uint8Array();
      if (length > 0) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of this.#contentStore.readRange(
          entry.content,
          start,
          start + length - 1,
        )) {
          chunks.push(chunk);
        }
        bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      }
      this.#readRequests += 1;
      this.#bytesRead += bytes.byteLength;
      socket.end(
        `${JSON.stringify({
          ok: true,
          dataBase64: Buffer.from(bytes).toString("base64"),
        })}\n`,
      );
    } catch (error) {
      socket.end(
        `${JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : "Unknown bridge error.",
        })}\n`,
      );
    }
  }
}

function projectEntries(index: EntryIndex): {
  rootInode: number;
  entries: PvlogMountSnapshotEntry[];
  entriesById: Map<string, IndexedEntry>;
} {
  const root = index.get(index.rootEntryIdHex);
  if (!root) throw new Error("EntryIndex root is missing.");
  const queue: Array<{ entry: IndexedEntry; parentInode: number | null }> = [
    { entry: root, parentInode: null },
  ];
  const entries: PvlogMountSnapshotEntry[] = [];
  const entriesById = new Map<string, IndexedEntry>();
  const visited = new Set<string>();
  let inode = 1;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.entry.entryIdHex)) {
      throw new Error("EntryIndex contains a cycle or duplicate child.");
    }
    visited.add(current.entry.entryIdHex);
    entriesById.set(current.entry.entryIdHex, current.entry);
    const currentInode = inode++;
    entries.push({
      inode: currentInode,
      parentInode: current.parentInode,
      entryIdHex: current.entry.entryIdHex,
      name: current.parentInode === null ? "" : current.entry.name,
      kind: current.entry.kind,
      size: current.entry.content?.size ?? 0,
      mtimeMs: current.entry.mtimeMs,
    });
    if (current.entry.kind === "directory") {
      for (const child of index.listChildren(current.entry.entryIdHex)) {
        queue.push({ entry: child, parentInode: currentInode });
      }
    }
  }
  return { rootInode: 1, entries, entriesById };
}

type BridgeRequest =
  | { op: "stats" }
  | { op: "read"; entryIdHex: string; offset: number; size: number };

function parseRequest(input: string): BridgeRequest {
  const value = JSON.parse(input) as Record<string, unknown>;
  if (value.op === "stats") return { op: "stats" };
  if (
    value.op !== "read" ||
    typeof value.entryIdHex !== "string" ||
    !/^[0-9a-f]{32}$/.test(value.entryIdHex) ||
    !Number.isSafeInteger(value.offset) ||
    !Number.isSafeInteger(value.size) ||
    (value.offset as number) < 0 ||
    (value.size as number) < 0 ||
    (value.size as number) > MAX_READ_BYTES
  ) {
    throw new Error("Invalid mount bridge request.");
  }
  return {
    op: "read",
    entryIdHex: value.entryIdHex,
    offset: value.offset as number,
    size: value.size as number,
  };
}
