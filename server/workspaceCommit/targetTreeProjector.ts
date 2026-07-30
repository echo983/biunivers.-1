import { randomBytes } from "node:crypto";
import type { EntryIndex, IndexedEntry } from "../files/entryIndex.js";
import type { FileContentRef } from "../files/fileContentStore.js";
import type { UpperScanEntry } from "./upperScanner.js";

export type TargetContent =
  | { source: "lower"; ref: FileContentRef }
  | { source: "upper"; path: string; size: number };

export interface TargetTreeEntry {
  path: string;
  entryIdHex: string;
  parentEntryIdHex: string | null;
  name: string;
  kind: "directory" | "file";
  createdAtMs: number;
  mtimeMs: number;
  content?: TargetContent;
}

export interface TargetTree {
  revision: number;
  rootEntryIdHex: string;
  entries: TargetTreeEntry[];
}

export class TargetTreeProjector {
  readonly #randomId: () => Uint8Array;
  readonly #maxEntries: number;
  readonly #maxDepth: number;
  readonly #now: () => number;

  constructor(options: {
    randomId?: () => Uint8Array;
    maxEntries?: number;
    maxDepth?: number;
    now?: () => number;
  } = {}) {
    this.#randomId = options.randomId ?? (() => randomBytes(16));
    this.#maxEntries = positive(options.maxEntries ?? 1_000_000);
    this.#maxDepth = positive(options.maxDepth ?? 128);
    this.#now = options.now ?? Date.now;
  }

  project(lower: EntryIndex, upper: readonly UpperScanEntry[]): TargetTree {
    const byPath = projectLower(lower);
    const allocated = new Set(
      [...byPath.values()].map((entry) => entry.entryIdHex),
    );
    const createdAtMs = this.#now();
    if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
      throw new Error("Target tree timestamp is invalid.");
    }

    for (const change of upper) {
      const parentPath = parentOf(change.path);
      const parent = byPath.get(parentPath);
      if (!parent || parent.kind !== "directory") {
        throw new Error(`Upper parent is not a directory: ${change.path}`);
      }
      const existing = byPath.get(change.path);
      if (change.kind === "whiteout") {
        if (!existing) {
          throw new Error(`Whiteout target does not exist: ${change.path}`);
        }
        removeSubtree(byPath, change.path);
        continue;
      }
      if (change.kind === "directory") {
        if (change.opaque || (existing && existing.kind !== "directory")) {
          if (existing) removeSubtree(byPath, change.path);
          byPath.set(
            change.path,
            this.#newEntry({
              path: change.path,
              parentEntryIdHex: parent.entryIdHex,
              kind: "directory",
              createdAtMs,
              mtimeMs: toMtimeMs(change),
              allocated,
              lower,
            }),
          );
        } else if (!existing) {
          byPath.set(
            change.path,
            this.#newEntry({
              path: change.path,
              parentEntryIdHex: parent.entryIdHex,
              kind: "directory",
              createdAtMs,
              mtimeMs: toMtimeMs(change),
              allocated,
              lower,
            }),
          );
        } else {
          // Existing directory metadata remains stable. PVLog V1 has no
          // standalone directory-metadata operation; child operations carry
          // the logical tree change without manufacturing a replacement ID.
        }
        continue;
      }

      if (existing?.kind === "directory") removeSubtree(byPath, change.path);
      const current = byPath.get(change.path);
      byPath.set(
        change.path,
        current?.kind === "file"
          ? {
              ...current,
              mtimeMs: toMtimeMs(change),
              content: {
                source: "upper",
                path: change.path,
                size: change.size,
              },
            }
          : this.#newEntry({
              path: change.path,
              parentEntryIdHex: parent.entryIdHex,
              kind: "file",
              createdAtMs,
              mtimeMs: toMtimeMs(change),
              allocated,
              lower,
              content: {
                source: "upper",
                path: change.path,
                size: change.size,
              },
            }),
      );
    }

    const entries = [...byPath.values()].sort(compareTargetEntries);
    validateTarget(entries, this.#maxEntries, this.#maxDepth);
    return {
      revision: lower.revision + 1,
      rootEntryIdHex: lower.rootEntryIdHex,
      entries,
    };
  }

  #newEntry(input: {
    path: string;
    parentEntryIdHex: string;
    kind: "directory" | "file";
    createdAtMs: number;
    mtimeMs: number;
    allocated: Set<string>;
    lower: EntryIndex;
    content?: TargetContent;
  }): TargetTreeEntry {
    return {
      path: input.path,
      entryIdHex: allocateId(this.#randomId, input.allocated, input.lower),
      parentEntryIdHex: input.parentEntryIdHex,
      name: nameOf(input.path),
      kind: input.kind,
      createdAtMs: input.createdAtMs,
      mtimeMs: input.mtimeMs,
      content: input.content,
    };
  }
}

function projectLower(index: EntryIndex): Map<string, TargetTreeEntry> {
  const root = index.get(index.rootEntryIdHex);
  if (!root || root.kind !== "directory" || root.parentEntryIdHex !== null) {
    throw new Error("Lower EntryIndex root is invalid.");
  }
  const result = new Map<string, TargetTreeEntry>();
  const visit = (entry: IndexedEntry, path: string): void => {
    if (result.has(path)) throw new Error("Lower tree contains a duplicate path.");
    result.set(path, {
      path,
      entryIdHex: entry.entryIdHex,
      parentEntryIdHex: entry.parentEntryIdHex,
      name: entry.name,
      kind: entry.kind,
      createdAtMs: entry.createdAtMs,
      mtimeMs: entry.mtimeMs,
      content: entry.content
        ? { source: "lower", ref: { ...entry.content } }
        : undefined,
    });
    if (entry.kind === "directory") {
      for (const child of index.listChildren(entry.entryIdHex)) {
        visit(child, path ? `${path}/${child.name}` : child.name);
      }
    }
  };
  visit(root, "");
  return result;
}

function removeSubtree(
  entries: Map<string, TargetTreeEntry>,
  path: string,
): void {
  for (const candidate of [...entries.keys()]) {
    if (candidate === path || candidate.startsWith(`${path}/`)) {
      entries.delete(candidate);
    }
  }
}

function allocateId(
  randomId: () => Uint8Array,
  allocated: Set<string>,
  lower: EntryIndex,
): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const bytes = randomId();
    if (bytes.byteLength !== 16 || bytes.every((byte) => byte === 0)) continue;
    const value = Buffer.from(bytes).toString("hex");
    if (!allocated.has(value) && !lower.has(value)) {
      allocated.add(value);
      return value;
    }
  }
  throw new Error("Could not allocate a unique target Entry ID.");
}

function validateTarget(
  entries: TargetTreeEntry[],
  maxEntries: number,
  maxDepth: number,
): void {
  if (entries.length === 0 || entries.length > maxEntries) {
    throw new Error("Target tree entry limit exceeded.");
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  const byId = new Map<string, TargetTreeEntry>();
  for (const entry of entries) {
    if (
      ids.has(entry.entryIdHex) ||
      paths.has(entry.path) ||
      entry.path.split("/").filter(Boolean).length > maxDepth
    ) {
      throw new Error(`Target tree is invalid at ${entry.path || "/"}.`);
    }
    ids.add(entry.entryIdHex);
    paths.add(entry.path);
    byId.set(entry.entryIdHex, entry);
  }
  const roots = entries.filter((entry) => entry.parentEntryIdHex === null);
  if (roots.length !== 1 || roots[0]?.path !== "" || roots[0].kind !== "directory") {
    throw new Error("Target tree root is invalid.");
  }
  for (const entry of entries) {
    if (entry.path === "") continue;
    const parent = entry.parentEntryIdHex
      ? byId.get(entry.parentEntryIdHex)
      : undefined;
    if (
      !parent ||
      parent.kind !== "directory" ||
      parent.path !== parentOf(entry.path) ||
      entry.name !== nameOf(entry.path) ||
      (entry.kind === "file" && !entry.content) ||
      (entry.kind === "directory" && entry.content)
    ) {
      throw new Error(`Target tree relation is invalid at ${entry.path}.`);
    }
  }
}

function toMtimeMs(entry: UpperScanEntry): number {
  const milliseconds = BigInt(entry.mtimeNs) / 1_000_000n;
  const value = Number(milliseconds);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Upper mtime is invalid: ${entry.path}`);
  }
  return value;
}

function parentOf(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function compareTargetEntries(
  left: TargetTreeEntry,
  right: TargetTreeEntry,
): number {
  if (left.path === "") return -1;
  if (right.path === "") return 1;
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Target tree limit is invalid.");
  }
  return value;
}
