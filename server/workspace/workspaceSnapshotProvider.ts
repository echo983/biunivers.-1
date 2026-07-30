import {
  loadCurrentEntryIndex,
  type EntryIndex,
  type IndexedEntry,
} from "../files/entryIndex.js";
import type { ImmutableObjectRepository } from "../files/immutableObjectRepository.js";
import {
  RefStoreError,
  type SqliteRefStore,
} from "../files/sqliteRefStore.js";

export interface WorkspaceSnapshotEntry {
  inode: number;
  parentInode: number | null;
  entryIdHex: string;
  name: string;
  kind: "directory" | "file";
  createdAtMs: number;
  mtimeMs: number;
  content?: {
    kind: "chunk" | "manifest";
    fidHex: string;
    size: number;
  };
}

export interface WorkspaceSnapshot {
  workspaceIdHex: string;
  refId: string;
  lineageIdHex: string;
  headFidHex: string;
  revision: number;
  rootEntryIdHex: string;
  rootInode: 1;
  entries: WorkspaceSnapshotEntry[];
  indexLoadMs: number;
}

export class WorkspaceSnapshotProvider {
  readonly #repository: ImmutableObjectRepository;
  readonly #refStore: SqliteRefStore;
  readonly #beforeFinalRefRead?: () => void | Promise<void>;

  constructor(options: {
    repository: ImmutableObjectRepository;
    refStore: SqliteRefStore;
    beforeFinalRefRead?: () => void | Promise<void>;
  }) {
    this.#repository = options.repository;
    this.#refStore = options.refStore;
    this.#beforeFinalRefRead = options.beforeFinalRefRead;
  }

  async capture(workspaceIdHex: string): Promise<WorkspaceSnapshot> {
    const workspace = this.#refStore.getWorkspace(workspaceIdHex);
    const before = this.#refStore.getRef(workspace.refId);
    const startedAt = performance.now();
    const index = await loadCurrentEntryIndex(
      this.#repository,
      this.#refStore,
      workspace.refId,
    );
    const indexLoadMs = performance.now() - startedAt;
    await this.#beforeFinalRefRead?.();
    const after = this.#refStore.getRef(workspace.refId);
    if (
      before.headFidHex !== after.headFidHex ||
      before.revision !== after.revision ||
      before.lineageIdHex !== after.lineageIdHex ||
      after.revision !== index.revision
    ) {
      throw new RefStoreError(
        "REF_CONFLICT",
        "Workspace Ref changed while its fixed snapshot was loading.",
      );
    }
    return {
      workspaceIdHex,
      refId: workspace.refId,
      lineageIdHex: after.lineageIdHex,
      headFidHex: after.headFidHex,
      revision: after.revision,
      rootEntryIdHex: index.rootEntryIdHex,
      rootInode: 1,
      entries: projectStableInodes(index),
      indexLoadMs,
    };
  }
}

function projectStableInodes(index: EntryIndex): WorkspaceSnapshotEntry[] {
  const root = index.get(index.rootEntryIdHex);
  if (!root || root.kind !== "directory" || root.parentEntryIdHex !== null) {
    throw new Error("Workspace EntryIndex root is invalid.");
  }
  const reachable: IndexedEntry[] = [];
  const queue = [root];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const entry = queue.shift()!;
    if (visited.has(entry.entryIdHex)) {
      throw new Error("Workspace EntryIndex contains a duplicate or cycle.");
    }
    visited.add(entry.entryIdHex);
    reachable.push(entry);
    if (entry.kind === "directory") {
      queue.push(...index.listChildren(entry.entryIdHex));
    }
  }
  const ordered = reachable
    .filter((entry) => entry.entryIdHex !== root.entryIdHex)
    .sort((left, right) => left.entryIdHex.localeCompare(right.entryIdHex));
  const inodeByEntryId = new Map<string, number>([[root.entryIdHex, 1]]);
  ordered.forEach((entry, position) => {
    inodeByEntryId.set(entry.entryIdHex, position + 2);
  });
  return [root, ...ordered].map((entry) => ({
    inode: inodeByEntryId.get(entry.entryIdHex)!,
    parentInode:
      entry.parentEntryIdHex === null
        ? null
        : (inodeByEntryId.get(entry.parentEntryIdHex) ?? invalidParent()),
    entryIdHex: entry.entryIdHex,
    name: entry.parentEntryIdHex === null ? "" : entry.name,
    kind: entry.kind,
    createdAtMs: entry.createdAtMs,
    mtimeMs: entry.mtimeMs,
    ...(entry.content ? { content: { ...entry.content } } : {}),
  }));
}

function invalidParent(): never {
  throw new Error("Workspace EntryIndex contains an unreachable parent.");
}
