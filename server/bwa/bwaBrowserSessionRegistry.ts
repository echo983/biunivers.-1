import { createHash, randomBytes } from "node:crypto";

const INSTANCE_ID_PATTERN = /^[0-9a-f]{32}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_TICKET_TTL_MS = 30_000;
const DEFAULT_SESSION_IDLE_MS = 12 * 60 * 60 * 1000;

interface TicketRecord {
  instanceIdHex: string;
  expiresAtMs: number;
}

interface SessionRecord {
  instanceIdHex: string;
  touchedAtMs: number;
}

export class BwaBrowserSessionError extends Error {
  constructor(
    public readonly code:
      | "BOOTSTRAP_INVALID"
      | "SESSION_INVALID"
      | "SESSION_LIMIT_REACHED",
    message: string,
  ) {
    super(message);
    this.name = "BwaBrowserSessionError";
  }
}

export class BwaBrowserSessionRegistry {
  readonly #tickets = new Map<string, TicketRecord>();
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #now: () => number;
  readonly #random: (bytes: number) => Buffer;
  readonly #ticketTtlMs: number;
  readonly #sessionIdleMs: number;
  readonly #maximumTickets: number;
  readonly #maximumSessions: number;

  constructor(options: {
    now?: () => number;
    random?: (bytes: number) => Buffer;
    ticketTtlMs?: number;
    sessionIdleMs?: number;
    maximumTickets?: number;
    maximumSessions?: number;
  } = {}) {
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? randomBytes;
    this.#ticketTtlMs = positive(options.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS);
    this.#sessionIdleMs = positive(options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS);
    this.#maximumTickets = positive(options.maximumTickets ?? 4096);
    this.#maximumSessions = positive(options.maximumSessions ?? 4096);
  }

  issueBootstrap(instanceIdHex: string): { ticket: string; expiresAtMs: number } {
    validateInstanceId(instanceIdHex);
    const now = this.#timestamp();
    this.prune(now);
    if (this.#tickets.size >= this.#maximumTickets) throw limitReached();
    const ticket = this.#token();
    const expiresAtMs = now + this.#ticketTtlMs;
    this.#tickets.set(digest(ticket), { instanceIdHex, expiresAtMs });
    return { ticket, expiresAtMs };
  }

  consumeBootstrap(instanceIdHex: string, ticket: string): {
    session: string;
    idleExpiresAtMs: number;
  } {
    validateInstanceId(instanceIdHex);
    validateToken(ticket);
    const now = this.#timestamp();
    this.prune(now);
    const key = digest(ticket);
    const record = this.#tickets.get(key);
    this.#tickets.delete(key);
    if (!record || record.instanceIdHex !== instanceIdHex || record.expiresAtMs <= now) {
      throw new BwaBrowserSessionError("BOOTSTRAP_INVALID", "BWA bootstrap ticket is invalid.");
    }
    if (this.#sessions.size >= this.#maximumSessions) throw limitReached();
    const session = this.#token();
    this.#sessions.set(digest(session), { instanceIdHex, touchedAtMs: now });
    return { session, idleExpiresAtMs: now + this.#sessionIdleMs };
  }

  authorize(instanceIdHex: string, session: string): void {
    validateInstanceId(instanceIdHex);
    validateToken(session);
    const now = this.#timestamp();
    const key = digest(session);
    const record = this.#sessions.get(key);
    if (!record || record.instanceIdHex !== instanceIdHex) {
      throw new BwaBrowserSessionError("SESSION_INVALID", "BWA browser session is invalid.");
    }
    if (record.touchedAtMs + this.#sessionIdleMs <= now) {
      this.#sessions.delete(key);
      throw new BwaBrowserSessionError("SESSION_INVALID", "BWA browser session is invalid.");
    }
    record.touchedAtMs = now;
  }

  revokeInstance(instanceIdHex: string): void {
    validateInstanceId(instanceIdHex);
    for (const [key, record] of this.#tickets) {
      if (record.instanceIdHex === instanceIdHex) this.#tickets.delete(key);
    }
    for (const [key, record] of this.#sessions) {
      if (record.instanceIdHex === instanceIdHex) this.#sessions.delete(key);
    }
  }

  prune(now = this.#timestamp()): void {
    for (const [key, record] of this.#tickets) {
      if (record.expiresAtMs <= now) this.#tickets.delete(key);
    }
    for (const [key, record] of this.#sessions) {
      if (record.touchedAtMs + this.#sessionIdleMs <= now) this.#sessions.delete(key);
    }
  }

  #token(): string {
    const bytes = this.#random(32);
    if (bytes.byteLength !== 32 || bytes.every((byte) => byte === 0)) {
      throw new Error("BWA browser token generation failed.");
    }
    return bytes.toString("base64url");
  }

  #timestamp(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("BWA browser session timestamp is invalid.");
    }
    return value;
  }
}

export function bwaSessionCookieName(origin: string): string {
  return new URL(origin).protocol === "https:"
    ? "__Host-biunivers-bwa"
    : "biunivers-bwa-session";
}

function digest(token: string): string {
  return createHash("sha256").update(token, "ascii").digest("hex");
}

function validateToken(value: string): void {
  if (!TOKEN_PATTERN.test(value)) {
    throw new BwaBrowserSessionError("SESSION_INVALID", "BWA browser token is invalid.");
  }
}

function validateInstanceId(value: string): void {
  if (!INSTANCE_ID_PATTERN.test(value) || value === "0".repeat(32)) {
    throw new Error("BWA Instance ID is invalid.");
  }
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("BWA browser session limit is invalid.");
  }
  return value;
}

function limitReached(): BwaBrowserSessionError {
  return new BwaBrowserSessionError(
    "SESSION_LIMIT_REACHED",
    "BWA browser session capacity was reached.",
  );
}
