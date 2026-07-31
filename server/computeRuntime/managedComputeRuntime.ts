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

  async commit(runIdHex: string) {
    const manifest = await this.#directories.inspect(runIdHex);
    if (manifest.state !== "STOPPED") {
      throw new Error("Only a locally STOPPED Run can be committed.");
    }
    return await this.#committer.commit({
      runIdHex,
      upperPath: this.#directories.paths(runIdHex).upper,
    });
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
