import { randomUUID } from "node:crypto";

const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_LOCKS = 1024;

interface Lock {
  token: string;
  path: string;
  owner: string;
  expiresAtMs: number;
}

export class WormholeLockRegistry {
  readonly #locks = new Map<string, Lock>();

  lock(path: string, owner: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    this.#purge();
    const existing = this.#locks.get(path);
    if (existing) return existing;
    if (this.#locks.size >= MAX_LOCKS) throw new WormholeLockError("LIMIT");
    const lock = {
      token: `opaquelocktoken:${randomUUID()}`,
      path,
      owner: owner.slice(0, 256),
      expiresAtMs: Date.now() + Math.min(timeoutSeconds, 3600) * 1000,
    };
    this.#locks.set(path, lock);
    return lock;
  }

  refresh(path: string, token: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
    this.#purge();
    const lock = this.#locks.get(path);
    if (!lock || lock.token !== token) throw new WormholeLockError("MISSING");
    lock.expiresAtMs = Date.now() + Math.min(timeoutSeconds, 3600) * 1000;
    return lock;
  }

  unlock(path: string, token: string) {
    this.#purge();
    const lock = this.#locks.get(path);
    if (!lock || lock.token !== token) throw new WormholeLockError("MISSING");
    this.#locks.delete(path);
  }

  assertAllowed(path: string, submittedTokens: string) {
    this.#purge();
    for (const lock of this.#locks.values()) {
      if (
        (path === lock.path || path.startsWith(`${lock.path}/`)) &&
        !submittedTokens.includes(lock.token)
      ) {
        throw new WormholeLockError("LOCKED");
      }
    }
  }

  clear() {
    this.#locks.clear();
  }

  #purge() {
    const now = Date.now();
    for (const [path, lock] of this.#locks) {
      if (lock.expiresAtMs <= now) this.#locks.delete(path);
    }
  }
}

export class WormholeLockError extends Error {
  constructor(public readonly code: "LOCKED" | "MISSING" | "LIMIT") {
    super(code);
  }
}
