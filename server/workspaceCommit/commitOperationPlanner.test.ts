import { describe, expect, it } from "vitest";
import { EntryIndex, type IndexedEntry } from "../files/entryIndex.js";
import { planCommitOperations } from "./commitOperationPlanner.js";
import type { TargetTree } from "./targetTreeProjector.js";

const root = "01".repeat(16);
const oldDirectory = "02".repeat(16);
const oldChild = "03".repeat(16);
const modified = "04".repeat(16);
const removed = "05".repeat(16);
const newDirectory = "06".repeat(16);
const newFile = "07".repeat(16);

describe("planCommitOperations", () => {
  it("plans minimal recursive removals, parent-first creates, and content updates", () => {
    const lower = new EntryIndex(4, [
      directory(root, null, ""),
      directory(oldDirectory, root, "old"),
      file(oldChild, oldDirectory, "child", "aa".repeat(16), 1),
      file(modified, root, "modified", "bb".repeat(16), 2),
      file(removed, root, "removed", "cc".repeat(16), 3),
    ]);
    const target: TargetTree = {
      revision: 5,
      rootEntryIdHex: root,
      entries: [
        targetDirectory(root, null, "", ""),
        targetFile(modified, root, "modified", "modified", "dd".repeat(16), 4),
        targetDirectory(newDirectory, root, "new", "new"),
        targetFile(
          newFile,
          newDirectory,
          "result",
          "new/result",
          "ee".repeat(16),
          5,
        ),
      ],
    };

    expect(planCommitOperations(lower, target)).toEqual([
      { kind: "remove", entryIdHex: oldDirectory, recursive: true },
      { kind: "remove", entryIdHex: removed, recursive: false },
      {
        kind: "create-directory",
        entryIdHex: newDirectory,
        parentEntryIdHex: root,
        name: "new",
        mtimeMs: 20,
      },
      {
        kind: "create-file",
        entryIdHex: newFile,
        parentEntryIdHex: newDirectory,
        name: "result",
        content: { kind: "chunk", fidHex: "ee".repeat(16), size: 5 },
        mtimeMs: 20,
      },
      {
        kind: "set-file-content",
        entryIdHex: modified,
        expectedContentFidHex: "bb".repeat(16),
        content: { kind: "chunk", fidHex: "dd".repeat(16), size: 4 },
        mtimeMs: 20,
      },
    ]);
  });

  it("rejects unresolved content and mismatched target identity", () => {
    const lower = new EntryIndex(0, [directory(root, null, "")]);
    const unresolved: TargetTree = {
      revision: 1,
      rootEntryIdHex: root,
      entries: [
        targetDirectory(root, null, "", ""),
        {
          ...targetFile(newFile, root, "new", "new", "aa".repeat(16), 1),
          content: { source: "upper", path: "new", size: 1 },
        },
      ],
    };
    expect(() => planCommitOperations(lower, unresolved)).toThrow("unresolved");
    expect(() =>
      planCommitOperations(lower, { ...unresolved, revision: 2 }),
    ).toThrow("identity");
  });

  it("rejects reuse of an existing Entry ID at another path", () => {
    const lower = new EntryIndex(0, [
      directory(root, null, ""),
      file(modified, root, "before", "aa".repeat(16), 1),
    ]);
    const target: TargetTree = {
      revision: 1,
      rootEntryIdHex: root,
      entries: [
        targetDirectory(root, null, "", ""),
        targetFile(modified, root, "after", "after", "aa".repeat(16), 1),
      ],
    };

    expect(() => planCommitOperations(lower, target)).toThrow(
      "identity changed",
    );
  });
});

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
    createdAtMs: 10,
    mtimeMs: 10,
  };
}

function file(
  entryIdHex: string,
  parentEntryIdHex: string,
  name: string,
  fidHex: string,
  size: number,
): IndexedEntry {
  return {
    ...directory(entryIdHex, parentEntryIdHex, name),
    kind: "file",
    content: { kind: "chunk", fidHex, size },
  };
}

function targetDirectory(
  entryIdHex: string,
  parentEntryIdHex: string | null,
  name: string,
  path: string,
) {
  return {
    path,
    entryIdHex,
    parentEntryIdHex,
    name,
    kind: "directory" as const,
    createdAtMs: 10,
    mtimeMs: 20,
  };
}

function targetFile(
  entryIdHex: string,
  parentEntryIdHex: string,
  name: string,
  path: string,
  fidHex: string,
  size: number,
) {
  return {
    ...targetDirectory(entryIdHex, parentEntryIdHex, name, path),
    kind: "file" as const,
    content: {
      source: "lower" as const,
      ref: { kind: "chunk" as const, fidHex, size },
    },
  };
}
