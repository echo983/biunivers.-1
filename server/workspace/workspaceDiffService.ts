import {
  loadEntryIndexAtHead,
  type EntryIndex,
  type IndexedEntry,
} from "../files/entryIndex.js";
import type { ImmutableObjectRepository } from "../files/immutableObjectRepository.js";
import { loadPvlogCore, type PvlogCore } from "../files/pvlogCore.js";
import {
  RefStoreError,
  type SqliteRefStore,
} from "../files/sqliteRefStore.js";

export interface WorkspaceDiffEntryMetadata {
  entryIdHex: string;
  kind: "directory" | "file";
  size: number;
  mtimeMs: number;
  contentFidHex: string | null;
}

export interface WorkspaceDiffEntry {
  path: string;
  change: "added" | "modified" | "deleted";
  before: WorkspaceDiffEntryMetadata | null;
  after: WorkspaceDiffEntryMetadata | null;
}

export interface WorkspaceDiff {
  workspaceIdHex: string;
  baselineHeadFidHex: string;
  currentHeadFidHex: string;
  baselineRevision: number;
  currentRevision: number;
  changes: WorkspaceDiffEntry[];
  summary: {
    added: number;
    modified: number;
    deleted: number;
  };
}

export class WorkspaceDiffService {
  readonly #repository: ImmutableObjectRepository;
  readonly #refStore: SqliteRefStore;
  readonly #core: PvlogCore;
  readonly #maxChanges: number;
  readonly #beforeFinalRefRead?: () => void | Promise<void>;

  constructor(options: {
    repository: ImmutableObjectRepository;
    refStore: SqliteRefStore;
    core?: PvlogCore;
    maxChanges?: number;
    beforeFinalRefRead?: () => void | Promise<void>;
  }) {
    this.#repository = options.repository;
    this.#refStore = options.refStore;
    this.#core = options.core ?? loadPvlogCore();
    this.#maxChanges = options.maxChanges ?? 100_000;
    if (!Number.isSafeInteger(this.#maxChanges) || this.#maxChanges < 1) {
      throw new Error("Workspace Diff change limit is invalid.");
    }
    this.#beforeFinalRefRead = options.beforeFinalRefRead;
  }

  async compare(workspaceIdHex: string): Promise<WorkspaceDiff> {
    const workspace = this.#refStore.getWorkspace(workspaceIdHex);
    const beforeRef = this.#refStore.getRef(workspace.refId);
    const baselineRevision = await this.#headRevision(
      workspace.baselineHeadFidHex,
      beforeRef.lineageIdHex,
    );
    const [baseline, current] = await Promise.all([
      loadEntryIndexAtHead(
        this.#repository,
        workspace.baselineHeadFidHex,
        baselineRevision,
        beforeRef.lineageIdHex,
        this.#core,
      ),
      loadEntryIndexAtHead(
        this.#repository,
        beforeRef.headFidHex,
        beforeRef.revision,
        beforeRef.lineageIdHex,
        this.#core,
      ),
    ]);
    const changes = compareIndexes(baseline, current, this.#maxChanges);
    await this.#beforeFinalRefRead?.();
    const afterRef = this.#refStore.getRef(workspace.refId);
    if (
      beforeRef.headFidHex !== afterRef.headFidHex ||
      beforeRef.revision !== afterRef.revision ||
      beforeRef.lineageIdHex !== afterRef.lineageIdHex
    ) {
      throw new RefStoreError(
        "REF_CONFLICT",
        "Workspace Ref changed while its Diff was loading.",
      );
    }
    return {
      workspaceIdHex,
      baselineHeadFidHex: workspace.baselineHeadFidHex,
      currentHeadFidHex: afterRef.headFidHex,
      baselineRevision,
      currentRevision: afterRef.revision,
      changes,
      summary: {
        added: changes.filter((entry) => entry.change === "added").length,
        modified: changes.filter((entry) => entry.change === "modified").length,
        deleted: changes.filter((entry) => entry.change === "deleted").length,
      },
    };
  }

  async #headRevision(
    headFidHex: string,
    expectedLineageIdHex: string,
  ): Promise<number> {
    const head = await this.#repository.get("heads", headFidHex);
    this.#core.validateHead(head);
    if (
      Buffer.from(this.#core.headLineageId(head)).toString("hex") !==
      expectedLineageIdHex
    ) {
      throw new Error("Workspace baseline Head lineage is invalid.");
    }
    const revision = Number(this.#core.headRevision(head));
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error("Workspace baseline revision is invalid.");
    }
    return revision;
  }
}

export function compareIndexes(
  baseline: EntryIndex,
  current: EntryIndex,
  maxChanges = 100_000,
): WorkspaceDiffEntry[] {
  const before = flatten(baseline);
  const after = flatten(current);
  const paths = [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => path !== "")
    .sort();
  const changes: WorkspaceDiffEntry[] = [];
  for (const path of paths) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    const oldMetadata = oldEntry ? metadata(oldEntry) : null;
    const newMetadata = newEntry ? metadata(newEntry) : null;
    if (!oldMetadata) {
      changes.push({
        path,
        change: "added",
        before: null,
        after: newMetadata,
      });
    } else if (!newMetadata) {
      changes.push({
        path,
        change: "deleted",
        before: oldMetadata,
        after: null,
      });
    } else if (!sameMetadata(oldMetadata, newMetadata)) {
      changes.push({
        path,
        change: "modified",
        before: oldMetadata,
        after: newMetadata,
      });
    }
    if (changes.length > maxChanges) {
      throw new Error("Workspace Diff change limit exceeded.");
    }
  }
  return changes;
}

function flatten(index: EntryIndex): Map<string, IndexedEntry> {
  const root = index.get(index.rootEntryIdHex);
  if (!root || root.kind !== "directory") {
    throw new Error("Workspace Diff root is invalid.");
  }
  const result = new Map<string, IndexedEntry>();
  const visit = (entry: IndexedEntry, path: string): void => {
    if (result.has(path)) throw new Error("Workspace Diff path is duplicated.");
    result.set(path, entry);
    if (entry.kind === "directory") {
      for (const child of index.listChildren(entry.entryIdHex)) {
        visit(child, path ? `${path}/${child.name}` : child.name);
      }
    }
  };
  visit(root, "");
  return result;
}

function metadata(entry: IndexedEntry): WorkspaceDiffEntryMetadata {
  return {
    entryIdHex: entry.entryIdHex,
    kind: entry.kind,
    size: entry.content?.size ?? 0,
    mtimeMs: entry.mtimeMs,
    contentFidHex: entry.content?.fidHex ?? null,
  };
}

function sameMetadata(
  left: WorkspaceDiffEntryMetadata,
  right: WorkspaceDiffEntryMetadata,
): boolean {
  return (
    left.entryIdHex === right.entryIdHex &&
    left.kind === right.kind &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.contentFidHex === right.contentFidHex
  );
}
