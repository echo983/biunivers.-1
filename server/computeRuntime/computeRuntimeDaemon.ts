import type { ServerConfig } from "../config.js";
import { FileContentStore } from "../files/fileContentStore.js";
import { startFileService, type FileServiceRuntime } from "../files/fileServiceRuntime.js";
import { VerifiedChunkCache } from "../workspace/verifiedChunkCache.js";
import { WorkspaceContentReader } from "../workspace/workspaceContentReader.js";
import { WorkspaceSnapshotProvider } from "../workspace/workspaceSnapshotProvider.js";
import { TargetTreeProjector } from "../workspaceCommit/targetTreeProjector.js";
import { UpperContentMaterializer } from "../workspaceCommit/upperContentMaterializer.js";
import { UpperScanner } from "../workspaceCommit/upperScanner.js";
import { WorkspaceCommitCoordinator } from "../workspaceCommit/workspaceCommitCoordinator.js";
import { WorkspaceCommitObjectBuilder } from "../workspaceCommit/workspaceCommitObjectBuilder.js";
import { ComputeRuntimeCoordinator } from "./computeRuntimeCoordinator.js";
import type { ComputeRuntimeConfig } from "./computeRuntimeConfig.js";
import { ComputeRuntimeServer } from "./computeRuntimeServer.js";
import { ControlRunRecovery } from "./controlRunRecovery.js";
import { DockerOciAdapter } from "./dockerOciAdapter.js";
import { DockerImageAdapter } from "./dockerImageAdapter.js";
import { ExecutorRegistry } from "./executorRegistry.js";
import { InterruptedRunRecovery } from "./interruptedRunRecovery.js";
import { MountSupervisor } from "./mountSupervisor.js";
import { ManagedComputeRuntime } from "./managedComputeRuntime.js";
import { PvlogSnapshotProvisioner } from "./pvlogSnapshotProvisioner.js";
import { RunDirectoryManager } from "./runDirectoryManager.js";
import { BwaHostRecovery } from "../bwa/bwaHostRecovery.js";
import { BwaControlledShutdown } from "../bwa/bwaControlledShutdown.js";
import { BwaLifecycleService } from "../bwa/bwaLifecycleService.js";
import { DockerBwaNetworkAdapter } from "./dockerBwaNetworkAdapter.js";

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
    const details =
      fileRuntime.status.mode === "offline"
        ? `${fileRuntime.status.code}: ${fileRuntime.status.message}`
        : "File Service is disabled";
    throw new Error(`Compute Runtime File Service is not ready (${details}).`);
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
    const controlRecovery = await new ControlRunRecovery().reconcile(
      directories,
      fileRuntime.refStore,
      reconciliation.known,
    );
    const bwaRecovery = await new BwaHostRecovery().reconcile(
      directories,
      fileRuntime.refStore,
    );
    const recoveredRunCount = new Set([
      ...recovery.recovered,
      ...controlRecovery.stopped,
      ...controlRecovery.failed,
      ...bwaRecovery.failed,
    ]).size;

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
    const bwaNetwork = new DockerBwaNetworkAdapter();
    await bwaNetwork.ensure();
    const coordinator = new ComputeRuntimeCoordinator({
      directories,
      executors: new ExecutorRegistry(options.runtimeConfig.executors),
      mounts: new MountSupervisor({
        pvlogfsBinary: options.runtimeConfig.pvlogfsBinary,
      }),
      oci: new DockerOciAdapter(),
      snapshots,
      bwaEndpoints: bwaNetwork,
    });
    const maximumUpperBytes = Math.max(
      ...options.runtimeConfig.executors.map(
        (executor) => executor.upperBytesLimit,
      ),
    );
    const maximumUpperInodes = Math.max(
      ...options.runtimeConfig.executors.map(
        (executor) => executor.upperInodesLimit,
      ),
    );
    const managedRuntime = new ManagedComputeRuntime({
      runtime: coordinator,
      directories,
      refStore: fileRuntime.refStore,
      committer: new WorkspaceCommitCoordinator({
        repository: fileRuntime.repository,
        refStore: fileRuntime.refStore,
        scanner: new UpperScanner({
          binary: options.runtimeConfig.workspaceCowScannerBinary,
        }),
        projector: new TargetTreeProjector({
          maxEntries: maximumUpperInodes,
          maxDepth: 128,
        }),
        materializer: new UpperContentMaterializer({
          content: new FileContentStore(fileRuntime.repository),
        }),
        builder: new WorkspaceCommitObjectBuilder({
          repository: fileRuntime.repository,
          writerId: "workspace-runtime",
        }),
        limits: {
          maxEntries: maximumUpperInodes,
          maxDepth: 128,
          maxFileBytes: maximumUpperBytes,
          maxTotalBytes: maximumUpperBytes,
        },
      }),
      images: new DockerImageAdapter(),
    });
    const server = new ComputeRuntimeServer({
      socketPath: options.runtimeConfig.socketPath,
      authenticationTokenHex: options.runtimeConfig.authenticationTokenHex,
      runtime: managedRuntime,
    });
    await server.listen();
    const bwaShutdown = new BwaControlledShutdown({
      refStore: fileRuntime.refStore,
      lifecycle: new BwaLifecycleService({
        refStore: fileRuntime.refStore,
        environment: {
          resolveEnvironment: async () => {
            throw new Error("Environment resolution is unavailable during shutdown.");
          },
        },
        runtime: managedRuntime,
      }),
    });
    return new RunningComputeRuntimeDaemon({
      socketPath: options.runtimeConfig.socketPath,
      quarantinedPaths: reconciliation.quarantined.length,
      recoveredRuns: recoveredRunCount,
      server,
      coordinator: managedRuntime,
      bwaShutdown,
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
  readonly #coordinator: Pick<ManagedComputeRuntime, "shutdown">;
  readonly #bwaShutdown: BwaControlledShutdown;
  readonly #fileRuntime: FileServiceRuntime;
  #closed = false;

  constructor(options: {
    socketPath: string;
    quarantinedPaths: number;
    recoveredRuns: number;
    server: ComputeRuntimeServer;
    coordinator: Pick<ManagedComputeRuntime, "shutdown">;
    bwaShutdown: BwaControlledShutdown;
    fileRuntime: FileServiceRuntime;
  }) {
    this.socketPath = options.socketPath;
    this.quarantinedPaths = options.quarantinedPaths;
    this.recoveredRuns = options.recoveredRuns;
    this.#server = options.server;
    this.#coordinator = options.coordinator;
    this.#bwaShutdown = options.bwaShutdown;
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
      const report = await this.#bwaShutdown.shutdown();
      if (report.failed.length > 0) {
        errors.push(
          new AggregateError(
            report.failed.map((item) => item.error),
            "Controlled BWA shutdown did not commit every running Instance.",
          ),
        );
      }
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
