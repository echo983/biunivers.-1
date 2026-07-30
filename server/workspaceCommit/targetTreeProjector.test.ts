import { describe, expect, it } from "vitest";
import { EntryIndex, type IndexedEntry } from "../files/entryIndex.js";
import { TargetTreeProjector } from "./targetTreeProjector.js";
import type { UpperScanEntry } from "./upperScanner.js";

const rootId = "01".repeat(16);
const docsId = "02".repeat(16);
const oldId = "03".repeat(16);
const noteId = "04".repeat(16);
const removedId = "05".repeat(16);

const lowerEntries: IndexedEntry[] = [
  directory(rootId, null, ""),
  directory(docsId, rootId, "docs"),
  file(oldId, docsId, "old.txt", "a1".repeat(16), 3),
  file(noteId, rootId, "note.txt", "a2".repeat(16), 4),
  file(removedId, rootId, "removed.txt", "a3".repeat(16), 5),
];

describe("TargetTreeProjector", () => {
  it("applies opaque, whiteout, modification and addition deterministically", () => {
    let id = 0x10;
    const projector = new TargetTreeProjector({
      randomId: () => Buffer.alloc(16, id++),
      now: () => 1_000,
    });
    const upper: UpperScanEntry[] = [
      change("docs", "directory", 0, true, 2_000),
      change("docs/new.txt", "file", 7, false, 2_001),
      change("note.txt", "file", 9, false, 2_002),
      change("removed.txt", "whiteout", 0, false, 2_003),
      change("top.txt", "file", 11, false, 2_004),
    ];

    const result = projector.project(new EntryIndex(7, lowerEntries), upper);

    expect(result.revision).toBe(8);
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "",
      "docs",
      "docs/new.txt",
      "note.txt",
      "top.txt",
    ]);
    const docs = result.entries.find((entry) => entry.path === "docs")!;
    expect(docs.entryIdHex).not.toBe(docsId);
    expect(docs.createdAtMs).toBe(1_000);
    expect(result.entries.find((entry) => entry.path === "note.txt")).toMatchObject({
      entryIdHex: noteId,
      createdAtMs: 10,
      mtimeMs: 2_002,
      content: { source: "upper", path: "note.txt", size: 9 },
    });
    expect(result.entries.find((entry) => entry.path === "top.txt")).toMatchObject({
      parentEntryIdHex: rootId,
      createdAtMs: 1_000,
    });
    expect(result.entries.some((entry) => entry.path === "docs/old.txt")).toBe(
      false,
    );
  });

  it("rejects orphan changes, nonexistent whiteouts and ID allocation failure", () => {
    const lower = new EntryIndex(0, lowerEntries);
    const projector = new TargetTreeProjector({
      randomId: () => new Uint8Array(16),
    });
    expect(() =>
      projector.project(lower, [
        change("missing/file", "file", 1, false, 1),
      ]),
    ).toThrow("parent");
    expect(() =>
      projector.project(lower, [
        change("missing", "whiteout", 0, false, 1),
      ]),
    ).toThrow("does not exist");
    expect(() =>
      projector.project(lower, [change("new", "file", 1, false, 1)]),
    ).toThrow("allocate");
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
    entryIdHex,
    parentEntryIdHex,
    name,
    kind: "file",
    createdAtMs: 10,
    mtimeMs: 10,
    content: { kind: "chunk", fidHex, size },
  };
}

function change(
  path: string,
  kind: UpperScanEntry["kind"],
  size: number,
  opaque: boolean,
  mtimeMs: number,
): UpperScanEntry {
  return {
    path,
    kind,
    size,
    opaque,
    mtimeNs: String(mtimeMs * 1_000_000),
  };
}
