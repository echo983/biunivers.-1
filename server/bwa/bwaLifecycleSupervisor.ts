import type { SqliteRefStore } from "../files/sqliteRefStore.js";
import type { BwaLifecycleService } from "./bwaLifecycleService.js";

interface RuntimeInspector {
  inspect(runIdHex: string): Promise<unknown>;
}

export interface BwaSupervisorReport {
  inspected: string[];
  finalized: string[];
  failed: Array<{ runIdHex: string; error: unknown }>;
}

export class BwaLifecycleSupervisor {
  readonly #refStore: SqliteRefStore;
  readonly #runtime: RuntimeInspector;
  readonly #lifecycle: Pick<BwaLifecycleService, "finalizeExited">;
  #current?: Promise<BwaSupervisorReport>;

  constructor(options: {
    refStore: SqliteRefStore;
    runtime: RuntimeInspector;
    lifecycle: Pick<BwaLifecycleService, "finalizeExited">;
  }) {
    this.#refStore = options.refStore;
    this.#runtime = options.runtime;
    this.#lifecycle = options.lifecycle;
  }

  async reconcileOnce(): Promise<BwaSupervisorReport> {
    if (this.#current) return await this.#current;
    const operation = this.#reconcile();
    this.#current = operation;
    try {
      return await operation;
    } finally {
      if (this.#current === operation) this.#current = undefined;
    }
  }

  async #reconcile(): Promise<BwaSupervisorReport> {
    const report: BwaSupervisorReport = { inspected: [], finalized: [], failed: [] };
    const active = this.#refStore
      .listBwaApplications()
      .flatMap((application) => this.#refStore.listBwaInstances(application.applicationId))
      .flatMap((instance) =>
        this.#refStore
          .listBwaRunBindings(instance.instanceIdHex)
          .filter(({ run }) => run.state === "RUNNING")
          .map(({ run }) => ({ instanceIdHex: instance.instanceIdHex, runIdHex: run.runIdHex })),
      );
    for (const item of active) {
      report.inspected.push(item.runIdHex);
      try {
        const inspection = parseInspection(await this.#runtime.inspect(item.runIdHex));
        if (!inspection.running && !inspection.restarting) {
          await this.#lifecycle.finalizeExited(item.instanceIdHex);
          report.finalized.push(item.runIdHex);
        }
      } catch (error) {
        report.failed.push({ runIdHex: item.runIdHex, error });
      }
    }
    return report;
  }
}

function parseInspection(value: unknown): { running: boolean; restarting: boolean } {
  if (!value || typeof value !== "object") throw new Error("Runtime inspection is invalid.");
  const container = (value as { container?: unknown }).container;
  if (!container || typeof container !== "object") {
    throw new Error("Active BWA Run has no container inspection.");
  }
  const state = container as Record<string, unknown>;
  if (typeof state.running !== "boolean" || typeof state.restarting !== "boolean") {
    throw new Error("Runtime container inspection is invalid.");
  }
  return { running: state.running, restarting: state.restarting };
}
