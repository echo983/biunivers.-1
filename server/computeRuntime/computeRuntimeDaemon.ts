import type { ServerConfig } from "../config.js";
import { startFileService, type FileServiceRuntime } from "../files/fileServiceRuntime.js";
import { VerifiedChunkCache } from "../workspace/verifiedChunkCache.js";
import { WorkspaceContentReader } from "../workspace/workspaceContentReader.js";
import { WorkspaceSnapshotProvider } from "../workspace/workspaceSnapshotProvider.js";
import { ComputeRuntimeCoordinator } from "./computeRuntimeCoordinator.js";
import type { ComputeRuntimeConfig } from "./computeRuntimeConfig.js";
import { ComputeRuntimeServer } from "./computeRuntimeServer.js";
import { DockerOciAdapter } from "./dockerOciAdapter.js";
import { ExecutorRegistry } from "./executorRegistry.js";
import { InterruptedRunRecovery } from "./interruptedRunRecovery.js";
import { MountSupervisor } from "./mountSupervisor.js";
import { PvlogSnapshotProvisioner } from "./pvlogSnapshotProvisioner.js";
import { RunDirectoryManager } from "./runDirectoryManager.js";

export interface ComputeRuntimeDaemon {
  readonly socketPath: string;
  readonly quarantinedPaths: number;
  readonly recoveredRuns: number;
  close(): Promise<void>;
}

export async function startComputeRuntimeDaemon(options: {
  serverConfig: ServerConfig;
  runtimeConfig: ComputeRuntimeConfig;
}): Promise<ComputeRuntimeDaemon> {
  if (!options.serverConfig.fileService) {
    throw new Error("Compute Runtime requires Biunivers File Service.");
  }
  const fileRuntime = await startFileService(options.serverConfig.fileService);
  if (
    fileRuntime.status.mode !== "ready" ||
    !fileRuntime.repository ||
    !fileRuntime.refStore
  ) {
    fileRuntime.close();
    throw new Error("Compute Runtime File Service is not ready.");
  }

  try {
    const directories = new RunDirectoryManager({
      root: options.runtimeConfig.runRoot,
    });
    const knownRunIds = new Set(
      fileRuntime.refStore
        .listWorkspaces()
        .flatMap((workspace) =>
          fileRuntime.refStore!.listWorkspaceRuns(workspace.workspaceIdHex),
        )
        .map((run) => run.runIdHex),
    );
    const reconciliation = await directories.reconcile(knownRunIds);
    const recovery = await new InterruptedRunRecovery().recover(
      directories,
      reconciliation.known,
    );
    await assertNoInterruptedLocalRuns(directories, reconciliation.known);

    const cache = new VerifiedChunkCache({
      directory: options.runtimeConfig.cachePath,
      repository: fileRuntime.repository,
    });
    const snapshots = new PvlogSnapshotProvisioner({
      snapshotProvider: new WorkspaceSnapshotProvider({
        repository: fileRuntime.repository,
        refStore: fileRuntime.refStore,
      }),
      contentReader: new WorkspaceContentReader({
        repository: fileRuntime.repository,
        cache,
      }),
    });
    const coordinator = new ComputeRuntimeCoordinator({
      directories,
      executors: new ExecutorRegistry(options.runtimeConfig.executors),
      mounts: new MountSupervisor({
        pvlogfsBinary: options.runtimeConfig.pvlogfsBinary,
      }),
      oci: new DockerOciAdapter(),
      snapshots,
    });
    const server = new ComputeRuntimeServer({
      socketPath: options.runtimeConfig.socketPath,
      authenticationTokenHex: options.runtimeConfig.authenticationTokenHex,
      runtime: coordinator,
    });
    await server.listen();
    return new RunningComputeRuntimeDaemon({
      socketPath: options.runtimeConfig.socketPath,
      quarantinedPaths: reconciliation.quarantined.length,
      recoveredRuns: recovery.recovered.length,
      server,
      coordinator,
      fileRuntime,
    });
  } catch (error) {
    fileRuntime.close();
    throw error;
  }
}

class RunningComputeRuntimeDaemon implements ComputeRuntimeDaemon {
  readonly socketPath: string;
  readonly quarantinedPaths: number;
  readonly recoveredRuns: number;
  readonly #server: ComputeRuntimeServer;
  readonly #coordinator: ComputeRuntimeCoordinator;
  readonly #fileRuntime: FileServiceRuntime;
  #closed = false;

  constructor(options: {
    socketPath: string;
    quarantinedPaths: number;
    recoveredRuns: number;
    server: ComputeRuntimeServer;
    coordinator: ComputeRuntimeCoordinator;
    fileRuntime: FileServiceRuntime;
  }) {
    this.socketPath = options.socketPath;
    this.quarantinedPaths = options.quarantinedPaths;
    this.recoveredRuns = options.recoveredRuns;
    this.#server = options.server;
    this.#coordinator = options.coordinator;
    this.#fileRuntime = options.fileRuntime;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const errors: unknown[] = [];
    try {
      await this.#server.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.#coordinator.shutdown();
    } catch (error) {
      errors.push(error);
    }
    this.#fileRuntime.close();
    if (errors.length > 0) {
      throw new AggregateError(errors, "Compute Runtime daemon shutdown failed.");
    }
  }
}

export async function assertNoInterruptedLocalRuns(
  directories: RunDirectoryManager,
  knownRunIds: readonly string[],
): Promise<void> {
  const interrupted: string[] = [];
  for (const runIdHex of knownRunIds) {
    const manifest = await directories.inspect(runIdHex);
    if (
      manifest.state === "PREPARING" ||
      manifest.state === "PREPARED" ||
      manifest.state === "RUNNING" ||
      manifest.state === "FROZEN"
    ) {
      interrupted.push(runIdHex);
    }
  }
  if (interrupted.length > 0) {
    throw new Error(
      `Compute Runtime found interrupted Runs requiring recovery: ${interrupted.join(",")}`,
    );
  }
}
