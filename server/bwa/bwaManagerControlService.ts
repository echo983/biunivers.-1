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
    public readonly code: "INSTANCE_NOT_RUNNING" | "INSTANCE_NOT_READY" | "INSTANCE_START_FAILED",
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
  readonly #runtime: {
    resolveBwaEndpoint(runIdHex: string): Promise<unknown>;
    inspect(runIdHex: string): Promise<unknown>;
    logs(runIdHex: string): Promise<unknown>;
  };
  readonly #fetch: typeof fetch;
  readonly #startingRunIds: Set<string>;

  constructor(options: {
    appOrigin: string;
    refStore: SqliteRefStore;
    registry: BwaRegistryService;
    lifecycle: BwaLifecycleService;
    sessions: BwaBrowserSessionRegistry;
    updates: BwaApplicationUpdateService;
    runtime: {
      resolveBwaEndpoint(runIdHex: string): Promise<unknown>;
      inspect(runIdHex: string): Promise<unknown>;
      logs(runIdHex: string): Promise<unknown>;
    };
    fetch?: typeof fetch;
    startingRunIds?: Set<string>;
  }) {
    this.#appOrigin = options.appOrigin;
    this.#refStore = options.refStore;
    this.#registry = options.registry;
    this.#lifecycle = options.lifecycle;
    this.#sessions = options.sessions;
    this.#updates = options.updates;
    this.#runtime = options.runtime;
    this.#fetch = options.fetch ?? fetch;
    this.#startingRunIds = options.startingRunIds ?? new Set();
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
            runs: this.#refStore.listBwaRunBindings(instance.instanceIdHex).map((item) => ({
              ...item,
              startupFailure: this.#refStore.getBwaStartupFailure(item.run.runIdHex),
            })),
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
    let run: Awaited<ReturnType<BwaLifecycleService["start"]>>;
    try {
      run = await this.#lifecycle.start(instanceIdHex);
    } catch (error) {
      const latest = [...this.#refStore.listBwaRunBindings(instanceIdHex)].reverse()[0]?.run;
      const summary = errorSummary(error, "运行环境准备失败。");
      if (latest?.state === "FAILED") {
        this.#refStore.setBwaStartupFailure({
          runIdHex: latest.runIdHex,
          stage: "RUNTIME_PREPARE",
          exitCode: null,
          summary,
          logTail: "",
          failedAtMs: Date.now(),
        });
        await this.#lifecycle.discardFailedUpper(instanceIdHex, latest.runIdHex).catch(() => undefined);
      }
      throw new BwaManagerControlError("INSTANCE_START_FAILED", summary);
    }
    this.#startingRunIds.add(run.runIdHex);
    try {
      await this.#waitUntilReady(instanceIdHex, run.runIdHex);
    } finally {
      this.#startingRunIds.delete(run.runIdHex);
    }
    return run;
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
    await this.#waitUntilReady(instanceIdHex, running.runIdHex);
    return { ready: true } as const;
  }

  async #waitUntilReady(instanceIdHex: string, runIdHex: string): Promise<void> {
    let endpoint: { address: string; port: 8080 } | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const inspection = parseRuntimeInspection(await this.#runtime.inspect(runIdHex));
      if (!inspection.running && !inspection.restarting) {
        const logTail = await this.#readStartupLogs(runIdHex);
        const summary = startupSummary(logTail, "应用在就绪前退出。");
        await this.#recordStartupFailure({
          instanceIdHex, runIdHex, stage: "APPLICATION_START",
          exitCode: inspection.exitCode, summary, logTail,
        });
        throw new BwaManagerControlError("INSTANCE_START_FAILED", summary);
      }
      if (!endpoint) endpoint = parseRuntimeEndpoint(await this.#runtime.resolveBwaEndpoint(runIdHex));
      try {
        const response = await this.#fetch(`http://${endpoint.address}:8080/health`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) return;
      } catch {
        // Container start and HTTP readiness are separate states.
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const logTail = await this.#readStartupLogs(runIdHex);
    const summary = startupSummary(logTail, "应用未能在 30 秒内就绪。");
    await this.#recordStartupFailure({
      instanceIdHex, runIdHex, stage: "HEALTH_CHECK", exitCode: null, summary, logTail,
    });
    throw new BwaManagerControlError("INSTANCE_NOT_READY", summary);
  }

  async #readStartupLogs(runIdHex: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const logTail = await this.#runtime.logs(runIdHex).then(parseLogTail, () => "");
      if (logTail || attempt === 4) return logTail;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return "";
  }

  async #recordStartupFailure(input: {
    instanceIdHex: string;
    runIdHex: string;
    stage: "APPLICATION_START" | "HEALTH_CHECK";
    exitCode: number | null;
    summary: string;
    logTail: string;
  }): Promise<void> {
    await this.#lifecycle.failStartup(input.instanceIdHex, input.runIdHex, `BWA_${input.stage}_FAILED`);
    this.#refStore.setBwaStartupFailure({
      runIdHex: input.runIdHex,
      stage: input.stage,
      exitCode: input.exitCode,
      summary: input.summary,
      logTail: input.logTail,
      failedAtMs: Date.now(),
    });
  }

  async publishFailedUpper(instanceIdHex: string, runIdHex: string) {
    return await this.#lifecycle.publishFailedUpper(instanceIdHex, runIdHex);
  }

  async discardFailedUpper(instanceIdHex: string, runIdHex: string) {
    return await this.#lifecycle.discardFailedUpper(instanceIdHex, runIdHex);
  }
}

function parseRuntimeEndpoint(value: unknown): { address: string; port: 8080 } {
  if (!value || typeof value !== "object") throw new Error("BWA Runtime endpoint is invalid.");
  const endpoint = value as Record<string, unknown>;
  if (typeof endpoint.address !== "string" || endpoint.port !== 8080) {
    throw new Error("BWA Runtime endpoint is invalid.");
  }
  return { address: endpoint.address, port: 8080 };
}

function parseRuntimeInspection(value: unknown): {
  running: boolean;
  restarting: boolean;
  exitCode: number;
} {
  if (!value || typeof value !== "object") throw new Error("BWA Runtime inspection is invalid.");
  const container = (value as { container?: unknown }).container;
  if (!container || typeof container !== "object") throw new Error("BWA Runtime container inspection is missing.");
  const state = container as Record<string, unknown>;
  if (typeof state.running !== "boolean" || typeof state.restarting !== "boolean" || !Number.isSafeInteger(state.exitCode)) {
    throw new Error("BWA Runtime container inspection is invalid.");
  }
  return { running: state.running, restarting: state.restarting, exitCode: state.exitCode as number };
}

function parseLogTail(value: unknown): string {
  if (typeof value !== "string") return "";
  const redacted = value
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)\S+/gi, "$1[REDACTED]");
  return [...redacted]
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join("")
    .slice(-16_384);
}

function startupSummary(logTail: string, fallback: string): string {
  const declared = logTail.split(/\r?\n/).reverse().find((line) => line.startsWith("BWA_STARTUP_ERROR:"));
  return (declared?.slice("BWA_STARTUP_ERROR:".length).trim() || fallback).slice(0, 512);
}

function errorSummary(error: unknown, fallback: string): string {
  let current = error;
  let message = fallback;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current.message) message = current.message;
    current = current.cause;
  }
  return parseLogTail(message).slice(0, 512) || fallback;
}
