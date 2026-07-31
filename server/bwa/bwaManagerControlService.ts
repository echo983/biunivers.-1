import type {
  BwaStartupPolicy,
  SqliteRefStore,
} from "../files/sqliteRefStore.js";
import type { BwaBrowserSessionRegistry } from "./bwaBrowserSessionRegistry.js";
import type { BwaLifecycleService } from "./bwaLifecycleService.js";
import { bwaInstanceOrigin } from "./bwaOrigin.js";
import type { BwaRegistryService } from "./bwaRegistryService.js";
import type { BwaApplicationUpdateService } from "./bwaApplicationUpdateService.js";

export class BwaManagerControlError extends Error {
  constructor(
    public readonly code: "INSTANCE_NOT_RUNNING" | "INSTANCE_NOT_READY",
    message: string,
  ) {
    super(message);
    this.name = "BwaManagerControlError";
  }
}

export class BwaManagerControlService {
  readonly #appOrigin: string;
  readonly #refStore: SqliteRefStore;
  readonly #registry: BwaRegistryService;
  readonly #lifecycle: BwaLifecycleService;
  readonly #sessions: BwaBrowserSessionRegistry;
  readonly #updates: BwaApplicationUpdateService;
  readonly #runtime: { resolveBwaEndpoint(runIdHex: string): Promise<unknown> };
  readonly #fetch: typeof fetch;

  constructor(options: {
    appOrigin: string;
    refStore: SqliteRefStore;
    registry: BwaRegistryService;
    lifecycle: BwaLifecycleService;
    sessions: BwaBrowserSessionRegistry;
    updates: BwaApplicationUpdateService;
    runtime: { resolveBwaEndpoint(runIdHex: string): Promise<unknown> };
    fetch?: typeof fetch;
  }) {
    this.#appOrigin = options.appOrigin;
    this.#refStore = options.refStore;
    this.#registry = options.registry;
    this.#lifecycle = options.lifecycle;
    this.#sessions = options.sessions;
    this.#updates = options.updates;
    this.#runtime = options.runtime;
    this.#fetch = options.fetch ?? fetch;
  }

  status() {
    return {
      workspaces: this.#refStore.listWorkspaces().map((workspace) => ({
        workspaceIdHex: workspace.workspaceIdHex,
        name: workspace.name,
        revision: this.#refStore.getRef(workspace.refId).revision,
      })),
      applications: this.#refStore.listBwaApplications().map((application) => ({
        ...application,
        instances: this.#refStore
          .listBwaInstances(application.applicationId)
          .map((instance) => ({
            ...instance,
            environment: this.#refStore.listBwaEnvironment(instance.instanceIdHex),
            runs: this.#refStore.listBwaRunBindings(instance.instanceIdHex),
          })),
      })),
    };
  }

  async install(reference: string) {
    return await this.#registry.install(reference);
  }

  async createInstance(input: {
    applicationId: string;
    name: string;
    startupPolicy?: BwaStartupPolicy;
    sourceWorkspaceIdHex?: string;
  }) {
    return input.sourceWorkspaceIdHex
      ? this.#registry.createForkedInstance({
          applicationId: input.applicationId,
          sourceWorkspaceIdHex: input.sourceWorkspaceIdHex,
          name: input.name,
          ...(input.startupPolicy ? { startupPolicy: input.startupPolicy } : {}),
        })
      : await this.#registry.createBlankInstance(input);
  }

  async update(applicationId: string, reference: string) {
    return await this.#updates.update(applicationId, reference);
  }

  async rollback(applicationId: string) {
    return await this.#updates.rollback(applicationId);
  }

  async deleteInstance(instanceIdHex: string) {
    const workspace = await this.#registry.deleteInstancePreservingWorkspace(instanceIdHex);
    this.#sessions.revokeInstance(instanceIdHex);
    return { workspace };
  }

  uninstall(applicationId: string) {
    this.#registry.uninstall(applicationId);
    return { applicationId };
  }

  async replaceEnvironment(
    instanceIdHex: string,
    ordinary: Record<string, string>,
    sensitive: Record<string, string>,
  ) {
    return await this.#registry.replaceEnvironment(
      instanceIdHex,
      ordinary,
      sensitive,
    );
  }

  async start(instanceIdHex: string) {
    return await this.#lifecycle.start(instanceIdHex);
  }

  async stop(instanceIdHex: string) {
    return await this.#lifecycle.stop(instanceIdHex);
  }

  async saveAndRestart(instanceIdHex: string) {
    return await this.#lifecycle.saveAndRestart(instanceIdHex);
  }

  open(instanceIdHex: string) {
    const instance = this.#refStore.getBwaInstance(instanceIdHex);
    const running = this.#refStore
      .listBwaRunBindings(instanceIdHex)
      .some(({ run }) => run.state === "RUNNING");
    if (!running) {
      throw new BwaManagerControlError(
        "INSTANCE_NOT_RUNNING",
        "BWA Instance is not running.",
      );
    }
    const bootstrap = this.#sessions.issueBootstrap(instanceIdHex);
    const url = new URL("/__biunivers/bootstrap", bwaInstanceOrigin(this.#appOrigin, instanceIdHex));
    url.searchParams.set("t", bootstrap.ticket);
    return {
      instanceIdHex: instance.instanceIdHex,
      url: url.toString(),
      expiresAt: new Date(bootstrap.expiresAtMs).toISOString(),
    };
  }

  async waitUntilReady(instanceIdHex: string) {
    const running = this.#refStore
      .listBwaRunBindings(instanceIdHex)
      .map(({ run }) => run)
      .find((run) => run.state === "RUNNING");
    if (!running) {
      throw new BwaManagerControlError(
        "INSTANCE_NOT_RUNNING",
        "BWA Instance is not running.",
      );
    }
    const endpoint = await this.#runtime.resolveBwaEndpoint(running.runIdHex);
    if (!endpoint || typeof endpoint !== "object") {
      throw new Error("BWA Runtime endpoint is invalid.");
    }
    const value = endpoint as Record<string, unknown>;
    if (typeof value.address !== "string" || value.port !== 8080) {
      throw new Error("BWA Runtime endpoint is invalid.");
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const response = await this.#fetch(`http://${value.address}:8080/health`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) return { ready: true };
      } catch {
        // Container start and HTTP readiness are separate states.
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new BwaManagerControlError(
      "INSTANCE_NOT_READY",
      "BWA application did not become ready within 30 seconds.",
    );
  }

  async publishFailedUpper(instanceIdHex: string, runIdHex: string) {
    return await this.#lifecycle.publishFailedUpper(instanceIdHex, runIdHex);
  }

  async discardFailedUpper(instanceIdHex: string, runIdHex: string) {
    return await this.#lifecycle.discardFailedUpper(instanceIdHex, runIdHex);
  }
}
