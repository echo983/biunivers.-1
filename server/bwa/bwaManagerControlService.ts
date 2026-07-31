import type {
  BwaStartupPolicy,
  SqliteRefStore,
} from "../files/sqliteRefStore.js";
import type { BwaBrowserSessionRegistry } from "./bwaBrowserSessionRegistry.js";
import type { BwaLifecycleService } from "./bwaLifecycleService.js";
import { bwaInstanceOrigin } from "./bwaOrigin.js";
import type { BwaRegistryService } from "./bwaRegistryService.js";

export class BwaManagerControlError extends Error {
  constructor(
    public readonly code: "INSTANCE_NOT_RUNNING",
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

  constructor(options: {
    appOrigin: string;
    refStore: SqliteRefStore;
    registry: BwaRegistryService;
    lifecycle: BwaLifecycleService;
    sessions: BwaBrowserSessionRegistry;
  }) {
    this.#appOrigin = options.appOrigin;
    this.#refStore = options.refStore;
    this.#registry = options.registry;
    this.#lifecycle = options.lifecycle;
    this.#sessions = options.sessions;
  }

  status() {
    return {
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
  }) {
    return await this.#registry.createBlankInstance(input);
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

  async publishFailedUpper(instanceIdHex: string, runIdHex: string) {
    return await this.#lifecycle.publishFailedUpper(instanceIdHex, runIdHex);
  }

  async discardFailedUpper(instanceIdHex: string, runIdHex: string) {
    return await this.#lifecycle.discardFailedUpper(instanceIdHex, runIdHex);
  }
}
