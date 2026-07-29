// @vitest-environment node

import { describe, expect, it } from "vitest";
import { EntryIndex, type IndexedEntry } from "./entryIndex.js";
import { buildDirectoryBreadcrumbs } from "./fileHostService.js";

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
    mtimeMs: 1,
  };
}

describe("FileHostService breadcrumbs", () => {
  it("returns the complete root-relative ancestry for a deep directory", () => {
    const root = directory("11".repeat(16), null, "");
    const parent = directory("22".repeat(16), root.entryIdHex, "Documents");
    const child = directory("33".repeat(16), parent.entryIdHex, "Notes");
    const index = new EntryIndex(3, [root, parent, child]);

    expect(buildDirectoryBreadcrumbs(index, child)).toEqual([
      {
        entryId: parent.entryIdHex,
        name: "Documents",
        kind: "directory",
        mtimeMs: 1,
      },
      {
        entryId: child.entryIdHex,
        name: "Notes",
        kind: "directory",
        mtimeMs: 1,
      },
    ]);
  });

  it("does not duplicate the root in breadcrumbs", () => {
    const root = directory("11".repeat(16), null, "");
    const index = new EntryIndex(0, [root]);
    expect(buildDirectoryBreadcrumbs(index, root)).toEqual([]);
  });
});
