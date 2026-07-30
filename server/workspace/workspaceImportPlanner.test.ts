import { describe, expect, it } from "vitest";
import { EntryIndex, type IndexedEntry } from "../files/entryIndex.js";
import { planWorkspaceImport } from "./workspaceImportPlanner.js";

const sourceRoot = "01".repeat(16);
const sourceDirectory = "02".repeat(16);
const sourceFile = "03".repeat(16);
const sourceNested = "04".repeat(16);
const mainRoot = "10".repeat(16);
const destination = "11".repeat(16);
const existing = "12".repeat(16);

describe("planWorkspaceImport", () => {
  it("recursively copies top-level selections and reuses immutable content refs", () => {
    const ids = [id(0x20), id(0x21)];
    const plan = planWorkspaceImport({
      source: sourceIndex(),
      main: mainIndex(),
      selectedEntryIdsHex: [sourceDirectory, sourceNested],
      destinationEntryIdHex: destination,
      conflictPolicy: "cancel",
      randomId: () => ids.shift()!,
    });

    expect(plan.roots).toEqual([
      {
        sourceEntryIdHex: sourceDirectory,
        newEntryIdHex: "20".repeat(16),
        name: "docs",
      },
    ]);
    expect(plan.operations).toEqual([
      {
        kind: "create-directory",
        entryIdHex: "20".repeat(16),
        parentEntryIdHex: destination,
        name: "docs",
        mtimeMs: 10,
      },
      {
        kind: "create-file",
        entryIdHex: "21".repeat(16),
        parentEntryIdHex: "20".repeat(16),
        name: "note.txt",
        content: {
          kind: "chunk",
          fidHex: "aa".repeat(16),
          size: 5,
        },
        mtimeMs: 10,
      },
    ]);
  });

  it("cancels conflicts or allocates deterministic extension-aware names", () => {
    expect(() =>
      planWorkspaceImport({
        source: sourceIndex("report.txt"),
        main: mainIndex("REPORT.TXT"),
        selectedEntryIdsHex: [sourceFile],
        destinationEntryIdHex: destination,
        conflictPolicy: "cancel",
      }),
    ).toThrow("already contains");

    const plan = planWorkspaceImport({
      source: sourceIndex("report.txt"),
      main: mainIndex("REPORT.TXT"),
      selectedEntryIdsHex: [sourceFile],
      destinationEntryIdHex: destination,
      conflictPolicy: "rename",
      randomId: () => id(0x30),
    });
    expect(plan.roots[0]?.name).toBe("report (Workspace).txt");
    expect(plan.operations[0]).toMatchObject({
      name: "report (Workspace).txt",
    });
  });

  it("rejects duplicate, root, missing, and over-limit selections", () => {
    const common = {
      source: sourceIndex(),
      main: mainIndex(),
      destinationEntryIdHex: destination,
      conflictPolicy: "cancel" as const,
    };
    expect(() =>
      planWorkspaceImport({
        ...common,
        selectedEntryIdsHex: [sourceFile, sourceFile],
      }),
    ).toThrow("duplicates");
    expect(() =>
      planWorkspaceImport({
        ...common,
        selectedEntryIdsHex: [sourceRoot],
      }),
    ).toThrow("invalid");
    expect(() =>
      planWorkspaceImport({
        ...common,
        selectedEntryIdsHex: [sourceDirectory],
        maxEntries: 1,
      }),
    ).toThrow("limit");
  });
});

function sourceIndex(fileName = "loose.txt"): EntryIndex {
  return new EntryIndex(1, [
    directory(sourceRoot, null, ""),
    directory(sourceDirectory, sourceRoot, "docs"),
    file(sourceNested, sourceDirectory, "note.txt"),
    file(sourceFile, sourceRoot, fileName),
  ]);
}

function mainIndex(existingName = "existing.txt"): EntryIndex {
  return new EntryIndex(7, [
    directory(mainRoot, null, ""),
    directory(destination, mainRoot, "imports"),
    file(existing, destination, existingName),
  ]);
}

function directory(
  entryIdHex: string,
  parentEntryIdHex: string | null,
  name: string,
): IndexedEntry {
  return {
    entryIdHex,
    parentEntryIdHex,
    name,
    kind: "directory",
    createdAtMs: 1,
    mtimeMs: 10,
  };
}

function file(
  entryIdHex: string,
  parentEntryIdHex: string,
  name: string,
): IndexedEntry {
  return {
    ...directory(entryIdHex, parentEntryIdHex, name),
    kind: "file",
    content: { kind: "chunk", fidHex: "aa".repeat(16), size: 5 },
  };
}

function id(byte: number): Uint8Array {
  return Uint8Array.from({ length: 16 }, () => byte);
}
