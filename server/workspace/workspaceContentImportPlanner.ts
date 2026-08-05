import { randomBytes } from "node:crypto";
import type { BatchFileSystemOperation } from "../files/batchFileSystemSegment.js";
import type { EntryIndex, IndexedEntry } from "../files/entryIndex.js";

export interface WorkspaceContentImportPlan {
  operations: BatchFileSystemOperation[];
  roots: Array<{ sourceEntryIdHex: string; newEntryIdHex: string; name: string }>;
}

export function planWorkspaceContentImport(input: {
  main: EntryIndex;
  workspace: EntryIndex;
  selectedEntryIdsHex: readonly string[];
  destinationEntryIdHex: string;
  randomId?: () => Uint8Array;
  maxEntries?: number;
}): WorkspaceContentImportPlan {
  const destination = input.workspace.get(input.destinationEntryIdHex);
  if (!destination || destination.kind !== "directory") {
    throw new Error("Import destination is not a Workspace directory.");
  }
  const selected = normalizeSelection(input.main, input.selectedEntryIdsHex);
  const randomId = input.randomId ?? (() => randomBytes(16));
  const maxEntries = input.maxEntries ?? 10_000;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error("Workspace content import entry limit is invalid.");
  }
  const reservedNames = new Set(
    input.workspace.listChildren(destination.entryIdHex).map((entry) => fold(entry.name)),
  );
  const allocatedIds = new Set<string>();
  const operations: BatchFileSystemOperation[] = [];
  const roots: WorkspaceContentImportPlan["roots"] = [];

  const append = (source: IndexedEntry, parentEntryIdHex: string, name: string): string => {
    if (operations.length >= maxEntries) {
      throw new Error("Workspace content import exceeds its entry limit.");
    }
    const entryIdHex = allocateId(input.workspace, allocatedIds, randomId);
    if (source.kind === "directory") {
      operations.push({
        kind: "create-directory", entryIdHex, parentEntryIdHex, name, mtimeMs: source.mtimeMs,
      });
      for (const child of input.main.listChildren(source.entryIdHex)) {
        append(child, entryIdHex, child.name);
      }
    } else {
      if (!source.content) throw new Error(`Main file has no content: ${source.name}`);
      operations.push({
        kind: "create-file", entryIdHex, parentEntryIdHex, name,
        content: { ...source.content }, mtimeMs: source.mtimeMs,
      });
    }
    return entryIdHex;
  };

  for (const entry of selected) {
    const name = availableName(entry.name, reservedNames);
    reservedNames.add(fold(name));
    roots.push({
      sourceEntryIdHex: entry.entryIdHex,
      newEntryIdHex: append(entry, destination.entryIdHex, name),
      name,
    });
  }
  return { operations, roots };
}

function normalizeSelection(index: EntryIndex, ids: readonly string[]): IndexedEntry[] {
  if (ids.length === 0) throw new Error("Workspace content import selection is empty.");
  if (new Set(ids).size !== ids.length) throw new Error("Workspace content import selection contains duplicates.");
  const entries = ids.map((id) => {
    const entry = index.get(id);
    if (!entry || entry.parentEntryIdHex === null) throw new Error("Workspace content import selection is invalid.");
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

function availableName(requested: string, reserved: Set<string>): string {
  if (!reserved.has(fold(requested))) return requested;
  const { stem, extension } = splitExtension(requested);
  for (let index = 1; index <= 10_000; index += 1) {
    const suffix = index === 1 ? " (main)" : ` (main ${index})`;
    const candidate = `${stem}${suffix}${extension}`;
    if (!reserved.has(fold(candidate))) return candidate;
  }
  throw new Error(`Could not allocate a Workspace import name: ${requested}`);
}

function splitExtension(name: string) {
  const separator = name.lastIndexOf(".");
  return separator > 0
    ? { stem: name.slice(0, separator), extension: name.slice(separator) }
    : { stem: name, extension: "" };
}

function allocateId(index: EntryIndex, allocated: Set<string>, randomId: () => Uint8Array): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const bytes = randomId();
    if (bytes.byteLength !== 16 || bytes.every((byte) => byte === 0)) continue;
    const value = Buffer.from(bytes).toString("hex");
    if (!index.has(value) && !allocated.has(value)) {
      allocated.add(value);
      return value;
    }
  }
  throw new Error("Could not allocate a Workspace Entry ID.");
}

function fold(value: string): string {
  return value.toLocaleLowerCase("und");
}
