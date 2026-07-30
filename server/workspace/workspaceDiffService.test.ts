import { describe, expect, it } from "vitest";
import { EntryIndex, type IndexedEntry } from "../files/entryIndex.js";
import { compareIndexes } from "./workspaceDiffService.js";

const root = "01".repeat(16);
const directoryId = "02".repeat(16);
const unchangedId = "03".repeat(16);
const modifiedId = "04".repeat(16);
const deletedId = "05".repeat(16);
const addedId = "06".repeat(16);

describe("compareIndexes", () => {
  it("reports deterministic path-based additions, modifications, and deletions", () => {
    const baseline = index(0, [
      directory(root, null, ""),
      directory(directoryId, root, "docs"),
      file(unchangedId, directoryId, "same.txt", "aa".repeat(16), 4, 10),
      file(modifiedId, root, "changed.txt", "bb".repeat(16), 5, 10),
      file(deletedId, root, "deleted.txt", "cc".repeat(16), 6, 10),
    ]);
    const current = index(1, [
      directory(root, null, ""),
      directory(directoryId, root, "docs"),
      file(unchangedId, directoryId, "same.txt", "aa".repeat(16), 4, 10),
      file(modifiedId, root, "changed.txt", "dd".repeat(16), 7, 20),
      file(addedId, directoryId, "added.txt", "ee".repeat(16), 8, 20),
    ]);

    expect(compareIndexes(baseline, current)).toEqual([
      {
        path: "changed.txt",
        change: "modified",
        before: {
          entryIdHex: modifiedId,
          kind: "file",
          size: 5,
          mtimeMs: 10,
          contentFidHex: "bb".repeat(16),
        },
        after: {
          entryIdHex: modifiedId,
          kind: "file",
          size: 7,
          mtimeMs: 20,
          contentFidHex: "dd".repeat(16),
        },
      },
      {
        path: "deleted.txt",
        change: "deleted",
        before: {
          entryIdHex: deletedId,
          kind: "file",
          size: 6,
          mtimeMs: 10,
          contentFidHex: "cc".repeat(16),
        },
        after: null,
      },
      {
        path: "docs/added.txt",
        change: "added",
        before: null,
        after: {
          entryIdHex: addedId,
          kind: "file",
          size: 8,
          mtimeMs: 20,
          contentFidHex: "ee".repeat(16),
        },
      },
    ]);
  });

  it("treats same-path kind or Entry identity replacement as modification", () => {
    const baseline = index(0, [
      directory(root, null, ""),
      file(modifiedId, root, "node", "aa".repeat(16), 1, 10),
    ]);
    const current = index(1, [
      directory(root, null, ""),
      directory(addedId, root, "node"),
    ]);

    expect(compareIndexes(baseline, current)).toEqual([
      expect.objectContaining({
        path: "node",
        change: "modified",
        before: expect.objectContaining({ kind: "file" }),
        after: expect.objectContaining({ kind: "directory" }),
      }),
    ]);
  });

  it("returns no changes for identical projections and enforces its limit", () => {
    const baseline = index(0, [
      directory(root, null, ""),
      file(unchangedId, root, "same.txt", "aa".repeat(16), 4, 10),
    ]);
    const identical = index(1, [
      directory(root, null, ""),
      file(unchangedId, root, "same.txt", "aa".repeat(16), 4, 10),
    ]);
    expect(compareIndexes(baseline, identical)).toEqual([]);
    expect(() =>
      compareIndexes(
        baseline,
        index(1, [
          directory(root, null, ""),
          file(addedId, root, "other.txt", "bb".repeat(16), 3, 20),
        ]),
        1,
      ),
    ).toThrow("limit");
  });
});

function index(revision: number, entries: IndexedEntry[]): EntryIndex {
  return new EntryIndex(revision, entries);
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
  fidHex: string,
  size: number,
  mtimeMs: number,
): IndexedEntry {
  return {
    ...directory(entryIdHex, parentEntryIdHex, name),
    kind: "file",
    mtimeMs,
    content: { kind: "chunk", fidHex, size },
  };
}
