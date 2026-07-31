import type { BwaApplicationRecord, SqliteRefStore } from "../files/sqliteRefStore.js";
import type { BwaLifecycleService } from "./bwaLifecycleService.js";
import type { BwaRegistryService } from "./bwaRegistryService.js";

export class BwaApplicationUpdateError extends Error {
  constructor(
    public readonly code: "INSTANCE_STOP_FAILED" | "INSTANCE_RESTART_FAILED",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BwaApplicationUpdateError";
  }
}

export class BwaApplicationUpdateService {
  readonly #refStore: SqliteRefStore;
  readonly #registry: Pick<BwaRegistryService, "update" | "rollback">;
  readonly #lifecycle: Pick<BwaLifecycleService, "start" | "stop">;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(options: {
    refStore: SqliteRefStore;
    registry: Pick<BwaRegistryService, "update" | "rollback">;
    lifecycle: Pick<BwaLifecycleService, "start" | "stop">;
  }) {
    this.#refStore = options.refStore;
    this.#registry = options.registry;
    this.#lifecycle = options.lifecycle;
  }

  async update(applicationId: string, reference: string): Promise<BwaApplicationRecord> {
    return await this.#exclusive(applicationId, () =>
      this.#replace(applicationId, () => this.#registry.update(applicationId, reference)),
    );
  }

  async rollback(applicationId: string): Promise<BwaApplicationRecord> {
    return await this.#exclusive(applicationId, () =>
      this.#replace(applicationId, () => this.#registry.rollback(applicationId)),
    );
  }

  async #replace(
    applicationId: string,
    replace: () => Promise<BwaApplicationRecord>,
  ): Promise<BwaApplicationRecord> {
    const running = this.#refStore
      .listBwaInstances(applicationId)
      .filter((instance) =>
        this.#refStore
          .listBwaRunBindings(instance.instanceIdHex)
          .some(({ run }) => run.state === "RUNNING"),
      )
      .map((instance) => instance.instanceIdHex);
    const stopped: string[] = [];
    try {
      for (const instanceIdHex of running) {
        await this.#lifecycle.stop(instanceIdHex, "SAVE_RESTART");
        stopped.push(instanceIdHex);
      }
    } catch (error) {
      await this.#restartBestEffort(stopped);
      throw new BwaApplicationUpdateError(
        "INSTANCE_STOP_FAILED",
        "BWA Application update could not stop every running Instance.",
        { cause: error },
      );
    }

    let application: BwaApplicationRecord;
    try {
      application = await replace();
    } catch (error) {
      await this.#restartBestEffort(stopped);
      throw error;
    }

    const failures = await this.#restartBestEffort(stopped);
    if (failures.length > 0) {
      throw new BwaApplicationUpdateError(
        "INSTANCE_RESTART_FAILED",
        "BWA Application image changed, but one or more Instances could not restart.",
        { cause: new AggregateError(failures) },
      );
    }
    return application;
  }

  async #restartBestEffort(instanceIdsHex: readonly string[]): Promise<unknown[]> {
    const failures: unknown[] = [];
    for (const instanceIdHex of instanceIdsHex) {
      try {
        await this.#lifecycle.start(instanceIdHex);
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  }

  async #exclusive<T>(applicationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(applicationId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#locks.set(applicationId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(applicationId) === queued) this.#locks.delete(applicationId);
    }
  }
}
