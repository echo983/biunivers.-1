import type { EntryIndex, IndexedEntry } from "../files/entryIndex.js";
import type { FileContentRef } from "../files/fileContentStore.js";
import type { TargetTree, TargetTreeEntry } from "./targetTreeProjector.js";

export type CommitOperation =
  | { kind: "remove"; entryIdHex: string; recursive: boolean }
  | {
      kind: "create-directory";
      entryIdHex: string;
      parentEntryIdHex: string;
      name: string;
      mtimeMs: number;
    }
  | {
      kind: "create-file";
      entryIdHex: string;
      parentEntryIdHex: string;
      name: string;
      content: FileContentRef;
      mtimeMs: number;
    }
  | {
      kind: "set-file-content";
      entryIdHex: string;
      expectedContentFidHex: string;
      content: FileContentRef;
      mtimeMs: number;
    };

export function planCommitOperations(
  lower: EntryIndex,
  target: TargetTree,
): CommitOperation[] {
  if (
    target.revision !== lower.revision + 1 ||
    target.rootEntryIdHex !== lower.rootEntryIdHex
  ) {
    throw new Error("Commit target identity is invalid.");
  }
  const lowerById = flattenLower(lower);
  const targetById = new Map(
    target.entries.map((entry) => [entry.entryIdHex, entry]),
  );
  for (const entry of target.entries) {
    const before = lowerById.get(entry.entryIdHex);
    if (
      before &&
      (before.path !== entry.path || before.kind !== entry.kind)
    ) {
      throw new Error(
        `Existing Entry identity changed in commit target: ${entry.path}`,
      );
    }
  }
  const removals = [...lowerById.values()]
    .filter(
      (entry) =>
        entry.entryIdHex !== lower.rootEntryIdHex &&
        !targetById.has(entry.entryIdHex),
    )
    .filter((entry) => {
      let parent = entry.parentEntryIdHex
        ? lowerById.get(entry.parentEntryIdHex)
        : undefined;
      while (parent && parent.entryIdHex !== lower.rootEntryIdHex) {
        if (!targetById.has(parent.entryIdHex)) return false;
        parent = parent.parentEntryIdHex
          ? lowerById.get(parent.parentEntryIdHex)
          : undefined;
      }
      return true;
    })
    .sort((left, right) => depth(left.path) - depth(right.path))
    .map(
      (entry): CommitOperation => ({
        kind: "remove",
        entryIdHex: entry.entryIdHex,
        recursive: entry.kind === "directory",
      }),
    );

  const creations = target.entries
    .filter(
      (entry) =>
        entry.entryIdHex !== target.rootEntryIdHex &&
        !lowerById.has(entry.entryIdHex),
    )
    .sort((left, right) => {
      const depthDifference = depth(left.path) - depth(right.path);
      return depthDifference || left.path.localeCompare(right.path);
    })
    .map((entry): CommitOperation => createOperation(entry));

  const updates = target.entries
    .filter((entry) => entry.kind === "file" && lowerById.has(entry.entryIdHex))
    .sort((left, right) => left.path.localeCompare(right.path))
    .flatMap((entry): CommitOperation[] => {
      const before = lowerById.get(entry.entryIdHex)!;
      const oldContent = before.content;
      const newContent = resolvedContent(entry);
      if (
        before.kind !== "file" ||
        !oldContent ||
        before.path !== entry.path ||
        (oldContent.fidHex === newContent.fidHex &&
          oldContent.size === newContent.size &&
          before.mtimeMs === entry.mtimeMs)
      ) {
        return [];
      }
      return [
        {
          kind: "set-file-content",
          entryIdHex: entry.entryIdHex,
          expectedContentFidHex: oldContent.fidHex,
          content: newContent,
          mtimeMs: entry.mtimeMs,
        },
      ];
    });
  return [...removals, ...creations, ...updates];
}

interface LowerPathEntry extends IndexedEntry {
  path: string;
}

function flattenLower(index: EntryIndex): Map<string, LowerPathEntry> {
  const root = index.get(index.rootEntryIdHex);
  if (!root) throw new Error("Lower root is missing.");
  const result = new Map<string, LowerPathEntry>();
  const visit = (entry: IndexedEntry, path: string): void => {
    result.set(entry.entryIdHex, { ...entry, path });
    if (entry.kind === "directory") {
      for (const child of index.listChildren(entry.entryIdHex)) {
        visit(child, path ? `${path}/${child.name}` : child.name);
      }
    }
  };
  visit(root, "");
  return result;
}

function createOperation(entry: TargetTreeEntry): CommitOperation {
  if (!entry.parentEntryIdHex) {
    throw new Error(`Created Entry has no parent: ${entry.path}`);
  }
  if (entry.kind === "directory") {
    return {
      kind: "create-directory",
      entryIdHex: entry.entryIdHex,
      parentEntryIdHex: entry.parentEntryIdHex,
      name: entry.name,
      mtimeMs: entry.mtimeMs,
    };
  }
  return {
    kind: "create-file",
    entryIdHex: entry.entryIdHex,
    parentEntryIdHex: entry.parentEntryIdHex,
    name: entry.name,
    content: resolvedContent(entry),
    mtimeMs: entry.mtimeMs,
  };
}

function resolvedContent(entry: TargetTreeEntry): FileContentRef {
  if (entry.kind !== "file" || entry.content?.source !== "lower") {
    throw new Error(`Target content is unresolved: ${entry.path}`);
  }
  return entry.content.ref;
}

function depth(path: string): number {
  return path === "" ? 0 : path.split("/").length;
}
