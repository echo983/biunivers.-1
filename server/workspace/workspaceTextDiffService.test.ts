import { describe, expect, it } from "vitest";
import {
  createUnifiedDiff,
  renderTextDiff,
} from "./workspaceTextDiffService.js";

describe("createUnifiedDiff", () => {
  it("emits a deterministic unified text diff", () => {
    expect(
      createUnifiedDiff(
        "notes/readme.md",
        ["title", "old line", "same"],
        ["title", "new line", "same", "added"],
      ),
    ).toBe(
      [
        "--- baseline/notes/readme.md",
        "+++ current/notes/readme.md",
        "@@ -1,3 +1,4 @@",
        " title",
        "-old line",
        "+new line",
        " same",
        "+added",
        "",
      ].join("\n"),
    );
  });

  it("handles empty files and repeated lines", () => {
    expect(createUnifiedDiff("empty.txt", [], ["hello"])).toContain(
      "@@ -1,0 +1,1 @@\n+hello",
    );
    expect(
      createUnifiedDiff("repeat.txt", ["a", "b", "a"], ["a", "a"]),
    ).toContain("-b");
  });

  it("rejects binary, invalid UTF-8, byte limits, and line limits", () => {
    expect(
      renderTextDiff(
        "binary.bin",
        Uint8Array.from([0, 1]),
        Uint8Array.from([0, 2]),
      ),
    ).toMatchObject({ available: false, reason: "NOT_TEXT" });
    expect(
      renderTextDiff(
        "invalid.txt",
        Uint8Array.from([0xc3, 0x28]),
        Uint8Array.from([0xc3, 0x29]),
      ),
    ).toMatchObject({ available: false, reason: "NOT_TEXT" });
    expect(
      renderTextDiff("large.txt", Buffer.from("before"), Buffer.from("after"), 4),
    ).toMatchObject({ available: false, reason: "TOO_LARGE" });
    expect(
      renderTextDiff(
        "lines.txt",
        Buffer.from("one\ntwo\nthree"),
        Buffer.from("one\ntwo\nfour"),
        100,
        2,
      ),
    ).toMatchObject({ available: false, reason: "TOO_LARGE" });
  });
});
