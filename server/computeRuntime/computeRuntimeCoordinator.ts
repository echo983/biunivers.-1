import { buildDockerOciPlan, type DockerOciPlan } from "./dockerOciPlan.js";
import {
  type DockerOciAdapter,
  type OciContainerState,
} from "./dockerOciAdapter.js";
import {
  ExecutorRegistry,
  type ExecutorDefinition,
} from "./executorRegistry.js";
import type { MountSupervisor } from "./mountSupervisor.js";
import {
  RunDirectoryManager,
  type RunPaths,
  type RuntimeManifest,
} from "./runDirectoryManager.js";

export interface SnapshotProvisioner {
  provision(input: {
    runIdHex: string;
    workspaceIdHex: string;
    inputHeadFidHex: string;
    revision: number;
    paths: RunPaths;
    capabilityHex: string;
  }): Promise<void>;
  release(runIdHex: string): Promise<void>;
}

export interface RuntimeInspection {
  manifest: RuntimeManifest;
  container?: OciContainerState;
}

type MountExecutor = Pick<MountSupervisor, "prepare" | "inspect" | "cleanup">;
type OciExecutor = Pick<
  DockerOciAdapter,
  "create" | "start" | "inspect" | "stop" | "remove"
>;

export class ComputeRuntimeCoordinator {
  readonly #directories: RunDirectoryManager;
  readonly #executors: ExecutorRegistry;
  readonly #mounts: MountExecutor;
  readonly #oci: OciExecutor;
  readonly #snapshots: SnapshotProvisioner;
  readonly #activeRunIds = new Set<string>();

  constructor(options: {
    directories: RunDirectoryManager;
    executors: ExecutorRegistry;
    mounts: MountExecutor;
    oci: OciExecutor;
    snapshots: SnapshotProvisioner;
  }) {
    this.#directories = options.directories;
    this.#executors = options.executors;
    this.#mounts = options.mounts;
    this.#oci = options.oci;
    this.#snapshots = options.snapshots;
  }

  async prepare(input: {
    runIdHex: string;
    workspaceIdHex: string;
    inputHeadFidHex: string;
    revision: number;
    executorId: string;
    capabilityHex: string;
  }): Promise<RuntimeManifest> {
    this.#executors.get(input.executorId);
    const prepared = await this.#directories.prepare(input);
    try {
      await this.#snapshots.provision({
        ...input,
        paths: prepared.paths,
      });
      await this.#mounts.prepare({
        runIdHex: input.runIdHex,
        paths: prepared.paths,
        capabilityHex: input.capabilityHex,
      });
      const manifest = await this.#directories.transition({
        runIdHex: input.runIdHex,
        expectedState: "PREPARING",
        newState: "PREPARED",
      });
      this.#activeRunIds.add(input.runIdHex);
      return manifest;
    } catch (error) {
      this.#activeRunIds.delete(input.runIdHex);
      await this.#releasePreparedResources(input.runIdHex);
      await this.#markFailed(input.runIdHex, "PREPARE_FAILED");
      throw error;
    }
  }

  async start(runIdHex: string): Promise<RuntimeManifest> {
    const manifest = await this.#directories.inspect(runIdHex);
    if (manifest.state !== "PREPARED") {
      throw new Error("Only a PREPARED local Run can be started.");
    }
    const executor = this.#executors.get(manifest.executorId);
    const plan = this.#plan(manifest, executor);
    const limits = commandLimits(executor);
    let created = false;
    try {
      const runtimeIdentity = await this.#oci.create(plan, limits);
      created = true;
      await this.#oci.start(plan, limits);
      return await this.#directories.transition({
        runIdHex,
        expectedState: "PREPARED",
        newState: "RUNNING",
        runtimeIdentity,
      });
    } catch (error) {
      this.#activeRunIds.delete(runIdHex);
      if (created) await ignoreFailure(() => this.#oci.remove(plan, limits));
      await this.#releasePreparedResources(runIdHex);
      await this.#markFailed(runIdHex, "START_FAILED");
      throw error;
    }
  }

  async inspect(runIdHex: string): Promise<RuntimeInspection> {
    const manifest = await this.#directories.inspect(runIdHex);
    if (!manifest.runtimeIdentity) return { manifest };
    const executor = this.#executors.get(manifest.executorId);
    return {
      manifest,
      container: await this.#oci.inspect(
        this.#plan(manifest, executor),
        commandLimits(executor),
      ),
    };
  }

  async stop(runIdHex: string): Promise<RuntimeManifest> {
    const manifest = await this.#directories.inspect(runIdHex);
    if (manifest.state !== "RUNNING") {
      throw new Error("Only a RUNNING local Run can be stopped.");
    }
    const executor = this.#executors.get(manifest.executorId);
    const plan = this.#plan(manifest, executor);
    const limits = commandLimits(executor);
    try {
      const state = await this.#oci.inspect(plan, limits);
      if (state.running) await this.#oci.stop(plan, limits);
      await this.#oci.remove(plan, limits);
      await this.#releasePreparedResources(runIdHex);
      const stopped = await this.#directories.transition({
        runIdHex,
        expectedState: "RUNNING",
        newState: "STOPPED",
      });
      this.#activeRunIds.delete(runIdHex);
      return stopped;
    } catch (error) {
      await this.#markFailed(runIdHex, "STOP_FAILED");
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    const errors: unknown[] = [];
    for (const runIdHex of [...this.#activeRunIds]) {
      try {
        const manifest = await this.#directories.inspect(runIdHex);
        if (manifest.state === "RUNNING") {
          const executor = this.#executors.get(manifest.executorId);
          const plan = this.#plan(manifest, executor);
          const limits = commandLimits(executor);
          await ignoreFailure(() => this.#oci.stop(plan, limits));
          await ignoreFailure(() => this.#oci.remove(plan, limits));
        }
        await this.#releasePreparedResources(runIdHex);
        if (manifest.state === "PREPARED" || manifest.state === "RUNNING") {
          await this.#directories.transition({
            runIdHex,
            expectedState: manifest.state,
            newState: "FAILED",
            errorCode: "DAEMON_SHUTDOWN",
          });
        }
      } catch (error) {
        errors.push(error);
      } finally {
        this.#activeRunIds.delete(runIdHex);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "Compute Runtime shutdown did not clean every active Run.",
      );
    }
  }

  #plan(
    manifest: RuntimeManifest,
    executor: ExecutorDefinition,
  ): DockerOciPlan {
    return buildDockerOciPlan({
      runIdHex: manifest.runIdHex,
      mergedPath: this.#directories.paths(manifest.runIdHex).merged,
      executor,
    });
  }

  async #releasePreparedResources(runIdHex: string): Promise<void> {
    if (this.#mounts.inspect(runIdHex)) {
      await ignoreFailure(() => this.#mounts.cleanup(runIdHex));
    }
    await ignoreFailure(() => this.#snapshots.release(runIdHex));
  }

  async #markFailed(runIdHex: string, errorCode: string): Promise<void> {
    let current: RuntimeManifest;
    try {
      current = await this.#directories.inspect(runIdHex);
    } catch {
      return;
    }
    if (current.state === "FAILED" || current.state === "STOPPED") return;
    await ignoreFailure(() =>
      this.#directories.transition({
        runIdHex,
        expectedState: current.state,
        newState: "FAILED",
        errorCode,
      }),
    );
  }
}

function commandLimits(executor: ExecutorDefinition): {
  timeoutMs: number;
  outputBytesLimit: number;
} {
  return {
    timeoutMs: executor.timeoutMs,
    outputBytesLimit: executor.outputBytesLimit,
  };
}

async function ignoreFailure(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    // The primary failure is preserved; reconciliation will retry cleanup.
  }
}
