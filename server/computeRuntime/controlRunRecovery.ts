import type {
  SqliteRefStore,
  WorkspaceRunRecord,
} from "../files/sqliteRefStore.js";
import {
  type LocalRunState,
  RunDirectoryManager,
} from "./runDirectoryManager.js";

const TERMINAL_CONTROL_STATES = new Set([
  "COMMITTED",
  "CONFLICT",
  "FAILED",
  "DISCARDED",
]);

export interface ControlRunRecoveryReport {
  stopped: string[];
  failed: string[];
}

export class ControlRunRecovery {
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  async reconcile(
    directories: RunDirectoryManager,
    refStore: SqliteRefStore,
    localRunIds: readonly string[],
  ): Promise<ControlRunRecoveryReport> {
    const local = new Set(localRunIds);
    const report: ControlRunRecoveryReport = { stopped: [], failed: [] };
    const runs = refStore
      .listWorkspaces()
      .flatMap((workspace) =>
        refStore.listWorkspaceRuns(workspace.workspaceIdHex),
      );
    for (const run of runs) {
      if (TERMINAL_CONTROL_STATES.has(run.state)) continue;
      if (!local.has(run.runIdHex)) {
        if (run.state === "PREPARING") continue;
        this.#fail(refStore, run, "RUNTIME_STATE_MISSING");
        report.failed.push(run.runIdHex);
        continue;
      }
      const manifest = await directories.inspect(run.runIdHex);
      assertSameRun(run, manifest);
      if (manifest.state === "STOPPED" && run.state === "RUNNING") {
        refStore.transitionWorkspaceRun({
          runIdHex: run.runIdHex,
          expectedState: "RUNNING",
          newState: "STOPPED",
          timestampMs: this.#timestamp(),
        });
        report.stopped.push(run.runIdHex);
      } else if (
        manifest.state === "FAILED" ||
        manifest.state === "DESTROYED" ||
        run.state === "COMMITTING" ||
        (manifest.state === "STOPPED" && run.state === "PREPARING")
      ) {
        this.#fail(refStore, run, recoveryCode(manifest.state, run.state));
        report.failed.push(run.runIdHex);
      } else if (
        manifest.state !== "STOPPED" ||
        run.state !== "STOPPED"
      ) {
        throw new Error(
          `Runtime recovery left inconsistent Run states: ${run.runIdHex}`,
        );
      }
    }
    report.stopped.sort();
    report.failed.sort();
    return report;
  }

  #fail(
    refStore: SqliteRefStore,
    run: WorkspaceRunRecord,
    errorCode: string,
  ): void {
    refStore.transitionWorkspaceRun({
      runIdHex: run.runIdHex,
      expectedState: run.state,
      newState: "FAILED",
      errorCode,
      timestampMs: this.#timestamp(),
    });
  }

  #timestamp(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Runtime recovery timestamp is invalid.");
    }
    return value;
  }
}

function assertSameRun(
  run: WorkspaceRunRecord,
  manifest: {
    workspaceIdHex: string;
    inputHeadFidHex: string;
    executorId: string;
  },
): void {
  if (
    manifest.workspaceIdHex !== run.workspaceIdHex ||
    manifest.inputHeadFidHex !== run.inputHeadFidHex ||
    manifest.executorId !== run.executorId
  ) {
    throw new Error(`Local and control Run identity differ: ${run.runIdHex}`);
  }
}

function recoveryCode(
  localState: LocalRunState,
  controlState: WorkspaceRunRecord["state"],
): string {
  return controlState === "COMMITTING"
    ? "INTERRUPTED_COW_COMMIT"
    : localState === "DESTROYED"
      ? "RUNTIME_DESTROYED_EARLY"
      : "INTERRUPTED_DAEMON_RECOVERY";
}
