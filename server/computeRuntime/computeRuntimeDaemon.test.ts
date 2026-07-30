import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertNoInterruptedLocalRuns } from "./computeRuntimeDaemon.js";
import { RunDirectoryManager } from "./runDirectoryManager.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("Compute Runtime startup reconciliation", () => {
  it("fails closed for an interrupted active Run and accepts terminal Runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "biunivers-daemon-"));
    roots.push(root);
    const directories = new RunDirectoryManager({
      root: join(root, "runs"),
      now: () => 10,
    });
    const activeId = "11".repeat(16);
    const terminalId = "22".repeat(16);
    for (const runIdHex of [activeId, terminalId]) {
      await directories.prepare({
        runIdHex,
        workspaceIdHex: "33".repeat(16),
        inputHeadFidHex: "44".repeat(16),
        revision: 0,
        executorId: "system.diagnostic",
      });
    }
    await directories.transition({
      runIdHex: activeId,
      expectedState: "PREPARING",
      newState: "RUNNING",
      runtimeIdentity: "a".repeat(64),
    });
    await directories.transition({
      runIdHex: terminalId,
      expectedState: "PREPARING",
      newState: "FAILED",
      errorCode: "TEST_FAILURE",
    });

    await expect(
      assertNoInterruptedLocalRuns(directories, [activeId, terminalId]),
    ).rejects.toThrow(activeId);
    await expect(
      assertNoInterruptedLocalRuns(directories, [terminalId]),
    ).resolves.toBeUndefined();
  });
});
