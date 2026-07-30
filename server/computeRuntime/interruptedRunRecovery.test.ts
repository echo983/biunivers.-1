import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InterruptedRunRecovery } from "./interruptedRunRecovery.js";
import { RunDirectoryManager } from "./runDirectoryManager.js";

const roots: string[] = [];
const runIdHex = "11".repeat(16);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("InterruptedRunRecovery", () => {
  it("removes runtime resources in order, marks failure, and preserves Upper", async () => {
    const { directories, upperFile } = await interruptedRun();
    const events: string[] = [];
    const recovery = new InterruptedRunRecovery({
      async removeContainer(id) {
        events.push(`container:${id}`);
      },
      async unmountIfMounted(path) {
        events.push(`unmount:${path.split("/").at(-1)}`);
      },
    });

    const report = await recovery.recover(directories, [runIdHex]);

    expect(report.recovered).toEqual([runIdHex]);
    expect(events).toEqual([
      `container:${runIdHex}`,
      "unmount:merged",
      "unmount:lower",
    ]);
    expect(await directories.inspect(runIdHex)).toMatchObject({
      state: "FAILED",
      errorCode: "INTERRUPTED_DAEMON_RECOVERY",
    });
    expect(await readFile(upperFile, "utf8")).toBe("preserve");
  });

  it("fails closed without changing state when cleanup is uncertain", async () => {
    const { directories } = await interruptedRun();
    const recovery = new InterruptedRunRecovery({
      removeContainer: vi.fn().mockRejectedValue(new Error("docker offline")),
      unmountIfMounted: vi.fn(),
    });

    await expect(recovery.recover(directories, [runIdHex])).rejects.toThrow(
      "docker offline",
    );
    expect(await directories.inspect(runIdHex)).toMatchObject({
      state: "RUNNING",
      errorCode: null,
    });
  });
});

async function interruptedRun() {
  const root = await mkdtemp(join(tmpdir(), "biunivers-recovery-"));
  roots.push(root);
  const directories = new RunDirectoryManager({
    root: join(root, "runs"),
    now: () => 100,
  });
  await directories.prepare({
    runIdHex,
    workspaceIdHex: "22".repeat(16),
    inputHeadFidHex: "33".repeat(16),
    revision: 0,
    executorId: "system.diagnostic",
  });
  await directories.transition({
    runIdHex,
    expectedState: "PREPARING",
    newState: "RUNNING",
    runtimeIdentity: "a".repeat(64),
  });
  const upperFile = join(directories.paths(runIdHex).upper, "result.txt");
  await writeFile(upperFile, "preserve");
  return { directories, upperFile };
}
