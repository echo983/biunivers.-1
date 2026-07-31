import type { SqliteRefStore } from "../files/sqliteRefStore.js";
import type { RunDirectoryManager } from "../computeRuntime/runDirectoryManager.js";

export interface BwaHostRecoveryReport {
  failed: string[];
  stoppedInstances: string[];
}

export class BwaHostRecovery {
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  async reconcile(
    directories: RunDirectoryManager,
    refStore: SqliteRefStore,
  ): Promise<BwaHostRecoveryReport> {
    const report: BwaHostRecoveryReport = { failed: [], stoppedInstances: [] };
    for (const application of refStore.listBwaApplications()) {
      for (const instance of refStore.listBwaInstances(application.applicationId)) {
        let unresolvedFailure = false;
        for (const { run } of refStore.listBwaRunBindings(instance.instanceIdHex)) {
          if (run.state === "STOPPED") {
            const local = await directories.inspect(run.runIdHex);
            if (local.state !== "STOPPED") {
              throw new Error("BWA recovery local and control STOPPED states differ.");
            }
            await directories.transition({
              runIdHex: run.runIdHex,
              expectedState: "STOPPED",
              newState: "FAILED",
              errorCode: "INTERRUPTED_BWA_FINALIZE",
            });
            refStore.transitionWorkspaceRun({
              runIdHex: run.runIdHex,
              expectedState: "STOPPED",
              newState: "FAILED",
              errorCode: "INTERRUPTED_BWA_FINALIZE",
              timestampMs: this.#timestamp(),
            });
            report.failed.push(run.runIdHex);
            unresolvedFailure = true;
          } else if (run.state === "FAILED" || run.state === "CONFLICT") {
            unresolvedFailure = true;
          }
        }
        if (unresolvedFailure && instance.desiredState !== "STOPPED") {
          refStore.setBwaInstanceDesiredState(
            instance.instanceIdHex,
            "STOPPED",
            this.#timestamp(),
          );
          report.stoppedInstances.push(instance.instanceIdHex);
        }
      }
    }
    report.failed.sort();
    report.stoppedInstances.sort();
    return report;
  }

  #timestamp(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("BWA recovery timestamp is invalid.");
    }
    return value;
  }
}
