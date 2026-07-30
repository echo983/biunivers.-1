import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RunDirectoryError,
  RunDirectoryManager,
} from "./runDirectoryManager.js";

const temporaryRoots: string[] = [];
const runIdHex = "11".repeat(16);
const workspaceIdHex = "22".repeat(16);

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function setup() {
  const temporary = await mkdtemp(join(tmpdir(), "biunivers-runtime-"));
  temporaryRoots.push(temporary);
  let now = 100;
  const manager = new RunDirectoryManager({
    root: join(temporary, "runs"),
    now: () => now++,
  });
  return { temporary, manager };
}

describe("RunDirectoryManager", () => {
  it("atomically prepares the fixed private Run layout and transitions its manifest", async () => {
    const { manager } = await setup();
    const prepared = await manager.prepare({
      runIdHex,
      workspaceIdHex,
      inputHeadFidHex: "33".repeat(16),
      revision: 7,
      executorId: "system.diagnostic",
    });
    expect(prepared.manifest).toMatchObject({
      state: "PREPARING",
      runtimeIdentity: null,
      createdAtMs: 100,
    });
    for (const path of [
      prepared.paths.root,
      prepared.paths.lower,
      prepared.paths.upper,
      prepared.paths.work,
      prepared.paths.merged,
    ]) {
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    }
    expect((await stat(prepared.paths.manifest)).mode & 0o777).toBe(0o600);

    const transitioned = await manager.transition({
      runIdHex,
      expectedState: "PREPARING",
      newState: "PREPARED",
      runtimeIdentity: "runtime-1",
    });
    expect(transitioned).toMatchObject({
      state: "PREPARED",
      runtimeIdentity: "runtime-1",
      updatedAtMs: 101,
    });
    expect(await manager.inspect(runIdHex)).toEqual(transitioned);
    await expect(
      manager.transition({
        runIdHex,
        expectedState: "PREPARING",
        newState: "RUNNING",
      }),
    ).rejects.toMatchObject<Partial<RunDirectoryError>>({
      code: "RUN_STATE_CONFLICT",
    });
    await expect(
      manager.prepare({
        runIdHex,
        workspaceIdHex,
        inputHeadFidHex: "33".repeat(16),
        revision: 7,
        executorId: "system.diagnostic",
      }),
    ).rejects.toMatchObject<Partial<RunDirectoryError>>({
      code: "RUN_DIRECTORY_EXISTS",
    });
  });

  it("quarantines unknown directories and incomplete prepare debris without deleting them", async () => {
    const { manager } = await setup();
    await manager.prepare({
      runIdHex,
      workspaceIdHex,
      inputHeadFidHex: "33".repeat(16),
      revision: 0,
      executorId: "system.diagnostic",
    });
    const root = manager.paths(runIdHex).root;
    const runsRoot = join(root, "..");
    await mkdir(join(runsRoot, "unknown-upper"), { recursive: true });
    await writeFile(join(runsRoot, "unknown-upper", "result.txt"), "preserve");
    await mkdir(join(runsRoot, ".prepare-interrupted"), { recursive: true });

    const report = await manager.reconcile(new Set([runIdHex]));
    expect(report.known).toEqual([runIdHex]);
    expect(report.quarantined.map((item) => item.name)).toEqual([
      ".prepare-interrupted",
      "unknown-upper",
    ]);
    const preserved = report.quarantined.find(
      (item) => item.name === "unknown-upper",
    )!;
    expect(await readFile(join(preserved.destination, "result.txt"), "utf8")).toBe(
      "preserve",
    );
    expect(await readdir(join(runsRoot, ".quarantine"))).toHaveLength(2);
  });

  it("fails closed on a corrupt known manifest and leaves its Upper untouched", async () => {
    const { manager } = await setup();
    const prepared = await manager.prepare({
      runIdHex,
      workspaceIdHex,
      inputHeadFidHex: "33".repeat(16),
      revision: 0,
      executorId: "system.diagnostic",
    });
    await writeFile(join(prepared.paths.upper, "important.txt"), "keep");
    await writeFile(prepared.paths.manifest, "{}");

    await expect(
      manager.reconcile(new Set([runIdHex])),
    ).rejects.toMatchObject<Partial<RunDirectoryError>>({
      code: "RUN_DIRECTORY_CORRUPT",
    });
    expect(
      await readFile(join(prepared.paths.upper, "important.txt"), "utf8"),
    ).toBe("keep");
  });

  it("destroys only terminal Runs and obeys the explicit Upper policy", async () => {
    const { manager } = await setup();
    const preserved = await manager.prepare({
      runIdHex,
      workspaceIdHex,
      inputHeadFidHex: "33".repeat(16),
      revision: 0,
      executorId: "system.diagnostic",
    });
    await writeFile(join(preserved.paths.upper, "result.txt"), "keep");
    await expect(manager.destroy(runIdHex, true)).rejects.toMatchObject({
      code: "RUN_STATE_CONFLICT",
    });
    await manager.transition({
      runIdHex,
      expectedState: "PREPARING",
      newState: "STOPPED",
    });
    await manager.destroy(runIdHex, true);
    expect(await manager.inspect(runIdHex)).toMatchObject({
      state: "DESTROYED",
    });
    expect(await readFile(join(preserved.paths.upper, "result.txt"), "utf8")).toBe(
      "keep",
    );
    expect((await readdir(preserved.paths.root)).sort()).toEqual([
      "runtime.json",
      "upper",
    ].sort());

    const deletedId = "44".repeat(16);
    const deleted = await manager.prepare({
      runIdHex: deletedId,
      workspaceIdHex,
      inputHeadFidHex: "33".repeat(16),
      revision: 0,
      executorId: "system.diagnostic",
    });
    await writeFile(join(deleted.paths.upper, "discard.txt"), "discard");
    await manager.transition({
      runIdHex: deletedId,
      expectedState: "PREPARING",
      newState: "FAILED",
      errorCode: "TEST_FAILURE",
    });
    await manager.destroy(deletedId, false);
    await expect(manager.inspect(deletedId)).rejects.toMatchObject({
      code: "RUN_DIRECTORY_NOT_FOUND",
    });
  });

  it("rejects broad, relative, or unresolved Run roots", () => {
    for (const root of ["/", "relative/runs", "/tmp/../etc/runs"]) {
      expect(() => new RunDirectoryManager({ root })).toThrowError(
        expect.objectContaining<Partial<RunDirectoryError>>({
          code: "INVALID_RUNTIME_VALUE",
        }),
      );
    }
  });
});
