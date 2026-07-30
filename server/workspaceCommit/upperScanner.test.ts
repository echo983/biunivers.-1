import { describe, expect, it, vi } from "vitest";
import { UpperScanner, type UpperScannerExecutor } from "./upperScanner.js";

const runIdHex = "11".repeat(16);
const upperPath = `/var/lib/biunivers/runs/${runIdHex}/upper`;
const limits = {
  maxEntries: 100,
  maxDepth: 10,
  maxFileBytes: 1024,
  maxTotalBytes: 4096,
};

describe("UpperScanner", () => {
  it("executes only the fixed native scanner and validates normalized output", async () => {
    const execute = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            path: "docs",
            kind: "directory",
            size: 0,
            mtimeNs: "100",
            opaque: true,
          },
          {
            path: "docs/readme.txt",
            kind: "file",
            size: 5,
            mtimeNs: "101",
            opaque: false,
          },
        ],
        totalFileBytes: 5,
      }),
      stderr: "",
    });
    const scanner = new UpperScanner({
      binary: "/opt/biunivers/bin/biunivers-workspace-cow-scan",
      executor: { execute } as UpperScannerExecutor,
    });

    await expect(scanner.scan({ runIdHex, upperPath, limits })).resolves.toMatchObject({
      totalFileBytes: 5,
      entries: [{ kind: "directory" }, { kind: "file" }],
    });
    expect(execute).toHaveBeenCalledWith(
      "/opt/biunivers/bin/biunivers-workspace-cow-scan",
      [upperPath, "100", "10", "1024", "4096"],
      { timeoutMs: 30_000, maxOutputBytes: 16 * 1024 * 1024 },
    );
  });

  it.each([
    {
      schemaVersion: 1,
      entries: [
        { path: "../escape", kind: "file", size: 1, mtimeNs: "1", opaque: false },
      ],
      totalFileBytes: 1,
    },
    {
      schemaVersion: 1,
      entries: [
        { path: "b", kind: "file", size: 1, mtimeNs: "1", opaque: false },
        { path: "a", kind: "file", size: 1, mtimeNs: "1", opaque: false },
      ],
      totalFileBytes: 2,
    },
    {
      schemaVersion: 1,
      entries: [
        { path: "file", kind: "file", size: 1, mtimeNs: "1", opaque: true },
      ],
      totalFileBytes: 1,
    },
  ])("fails closed on malformed native output", async (output) => {
    const scanner = new UpperScanner({
      binary: "/opt/biunivers/bin/biunivers-workspace-cow-scan",
      executor: {
        execute: vi.fn().mockResolvedValue({
          stdout: JSON.stringify(output),
          stderr: "",
        }),
      },
    });
    await expect(scanner.scan({ runIdHex, upperPath, limits })).rejects.toThrow(
      "invalid result",
    );
  });
});
