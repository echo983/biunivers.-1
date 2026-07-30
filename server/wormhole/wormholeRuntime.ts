import { randomBytes, timingSafeEqual } from "node:crypto";

const USERNAME = "biunivers";
const PASSWORD_LENGTH = 10;
const PASSWORD_ALPHABET =
  "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES_PER_WINDOW = 10;
const MAX_FAILURE_SOURCES = 1024;
const DUMMY_PASSWORD = "xxxxxxxxxx";

export interface WormholeStatus {
  enabled: boolean;
  username?: string;
  password?: string;
  path?: string;
  enabledAt?: string;
}

export interface WormholeRequestLease {
  signal: AbortSignal;
  release(): void;
}

interface FailureState {
  count: number;
  windowStartedAtMs: number;
}

interface WormholeRuntimeOptions {
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
}

export class WormholeRuntime {
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #failures = new Map<string, FailureState>();
  readonly #requests = new Set<AbortController>();
  readonly #revokeListeners = new Set<() => void>();
  #password?: string;
  #enabledAtMs?: number;
  #generation = 0;

  constructor(options: WormholeRuntimeOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? randomBytes;
  }

  status(): WormholeStatus {
    if (!this.#password || this.#enabledAtMs === undefined) {
      return { enabled: false };
    }
    return {
      enabled: true,
      username: USERNAME,
      password: this.#password,
      path: "/wormhole/webdav/",
      enabledAt: new Date(this.#enabledAtMs).toISOString(),
    };
  }

  enable(): WormholeStatus {
    if (this.#password) return this.status();
    this.#password = generatePassword(this.#randomBytes);
    this.#enabledAtMs = this.#now();
    this.#generation += 1;
    this.#failures.clear();
    return this.status();
  }

  rotate(): WormholeStatus {
    if (!this.#password) {
      throw new WormholeRuntimeError(
        "WORMHOLE_DISABLED",
        "Wormhole is not enabled.",
      );
    }
    this.#revoke();
    return this.enable();
  }

  disable(): WormholeStatus {
    this.#revoke();
    return { enabled: false };
  }

  authenticate(
    username: string,
    password: string,
    source = "unknown",
  ): boolean {
    const now = this.#now();
    const failure = this.#failures.get(source);
    if (
      failure &&
      now - failure.windowStartedAtMs < FAILURE_WINDOW_MS &&
      failure.count >= MAX_FAILURES_PER_WINDOW
    ) {
      return false;
    }
    const expectedPassword = this.#password ?? DUMMY_PASSWORD;
    const valid =
      constantTimeEquals(username, USERNAME) &&
      constantTimeEquals(password, expectedPassword) &&
      this.#password !== undefined;
    if (valid) {
      this.#failures.delete(source);
      return true;
    }
    this.#recordFailure(source, now);
    return false;
  }

  registerRequest(): WormholeRequestLease {
    if (!this.#password) {
      throw new WormholeRuntimeError(
        "WORMHOLE_DISABLED",
        "Wormhole is not enabled.",
      );
    }
    const generation = this.#generation;
    const controller = new AbortController();
    this.#requests.add(controller);
    return {
      signal: controller.signal,
      release: () => {
        this.#requests.delete(controller);
        if (generation !== this.#generation && !controller.signal.aborted) {
          controller.abort();
        }
      },
    };
  }

  onRevoke(listener: () => void): () => void {
    this.#revokeListeners.add(listener);
    return () => this.#revokeListeners.delete(listener);
  }

  #revoke(): void {
    this.#generation += 1;
    this.#password = undefined;
    this.#enabledAtMs = undefined;
    this.#failures.clear();
    for (const controller of this.#requests) controller.abort();
    this.#requests.clear();
    for (const listener of this.#revokeListeners) listener();
  }

  #recordFailure(source: string, now: number): void {
    const existing = this.#failures.get(source);
    if (
      !existing ||
      now - existing.windowStartedAtMs >= FAILURE_WINDOW_MS
    ) {
      if (
        !this.#failures.has(source) &&
        this.#failures.size >= MAX_FAILURE_SOURCES
      ) {
        const oldest = this.#failures.keys().next().value as string | undefined;
        if (oldest) this.#failures.delete(oldest);
      }
      this.#failures.set(source, { count: 1, windowStartedAtMs: now });
      return;
    }
    existing.count += 1;
  }
}

export class WormholeRuntimeError extends Error {
  constructor(
    public readonly code: "WORMHOLE_DISABLED",
    message: string,
  ) {
    super(message);
    this.name = "WormholeRuntimeError";
  }
}

function generatePassword(
  readRandomBytes: (size: number) => Uint8Array,
): string {
  const limit = Math.floor(256 / PASSWORD_ALPHABET.length) *
    PASSWORD_ALPHABET.length;
  let password = "";
  while (password.length < PASSWORD_LENGTH) {
    const bytes = readRandomBytes(PASSWORD_LENGTH - password.length);
    if (bytes.byteLength === 0) {
      throw new Error("Secure random source returned no bytes.");
    }
    for (const byte of bytes) {
      if (byte >= limit) continue;
      password += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
      if (password.length === PASSWORD_LENGTH) break;
    }
  }
  return password;
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  const maximum = Math.max(leftBytes.byteLength, rightBytes.byteLength, 1);
  const paddedLeft = Buffer.alloc(maximum);
  const paddedRight = Buffer.alloc(maximum);
  leftBytes.copy(paddedLeft);
  rightBytes.copy(paddedRight);
  return timingSafeEqual(paddedLeft, paddedRight) &&
    leftBytes.byteLength === rightBytes.byteLength;
}
