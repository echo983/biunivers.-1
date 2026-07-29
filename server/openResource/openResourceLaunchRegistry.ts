import { randomBytes } from "node:crypto";

export type OpenResourceErrorCode =
  | "LAUNCH_CONTEXT_EXPIRED"
  | "NO_LAUNCH_CONTEXT"
  | "RESOURCE_OPEN_BUSY"
  | "HANDLER_NOT_AVAILABLE"
  | "CAPABILITY_LIMIT_REACHED";

export class OpenResourceError extends Error {
  constructor(
    readonly code: OpenResourceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OpenResourceError";
  }
}

export interface PendingOpenResourceLaunch {
  launchId: string;
  targetAppId: string;
  handlerId: string;
  entryId: string;
  expectedRevision: number;
  action: "open" | "edit";
  writable: boolean;
  createdAtMs: number;
  expiresAtMs: number;
}

interface OpenResourceLaunchRegistryOptions {
  now?: () => number;
  randomToken?: () => string;
  ttlMs?: number;
  maxLaunches?: number;
}

export class OpenResourceLaunchRegistry {
  readonly #launches = new Map<string, PendingOpenResourceLaunch>();
  readonly #byTargetApp = new Map<string, string>();
  readonly #now: () => number;
  readonly #randomToken: () => string;
  readonly #ttlMs: number;
  readonly #maxLaunches: number;

  constructor(options: OpenResourceLaunchRegistryOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#randomToken =
      options.randomToken ?? (() => randomBytes(32).toString("base64url"));
    this.#ttlMs = positive(options.ttlMs ?? 5 * 60 * 1000, "launch TTL");
    this.#maxLaunches = positive(
      options.maxLaunches ?? 256,
      "launch limit",
    );
  }

  create(
    input: Omit<
      PendingOpenResourceLaunch,
      "launchId" | "createdAtMs" | "expiresAtMs"
    >,
  ) {
    this.prune();
    if (this.#byTargetApp.has(input.targetAppId)) {
      throw new OpenResourceError(
        "RESOURCE_OPEN_BUSY",
        "The target application already has a pending resource.",
      );
    }
    if (this.#launches.size >= this.#maxLaunches) {
      throw new OpenResourceError(
        "CAPABILITY_LIMIT_REACHED",
        "The pending resource launch limit has been reached.",
      );
    }
    const launchId = this.#newUniqueToken();
    const createdAtMs = this.#now();
    const launch: PendingOpenResourceLaunch = {
      ...input,
      launchId,
      createdAtMs,
      expiresAtMs: createdAtMs + this.#ttlMs,
    };
    this.#launches.set(launchId, launch);
    this.#byTargetApp.set(input.targetAppId, launchId);
    return {
      launchId,
      expiresAt: new Date(launch.expiresAtMs).toISOString(),
    };
  }

  consume(launchId: string, targetAppId: string) {
    const launch = this.#launches.get(launchId);
    if (!launch) {
      throw new OpenResourceError(
        "NO_LAUNCH_CONTEXT",
        "No pending resource is available for this window.",
      );
    }
    if (launch.expiresAtMs <= this.#now()) {
      this.#delete(launch);
      throw new OpenResourceError(
        "LAUNCH_CONTEXT_EXPIRED",
        "The pending resource launch expired.",
      );
    }
    if (launch.targetAppId !== targetAppId) {
      throw new OpenResourceError(
        "NO_LAUNCH_CONTEXT",
        "No pending resource is available for this window.",
      );
    }
    this.#delete(launch);
    return launch;
  }

  cancelTarget(targetAppId: string): void {
    const launchId = this.#byTargetApp.get(targetAppId);
    if (!launchId) return;
    const launch = this.#launches.get(launchId);
    if (launch) this.#delete(launch);
  }

  prune(): void {
    const now = this.#now();
    for (const launch of this.#launches.values()) {
      if (launch.expiresAtMs <= now) {
        this.#delete(launch);
      }
    }
  }

  #delete(launch: PendingOpenResourceLaunch): void {
    this.#launches.delete(launch.launchId);
    if (this.#byTargetApp.get(launch.targetAppId) === launch.launchId) {
      this.#byTargetApp.delete(launch.targetAppId);
    }
  }

  #newUniqueToken(): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const token = this.#randomToken();
      if (/^[A-Za-z0-9_-]{43}$/.test(token) && !this.#launches.has(token)) {
        return token;
      }
    }
    throw new OpenResourceError(
      "CAPABILITY_LIMIT_REACHED",
      "Unable to allocate a resource launch token.",
    );
  }
}

function positive(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}
