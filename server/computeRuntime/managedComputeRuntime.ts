import type { SqliteRefStore } from "../files/sqliteRefStore.js";
import type { WorkspaceCommitCoordinator } from "../workspaceCommit/workspaceCommitCoordinator.js";
import type { ComputeRuntimeCoordinator } from "./computeRuntimeCoordinator.js";
import type { RunDirectoryManager } from "./runDirectoryManager.js";
import type { DockerImageAdapter } from "./dockerImageAdapter.js";

export class ManagedComputeRuntime {
  readonly #runtime: ComputeRuntimeCoordinator;
  readonly #directories: RunDirectoryManager;
  readonly #refStore: SqliteRefStore;
  readonly #committer: WorkspaceCommitCoordinator;
  readonly #images: Pick<DockerImageAdapter, "pullAndInspect" | "inspectInstalled">;
  readonly #now: () => number;

  constructor(options: {
    runtime: ComputeRuntimeCoordinator;
    directories: RunDirectoryManager;
    refStore: SqliteRefStore;
    committer: WorkspaceCommitCoordinator;
    images: Pick<DockerImageAdapter, "pullAndInspect" | "inspectInstalled">;
    now?: () => number;
  }) {
    this.#runtime = options.runtime;
    this.#directories = options.directories;
    this.#refStore = options.refStore;
    this.#committer = options.committer;
    this.#images = options.images;
    this.#now = options.now ?? Date.now;
  }

  async prepare(input: Parameters<ComputeRuntimeCoordinator["prepare"]>[0]) {
    const run = this.#refStore.getWorkspaceRun(input.runIdHex);
    if (
      run.state !== "PREPARING" ||
      run.workspaceIdHex !== input.workspaceIdHex ||
      run.inputHeadFidHex !== input.inputHeadFidHex ||
      run.executorId !== input.executorId
    ) {
      throw new Error("Runtime preparation does not match its control Run.");
    }
    return await this.#runtime.prepare(input);
  }

  async prepareBwa(input: Parameters<ComputeRuntimeCoordinator["prepareBwa"]>[0]) {
    const run = this.#refStore.getWorkspaceRun(input.runIdHex);
    const binding = this.#refStore.getBwaRunBinding(input.runIdHex);
    const instance = this.#refStore.getBwaInstance(binding.instanceIdHex);
    const application = this.#refStore.getBwaApplication(instance.applicationId);
    if (
      run.state !== "PREPARING" ||
      run.executorId !== "bwa.workspace-application.v1" ||
      run.workspaceIdHex !== input.workspaceIdHex ||
      run.inputHeadFidHex !== input.inputHeadFidHex ||
      instance.workspaceIdHex !== input.workspaceIdHex ||
      binding.executorDigest !== application.installedDigest ||
      input.imageReference !== `${application.applicationId}@${binding.executorDigest}`
    ) {
      throw new Error("BWA Runtime preparation does not match its control Run.");
    }
    return await this.#runtime.prepareBwa(input);
  }

  async pullAndInspect(reference: string) {
    return await this.#images.pullAndInspect(reference);
  }

  async inspectInstalled(imageReference: string) {
    return await this.#images.inspectInstalled(imageReference);
  }

  async start(runIdHex: string) {
    const manifest = await this.#runtime.start(runIdHex);
    try {
      this.#refStore.transitionWorkspaceRun({
        runIdHex,
        expectedState: "PREPARING",
        newState: "RUNNING",
        runtimeIdentity: requiredIdentity(manifest.runtimeIdentity),
        timestampMs: this.#timestamp(),
      });
      return manifest;
    } catch (error) {
      await this.#runtime.stop(runIdHex).catch(() => undefined);
      throw error;
    }
  }

  async inspect(runIdHex: string) {
    return await this.#runtime.inspect(runIdHex);
  }

  async resolveBwaEndpoint(runIdHex: string) {
    const run = this.#refStore.getWorkspaceRun(runIdHex);
    if (run.state !== "RUNNING" || run.executorId !== "bwa.workspace-application.v1") {
      throw new Error("Control Run is not an active BWA.");
    }
    const binding = this.#refStore.getBwaRunBinding(runIdHex);
    const instance = this.#refStore.getBwaInstance(binding.instanceIdHex);
    const application = this.#refStore.getBwaApplication(instance.applicationId);
    if (binding.executorDigest !== application.installedDigest) {
      throw new Error("Active BWA Run no longer matches its Application digest.");
    }
    const endpoint = await this.#runtime.resolveBwaEndpoint(runIdHex);
    if (endpoint.runtimeIdentity !== run.runtimeIdentity) {
      throw new Error("BWA endpoint does not match its control Runtime identity.");
    }
    return endpoint;
  }

  async freeze(runIdHex: string) {
    return await this.#runtime.freeze(runIdHex);
  }

  async thaw(runIdHex: string) {
    return await this.#runtime.thaw(runIdHex);
  }

  async stop(runIdHex: string) {
    const manifest = await this.#runtime.stop(runIdHex);
    this.#refStore.transitionWorkspaceRun({
      runIdHex,
      expectedState: "RUNNING",
      newState: "STOPPED",
      timestampMs: this.#timestamp(),
    });
    return manifest;
  }

  async finalizeExited(runIdHex: string) {
    const manifest = await this.#runtime.finalizeExited(runIdHex);
    if (manifest.state === "STOPPED") {
      this.#refStore.transitionWorkspaceRun({
        runIdHex,
        expectedState: "RUNNING",
        newState: "STOPPED",
        timestampMs: this.#timestamp(),
      });
    } else {
      this.#refStore.transitionWorkspaceRun({
        runIdHex,
        expectedState: "RUNNING",
        newState: "FAILED",
        errorCode: manifest.errorCode ?? "CONTAINER_EXIT_FAILED",
        timestampMs: this.#timestamp(),
      });
    }
    return manifest;
  }

  async reopenFailed(runIdHex: string) {
    return await this.#runtime.reopenFailed(runIdHex);
  }

  async commit(runIdHex: string) {
    const manifest = await this.#directories.inspect(runIdHex);
    if (manifest.state !== "STOPPED") {
      throw new Error("Only a locally STOPPED Run can be committed.");
    }
    try {
      return await this.#committer.commit({
        runIdHex,
        upperPath: this.#directories.paths(runIdHex).upper,
      });
    } catch (error) {
      const current = await this.#directories.inspect(runIdHex);
      if (current.state === "STOPPED") {
        await this.#directories.transition({
          runIdHex,
          expectedState: "STOPPED",
          newState: "FAILED",
          errorCode: "COW_COMMIT_FAILED",
        });
      }
      throw error;
    }
  }

  async destroy(runIdHex: string, preserveUpper: boolean) {
    return await this.#runtime.destroy(runIdHex, preserveUpper);
  }

  async shutdown() {
    return await this.#runtime.shutdown();
  }

  #timestamp(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Managed Runtime timestamp is invalid.");
    }
    return value;
  }
}

function requiredIdentity(value: string | null): string {
  if (!value) throw new Error("Started Runtime has no immutable identity.");
  return value;
}
