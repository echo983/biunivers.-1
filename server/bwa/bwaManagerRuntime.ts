import type { RequestHandler } from "express";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { BwaManagerConfig } from "../config.js";
import type { ImmutableObjectRepository } from "../files/immutableObjectRepository.js";
import type { SqliteRefStore } from "../files/sqliteRefStore.js";
import { BlankBwaInstanceCreator } from "./blankBwaInstanceCreator.js";
import { BwaBrowserSessionRegistry } from "./bwaBrowserSessionRegistry.js";
import { BwaApplicationUpdateService } from "./bwaApplicationUpdateService.js";
import { BwaLifecycleService } from "./bwaLifecycleService.js";
import { BwaLifecycleSupervisor } from "./bwaLifecycleSupervisor.js";
import { BwaManagerControlService } from "./bwaManagerControlService.js";
import { BwaRegistryService } from "./bwaRegistryService.js";
import {
  createBwaRuntimeProxy,
  createBwaWebSocketProxy,
} from "./bwaRuntimeProxy.js";
import { BwaSecretStore } from "./bwaSecretStore.js";
import { ComputeRuntimeImageClient } from "./computeRuntimeImageClient.js";
import { ComputeRuntimeLifecycleClient } from "./computeRuntimeLifecycleClient.js";

export class BwaManagerRuntime {
  readonly registry: BwaRegistryService;
  readonly lifecycle: BwaLifecycleService;
  readonly sessions: BwaBrowserSessionRegistry;
  readonly control: BwaManagerControlService;
  readonly httpProxy: RequestHandler;
  readonly websocketProxy: (
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ) => void;
  readonly #supervisor: BwaLifecycleSupervisor;
  #timer?: NodeJS.Timeout;

  private constructor(options: {
    registry: BwaRegistryService;
    lifecycle: BwaLifecycleService;
    sessions: BwaBrowserSessionRegistry;
    supervisor: BwaLifecycleSupervisor;
    httpProxy: RequestHandler;
    websocketProxy: BwaManagerRuntime["websocketProxy"];
    control: BwaManagerControlService;
  }) {
    this.registry = options.registry;
    this.lifecycle = options.lifecycle;
    this.sessions = options.sessions;
    this.#supervisor = options.supervisor;
    this.httpProxy = options.httpProxy;
    this.websocketProxy = options.websocketProxy;
    this.control = options.control;
  }

  static async create(options: {
    config: BwaManagerConfig;
    appOrigin: string;
    repository: ImmutableObjectRepository;
    refStore: SqliteRefStore;
    writerId: string;
  }): Promise<BwaManagerRuntime> {
    const secrets = new BwaSecretStore(options.config.secretStorePath);
    await secrets.initialize();
    await secrets.prune(
      new Set(
        options.refStore
          .listBwaApplications()
          .flatMap((application) =>
            options.refStore.listBwaInstances(application.applicationId),
          )
          .map((instance) => instance.instanceIdHex),
      ),
    );
    const connection = {
      socketPath: options.config.runtimeSocketPath,
      authenticationTokenHex: options.config.runtimeAuthenticationTokenHex,
    };
    const runtime = new ComputeRuntimeLifecycleClient(connection);
    const registry = new BwaRegistryService({
      refStore: options.refStore,
      secrets,
      images: new ComputeRuntimeImageClient(connection),
      blankCreator: new BlankBwaInstanceCreator({
        repository: options.repository,
        refStore: options.refStore,
        writerId: options.writerId,
      }),
    });
    const lifecycle = new BwaLifecycleService({
      refStore: options.refStore,
      environment: registry,
      runtime,
    });
    const sessions = new BwaBrowserSessionRegistry();
    const updates = new BwaApplicationUpdateService({
      refStore: options.refStore,
      registry,
      lifecycle,
    });
    const proxyOptions = {
      appOrigin: options.appOrigin,
      refStore: options.refStore,
      sessions,
      runtime,
    };
    const manager = new BwaManagerRuntime({
      registry,
      lifecycle,
      sessions,
      supervisor: new BwaLifecycleSupervisor({
        refStore: options.refStore,
        runtime,
        lifecycle,
      }),
      httpProxy: createBwaRuntimeProxy(proxyOptions),
      websocketProxy: createBwaWebSocketProxy(proxyOptions),
      control: new BwaManagerControlService({
        appOrigin: options.appOrigin,
        refStore: options.refStore,
        registry,
        lifecycle,
        sessions,
        updates,
        runtime,
      }),
    });
    manager.#startSupervisor();
    return manager;
  }

  close(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #startSupervisor(): void {
    const reconcile = () => {
      void this.#supervisor.reconcileOnce().then((report) => {
        for (const item of report.failed) {
          console.warn(`BWA supervisor could not inspect Run ${item.runIdHex}.`);
        }
      }).catch(() => console.warn("BWA supervisor reconciliation failed."));
    };
    reconcile();
    this.#timer = setInterval(reconcile, 2_000);
    this.#timer.unref();
  }
}
