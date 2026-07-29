import { describe, expect, it } from "vitest";
import { updateFileSelection, type FileSelection } from "./fileSelection";

const entries = ["a", "b", "c", "d"];
const empty: FileSelection = { entryIds: new Set() };

describe("updateFileSelection", () => {
  it("plain click replaces selection and sets the anchor", () => {
    const result = updateFileSelection(entries, empty, "b", {
      toggle: false,
      range: false,
    });
    expect([...result.entryIds]).toEqual(["b"]);
    expect(result.anchorEntryId).toBe("b");
  });

  it("Ctrl or Command click toggles one entry", () => {
    const first = updateFileSelection(entries, empty, "a", {
      toggle: true,
      range: false,
    });
    const second = updateFileSelection(entries, first, "c", {
      toggle: true,
      range: false,
    });
    const third = updateFileSelection(entries, second, "a", {
      toggle: true,
      range: false,
    });
    expect([...second.entryIds]).toEqual(["a", "c"]);
    expect([...third.entryIds]).toEqual(["c"]);
  });

  it("Shift click replaces selection with the anchor range", () => {
    const current: FileSelection = {
      entryIds: new Set(["b"]),
      anchorEntryId: "b",
    };
    const result = updateFileSelection(entries, current, "d", {
      toggle: false,
      range: true,
    });
    expect([...result.entryIds]).toEqual(["b", "c", "d"]);
    expect(result.anchorEntryId).toBe("b");
  });

  it("Ctrl+Shift adds a range to the current selection", () => {
    const current: FileSelection = {
      entryIds: new Set(["a", "c"]),
      anchorEntryId: "c",
    };
    const result = updateFileSelection(entries, current, "d", {
      toggle: true,
      range: true,
    });
    expect([...result.entryIds]).toEqual(["a", "c", "d"]);
  });
});

