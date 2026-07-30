import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SqliteRefStore,
  WorkspaceRunRecord,
  WorkspaceRunState,
} from "../files/sqliteRefStore.js";
import { ControlRunRecovery } from "./controlRunRecovery.js";
import { RunDirectoryManager } from "./runDirectoryManager.js";

const roots: string[] = [];
const runIdHex = "11".repeat(16);
const workspaceIdHex = "22".repeat(16);
const inputHeadFidHex = "33".repeat(16);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("ControlRunRecovery", () => {
  it("publishes a local STOPPED state missed before daemon interruption", async () => {
    const directories = await localRun("STOPPED");
    const { refStore, transitionWorkspaceRun } = storeWithRun("RUNNING");

    const report = await new ControlRunRecovery({ now: () => 200 }).reconcile(
      directories,
      refStore,
      [runIdHex],
    );

    expect(report).toEqual({ stopped: [runIdHex], failed: [] });
    expect(transitionWorkspaceRun).toHaveBeenCalledWith({
      runIdHex,
      expectedState: "RUNNING",
      newState: "STOPPED",
      timestampMs: 200,
    });
  });

  it("fails an interrupted COMMITTING Run while preserving its local Upper", async () => {
    const directories = await localRun("STOPPED");
    const { refStore, transitionWorkspaceRun } = storeWithRun("COMMITTING");

    const report = await new ControlRunRecovery({ now: () => 200 }).reconcile(
      directories,
      refStore,
      [runIdHex],
    );

    expect(report).toEqual({ stopped: [], failed: [runIdHex] });
    expect(transitionWorkspaceRun).toHaveBeenCalledWith({
      runIdHex,
      expectedState: "COMMITTING",
      newState: "FAILED",
      errorCode: "INTERRUPTED_COW_COMMIT",
      timestampMs: 200,
    });
  });

  it("leaves a queued PREPARING Run without a local directory available to prepare", async () => {
    const directories = await directoryManager();
    const { refStore, transitionWorkspaceRun } = storeWithRun("PREPARING");

    const report = await new ControlRunRecovery({ now: () => 200 }).reconcile(
      directories,
      refStore,
      [],
    );

    expect(report).toEqual({ stopped: [], failed: [] });
    expect(transitionWorkspaceRun).not.toHaveBeenCalled();
  });

  it("fails and releases a started control Run whose local state is missing", async () => {
    const directories = await directoryManager();
    const { refStore, transitionWorkspaceRun } = storeWithRun("RUNNING");

    const report = await new ControlRunRecovery({ now: () => 200 }).reconcile(
      directories,
      refStore,
      [],
    );

    expect(report).toEqual({ stopped: [], failed: [runIdHex] });
    expect(transitionWorkspaceRun).toHaveBeenCalledWith({
      runIdHex,
      expectedState: "RUNNING",
      newState: "FAILED",
      errorCode: "RUNTIME_STATE_MISSING",
      timestampMs: 200,
    });
  });
});

async function localRun(state: "STOPPED" | "FAILED") {
  const directories = await directoryManager();
  await directories.prepare({
    runIdHex,
    workspaceIdHex,
    inputHeadFidHex,
    revision: 0,
    executorId: "system.diagnostic",
  });
  await directories.transition({
    runIdHex,
    expectedState: "PREPARING",
    newState: state,
    ...(state === "FAILED"
      ? { errorCode: "INTERRUPTED_DAEMON_RECOVERY" }
      : {}),
  });
  return directories;
}

async function directoryManager() {
  const root = await mkdtemp(join(tmpdir(), "biunivers-control-recovery-"));
  roots.push(root);
  return new RunDirectoryManager({
    root: join(root, "runs"),
    now: () => 100,
  });
}

function storeWithRun(state: WorkspaceRunState) {
  const transitionWorkspaceRun = vi.fn();
  const run: WorkspaceRunRecord = {
    runIdHex,
    workspaceIdHex,
    executorId: "system.diagnostic",
    inputHeadFidHex,
    outputHeadFidHex: null,
    state,
    runtimeIdentity: state === "PREPARING" ? null : "runtime",
    errorCode: null,
    createdAtMs: 50,
    startedAtMs: state === "PREPARING" ? null : 60,
    finishedAtMs: null,
  };
  const value = {
    listWorkspaces: vi.fn().mockReturnValue([{ workspaceIdHex }]),
    listWorkspaceRuns: vi.fn().mockReturnValue([run]),
    transitionWorkspaceRun,
  };
  return {
    refStore: value as unknown as SqliteRefStore,
    transitionWorkspaceRun,
  };
}
