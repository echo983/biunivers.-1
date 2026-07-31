import { randomBytes } from "node:crypto";
import type {
  BwaStopReason,
  SqliteRefStore,
  WorkspaceRunRecord,
} from "../files/sqliteRefStore.js";
import type { BwaRuntimeClient } from "./computeRuntimeLifecycleClient.js";

interface EnvironmentResolver {
  resolveEnvironment(instanceIdHex: string): Promise<Record<string, string>>;
}

export class BwaLifecycleError extends Error {
  constructor(
    public readonly code:
      | "INSTANCE_NOT_RUNNING"
      | "INSTANCE_LIFECYCLE_CONFLICT"
      | "RUNTIME_START_FAILED"
      | "RUNTIME_STOP_FAILED"
      | "RUNTIME_COMMIT_FAILED"
      | "FAILED_RUN_REQUIRED"
      | "FAILED_RUN_DISCARD_FAILED",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BwaLifecycleError";
  }
}

export class BwaLifecycleService {
  readonly #refStore: SqliteRefStore;
  readonly #environment: EnvironmentResolver;
  readonly #runtime: BwaRuntimeClient;
  readonly #now: () => number;
  readonly #randomId: (bytes: number) => Buffer;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(options: {
    refStore: SqliteRefStore;
    environment: EnvironmentResolver;
    runtime: BwaRuntimeClient;
    now?: () => number;
    randomId?: (bytes: number) => Buffer;
  }) {
    this.#refStore = options.refStore;
    this.#environment = options.environment;
    this.#runtime = options.runtime;
    this.#now = options.now ?? Date.now;
    this.#randomId = options.randomId ?? randomBytes;
  }

  async start(instanceIdHex: string): Promise<WorkspaceRunRecord> {
    return await this.#exclusive(instanceIdHex, () => this.#start(instanceIdHex, false));
  }

  async stop(
    instanceIdHex: string,
    reason: BwaStopReason = "USER_STOP",
  ): Promise<WorkspaceRunRecord> {
    return await this.#exclusive(instanceIdHex, () => this.#stop(instanceIdHex, reason));
  }

  async saveAndRestart(instanceIdHex: string): Promise<WorkspaceRunRecord> {
    return await this.#exclusive(instanceIdHex, async () => {
      await this.#stop(instanceIdHex, "SAVE_RESTART");
      return await this.#start(instanceIdHex, true);
    });
  }

  async finalizeExited(instanceIdHex: string): Promise<WorkspaceRunRecord> {
    return await this.#exclusive(instanceIdHex, async () => {
      const active = this.#activeRun(instanceIdHex);
      if (!active || active.state !== "RUNNING") {
        throw new BwaLifecycleError("INSTANCE_NOT_RUNNING", "BWA Instance is not running.");
      }
      this.#refStore.setBwaRunStopReason(active.runIdHex, "EXITED");
      this.#refStore.setBwaInstanceDesiredState(instanceIdHex, "STOPPED", this.#timestamp());
      await this.#runtime.finalizeExited(active.runIdHex);
      const finalized = this.#refStore.getWorkspaceRun(active.runIdHex);
      if (finalized.state === "FAILED") return finalized;
      try {
        await this.#runtime.commit(active.runIdHex);
      } catch (error) {
        throw new BwaLifecycleError(
          "RUNTIME_COMMIT_FAILED",
          "Normally exited BWA changes could not be committed.",
          { cause: error },
        );
      }
      await this.#runtime.destroy(active.runIdHex, false);
      return this.#refStore.getWorkspaceRun(active.runIdHex);
    });
  }

  async publishFailedUpper(instanceIdHex: string, runIdHex: string): Promise<WorkspaceRunRecord> {
    return await this.#exclusive(instanceIdHex, async () => {
      this.#requireFailedRun(instanceIdHex, runIdHex);
      this.#refStore.reopenFailedWorkspaceRun(runIdHex, this.#timestamp());
      try {
        await this.#runtime.reopenFailed(runIdHex);
      } catch (error) {
        this.#failRunIfActive(runIdHex, "FAILED_UPPER_REOPEN_FAILED");
        throw new BwaLifecycleError(
          "RUNTIME_COMMIT_FAILED",
          "Failed BWA Upper could not be prepared for commit.",
          { cause: error },
        );
      }
      try {
        await this.#runtime.commit(runIdHex);
      } catch (error) {
        throw new BwaLifecycleError(
          "RUNTIME_COMMIT_FAILED",
          "Failed BWA Upper could not be committed.",
          { cause: error },
        );
      }
      await this.#runtime.destroy(runIdHex, false);
      return this.#refStore.getWorkspaceRun(runIdHex);
    });
  }

  async discardFailedUpper(instanceIdHex: string, runIdHex: string): Promise<WorkspaceRunRecord> {
    return await this.#exclusive(instanceIdHex, async () => {
      this.#requireFailedRun(instanceIdHex, runIdHex);
      try {
        await this.#runtime.destroy(runIdHex, false);
      } catch (error) {
        throw new BwaLifecycleError(
          "FAILED_RUN_DISCARD_FAILED",
          "Failed BWA Upper could not be deleted.",
          { cause: error },
        );
      }
      return this.#refStore.discardFailedWorkspaceRun(runIdHex, this.#timestamp());
    });
  }

  async #start(
    instanceIdHex: string,
    preserveRunningIntentOnFailure: boolean,
  ): Promise<WorkspaceRunRecord> {
    const instance = this.#refStore.getBwaInstance(instanceIdHex);
    const application = this.#refStore.getBwaApplication(instance.applicationId);
    const environment = await this.#environment.resolveEnvironment(instanceIdHex);
    const runIdHex = this.#id(16, "Run ID");
    const capabilityHex = this.#id(32, "Runtime capability");
    const created = this.#refStore.createBwaWorkspaceRun({
      runIdHex,
      instanceIdHex,
      createdAtMs: this.#timestamp(),
    });
    const workspace = this.#refStore.getWorkspace(instance.workspaceIdHex);
    const ref = this.#refStore.getRef(workspace.refId);
    try {
      await this.#runtime.prepareBwa({
        runIdHex,
        workspaceIdHex: instance.workspaceIdHex,
        inputHeadFidHex: created.run.inputHeadFidHex,
        revision: ref.revision,
        capabilityHex,
        imageReference: `${application.applicationId}@${created.binding.executorDigest}`,
        environment,
      });
      await this.#runtime.start(runIdHex);
      return this.#refStore.getWorkspaceRun(runIdHex);
    } catch (error) {
      await this.#runtime.destroy(runIdHex, true).catch(() => undefined);
      this.#failRunIfActive(runIdHex, "BWA_START_FAILED");
      this.#refStore.setBwaInstanceDesiredState(
        instanceIdHex,
        preserveRunningIntentOnFailure ? "RUNNING" : "STOPPED",
        this.#timestamp(),
      );
      throw new BwaLifecycleError(
        "RUNTIME_START_FAILED",
        "BWA Instance could not be started.",
        { cause: error },
      );
    }
  }

  async #stop(
    instanceIdHex: string,
    reason: BwaStopReason,
  ): Promise<WorkspaceRunRecord> {
    const active = this.#activeRun(instanceIdHex);
    if (!active || active.state !== "RUNNING") {
      throw new BwaLifecycleError("INSTANCE_NOT_RUNNING", "BWA Instance is not running.");
    }
    if (reason === "USER_STOP") {
      this.#refStore.setBwaInstanceDesiredState(instanceIdHex, "STOPPED", this.#timestamp());
    }
    this.#refStore.setBwaRunStopReason(active.runIdHex, reason);
    try {
      await this.#runtime.stop(active.runIdHex);
    } catch (error) {
      this.#failRunIfActive(active.runIdHex, "BWA_STOP_FAILED");
      throw new BwaLifecycleError(
        "RUNTIME_STOP_FAILED",
        "BWA Instance could not be stopped safely.",
        { cause: error },
      );
    }
    try {
      await this.#runtime.commit(active.runIdHex);
    } catch (error) {
      throw new BwaLifecycleError(
        "RUNTIME_COMMIT_FAILED",
        "BWA Workspace changes could not be committed.",
        { cause: error },
      );
    }
    await this.#runtime.destroy(active.runIdHex, false);
    return this.#refStore.getWorkspaceRun(active.runIdHex);
  }

  #activeRun(instanceIdHex: string): WorkspaceRunRecord | undefined {
    const active = this.#refStore
      .listBwaRunBindings(instanceIdHex)
      .map((item) => item.run)
      .filter((run) => !["COMMITTED", "DISCARDED", "CONFLICT", "FAILED"].includes(run.state));
    if (active.length > 1) {
      throw new BwaLifecycleError(
        "INSTANCE_LIFECYCLE_CONFLICT",
        "BWA Instance has multiple active Runs.",
      );
    }
    return active[0];
  }

  #requireFailedRun(instanceIdHex: string, runIdHex: string): WorkspaceRunRecord {
    const item = this.#refStore
      .listBwaRunBindings(instanceIdHex)
      .find(({ run }) => run.runIdHex === runIdHex);
    if (!item || item.run.state !== "FAILED") {
      throw new BwaLifecycleError("FAILED_RUN_REQUIRED", "A FAILED BWA Run is required.");
    }
    return item.run;
  }

  #failRunIfActive(runIdHex: string, errorCode: string): void {
    const run = this.#refStore.getWorkspaceRun(runIdHex);
    if (run.state === "PREPARING" || run.state === "RUNNING" || run.state === "STOPPED") {
      this.#refStore.transitionWorkspaceRun({
        runIdHex,
        expectedState: run.state,
        newState: "FAILED",
        errorCode,
        timestampMs: this.#timestamp(),
      });
    }
  }

  async #exclusive<T>(instanceIdHex: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(instanceIdHex) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#locks.set(instanceIdHex, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(instanceIdHex) === queued) this.#locks.delete(instanceIdHex);
    }
  }

  #timestamp(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("BWA timestamp is invalid.");
    return value;
  }

  #id(bytes: number, label: string): string {
    const value = this.#randomId(bytes);
    if (value.byteLength !== bytes || value.every((byte) => byte === 0)) {
      throw new Error(`${label} generation failed.`);
    }
    return value.toString("hex");
  }
}
