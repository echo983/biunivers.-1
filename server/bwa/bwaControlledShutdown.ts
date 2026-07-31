import type { SqliteRefStore } from "../files/sqliteRefStore.js";
import type { BwaLifecycleService } from "./bwaLifecycleService.js";

export interface BwaControlledShutdownReport {
  committed: string[];
  failed: Array<{ instanceIdHex: string; error: unknown }>;
}

export class BwaControlledShutdown {
  readonly #refStore: SqliteRefStore;
  readonly #lifecycle: Pick<BwaLifecycleService, "stop">;

  constructor(options: {
    refStore: SqliteRefStore;
    lifecycle: Pick<BwaLifecycleService, "stop">;
  }) {
    this.#refStore = options.refStore;
    this.#lifecycle = options.lifecycle;
  }

  async shutdown(): Promise<BwaControlledShutdownReport> {
    const report: BwaControlledShutdownReport = { committed: [], failed: [] };
    const running = this.#refStore
      .listBwaApplications()
      .flatMap((application) => this.#refStore.listBwaInstances(application.applicationId))
      .filter((instance) =>
        this.#refStore
          .listBwaRunBindings(instance.instanceIdHex)
          .some(({ run }) => run.state === "RUNNING"),
      );
    for (const instance of running) {
      try {
        await this.#lifecycle.stop(instance.instanceIdHex, "HOST_SHUTDOWN");
        report.committed.push(instance.instanceIdHex);
      } catch (error) {
        report.failed.push({ instanceIdHex: instance.instanceIdHex, error });
      }
    }
    return report;
  }
}
