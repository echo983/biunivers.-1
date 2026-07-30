import { describe, expect, it } from "vitest";
import { EntryIndex, type IndexedEntry } from "../files/entryIndex.js";
import { projectStableInodes } from "./workspaceSnapshotProvider.js";

describe("Workspace Snapshot scale benchmark", () => {
  it.each([1_000, 10_000])(
    "projects %i small files with stable inodes",
    (fileCount) => {
      const index = syntheticIndex(fileCount);
      const startedAt = performance.now();
      const first = projectStableInodes(index);
      const elapsedMs = performance.now() - startedAt;
      const second = projectStableInodes(index);

      expect(first).toHaveLength(fileCount + 1);
      expect(second).toEqual(first);
      expect(first[0]).toMatchObject({ inode: 1, parentInode: null });
      expect(
        first.slice(1).every((entry, position) => entry.inode === position + 2),
      ).toBe(true);
      console.info(
        `Workspace Snapshot projected ${fileCount} files in ${elapsedMs.toFixed(2)} ms`,
      );
    },
    10_000,
  );
});

function syntheticIndex(fileCount: number): EntryIndex {
  const rootEntryIdHex = idHex(fileCount + 1);
  const entries: IndexedEntry[] = [
    {
      entryIdHex: rootEntryIdHex,
      parentEntryIdHex: null,
      name: "",
      kind: "directory",
      createdAtMs: 1,
      mtimeMs: 1,
    },
  ];
  for (let index = 0; index < fileCount; index += 1) {
    entries.push({
      entryIdHex: idHex(fileCount - index),
      parentEntryIdHex: rootEntryIdHex,
      name: `file-${String(index).padStart(5, "0")}.txt`,
      kind: "file",
      createdAtMs: 1,
      mtimeMs: 1,
      content: {
        kind: "chunk",
        fidHex: idHex(index + 20_000),
        size: 16,
      },
    });
  }
  return new EntryIndex(0, entries);
}

function idHex(value: number): string {
  return value.toString(16).padStart(32, "0");
}
