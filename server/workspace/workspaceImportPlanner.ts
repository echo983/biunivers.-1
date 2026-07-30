import { randomBytes } from "node:crypto";
import type { BatchFileSystemOperation } from "../files/batchFileSystemSegment.js";
import type { EntryIndex, IndexedEntry } from "../files/entryIndex.js";

export interface WorkspaceImportPlan {
  operations: BatchFileSystemOperation[];
  roots: Array<{
    sourceEntryIdHex: string;
    newEntryIdHex: string;
    name: string;
  }>;
}

export function planWorkspaceImport(input: {
  source: EntryIndex;
  main: EntryIndex;
  selectedEntryIdsHex: readonly string[];
  destinationEntryIdHex: string;
  conflictPolicy: "cancel" | "rename";
  randomId?: () => Uint8Array;
  maxEntries?: number;
}): WorkspaceImportPlan {
  const destination = input.main.get(input.destinationEntryIdHex);
  if (!destination || destination.kind !== "directory") {
    throw new Error("Import destination is not a main directory.");
  }
  const selected = normalizeSelection(input.source, input.selectedEntryIdsHex);
  const randomId = input.randomId ?? (() => randomBytes(16));
  const maxEntries = input.maxEntries ?? 10_000;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error("Workspace import entry limit is invalid.");
  }
  const reservedNames = new Set(
    input.main
      .listChildren(destination.entryIdHex)
      .map((entry) => fold(entry.name)),
  );
  const allocatedIds = new Set<string>();
  const operations: BatchFileSystemOperation[] = [];
  const roots: WorkspaceImportPlan["roots"] = [];

  const append = (
    source: IndexedEntry,
    parentEntryIdHex: string,
    name: string,
  ): string => {
    if (operations.length >= maxEntries) {
      throw new Error("Workspace import exceeds its entry limit.");
    }
    const entryIdHex = allocateId(input.main, allocatedIds, randomId);
    if (source.kind === "directory") {
      operations.push({
        kind: "create-directory",
        entryIdHex,
        parentEntryIdHex,
        name,
        mtimeMs: source.mtimeMs,
      });
      for (const child of input.source.listChildren(source.entryIdHex)) {
        append(child, entryIdHex, child.name);
      }
    } else {
      if (!source.content) {
        throw new Error(`Workspace file has no content: ${source.name}`);
      }
      operations.push({
        kind: "create-file",
        entryIdHex,
        parentEntryIdHex,
        name,
        content: { ...source.content },
        mtimeMs: source.mtimeMs,
      });
    }
    return entryIdHex;
  };

  for (const entry of selected) {
    const name = availableName(
      entry.name,
      reservedNames,
      input.conflictPolicy,
    );
    reservedNames.add(fold(name));
    roots.push({
      sourceEntryIdHex: entry.entryIdHex,
      newEntryIdHex: append(entry, destination.entryIdHex, name),
      name,
    });
  }
  return { operations, roots };
}

function normalizeSelection(
  index: EntryIndex,
  ids: readonly string[],
): IndexedEntry[] {
  if (ids.length === 0) throw new Error("Workspace import selection is empty.");
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    throw new Error("Workspace import selection contains duplicates.");
  }
  const entries = ids.map((id) => {
    const entry = index.get(id);
    if (!entry || entry.parentEntryIdHex === null) {
      throw new Error("Workspace import selection is invalid.");
    }
    return entry;
  });
  const selectedIds = new Set(entries.map((entry) => entry.entryIdHex));
  return entries.filter((entry) => {
    let parentId = entry.parentEntryIdHex;
    while (parentId) {
      if (selectedIds.has(parentId)) return false;
      parentId = index.get(parentId)?.parentEntryIdHex ?? null;
    }
    return true;
  });
}

function availableName(
  requested: string,
  reserved: Set<string>,
  policy: "cancel" | "rename",
): string {
  if (!reserved.has(fold(requested))) return requested;
  if (policy === "cancel") {
    throw new Error(`Main destination already contains: ${requested}`);
  }
  const { stem, extension } = splitExtension(requested);
  for (let index = 1; index <= 10_000; index += 1) {
    const suffix = index === 1 ? " (Workspace)" : ` (Workspace ${index})`;
    const candidate = `${stem}${suffix}${extension}`;
    if (!reserved.has(fold(candidate))) return candidate;
  }
  throw new Error(`Could not allocate an import name: ${requested}`);
}

function splitExtension(name: string): { stem: string; extension: string } {
  const separator = name.lastIndexOf(".");
  return separator > 0
    ? { stem: name.slice(0, separator), extension: name.slice(separator) }
    : { stem: name, extension: "" };
}

function allocateId(
  main: EntryIndex,
  allocated: Set<string>,
  randomId: () => Uint8Array,
): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const bytes = randomId();
    if (bytes.byteLength !== 16 || bytes.every((byte) => byte === 0)) continue;
    const value = Buffer.from(bytes).toString("hex");
    if (!main.has(value) && !allocated.has(value)) {
      allocated.add(value);
      return value;
    }
  }
  throw new Error("Could not allocate a main Entry ID.");
}

function fold(value: string): string {
  return value.toLocaleLowerCase("und");
}
