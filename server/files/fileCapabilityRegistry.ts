import { randomBytes } from "node:crypto";
import type { IndexedEntry } from "./entryIndex.js";

export type FileCapabilityErrorCode =
  | "REQUEST_INVALID"
  | "HANDLE_NOT_FOUND"
  | "HANDLE_EXPIRED"
  | "PERMISSION_DENIED"
  | "CAPABILITY_LIMIT_REACHED";

export class FileCapabilityError extends Error {
  constructor(
    public readonly code: FileCapabilityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FileCapabilityError";
  }
}

interface InstanceRecord {
  token: string;
  appId: string;
  windowInstanceId: string;
  expiresAtMs: number;
}

interface HandleRecord {
  handleId: string;
  instanceToken: string;
  entryIdHex: string;
  writable: boolean;
  issuedAtRevision: number;
  expectedContentFidHex?: string;
  expiresAtMs: number;
}

export interface PublicFileHandle {
  handleId: string;
  writable: boolean;
  expiresAt: string;
  metadata: {
    entryId: string;
    name: string;
    kind: "directory" | "file";
    size?: number;
    mtimeMs: number;
    revision: number;
  };
}

export interface AuthorizedFileHandle {
  appId: string;
  windowInstanceId: string;
  entryIdHex: string;
  writable: boolean;
  issuedAtRevision: number;
  expectedContentFidHex?: string;
}

interface FileCapabilityRegistryOptions {
  now?: () => number;
  randomToken?: () => string;
  instanceTtlMs?: number;
  handleTtlMs?: number;
  maxInstances?: number;
  maxHandles?: number;
}

const APP_ID_PATTERN = /^[a-z0-9.-]{1,128}$/;
const WINDOW_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ENTRY_ID_PATTERN = /^[0-9a-f]{32}$/;

export class FileCapabilityRegistry {
  readonly #instances = new Map<string, InstanceRecord>();
  readonly #handles = new Map<string, HandleRecord>();
  readonly #now: () => number;
  readonly #randomToken: () => string;
  readonly #instanceTtlMs: number;
  readonly #handleTtlMs: number;
  readonly #maxInstances: number;
  readonly #maxHandles: number;

  constructor(options: FileCapabilityRegistryOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#randomToken =
      options.randomToken ?? (() => randomBytes(32).toString("base64url"));
    this.#instanceTtlMs = positive(
      options.instanceTtlMs ?? 12 * 60 * 60 * 1000,
      "instance TTL",
    );
    this.#handleTtlMs = positive(
      options.handleTtlMs ?? 30 * 60 * 1000,
      "handle TTL",
    );
    this.#maxInstances = positive(
      options.maxInstances ?? 256,
      "instance limit",
    );
    this.#maxHandles = positive(options.maxHandles ?? 4096, "handle limit");
  }

  createInstance(appId: string, windowInstanceId: string) {
    if (
      !APP_ID_PATTERN.test(appId) ||
      !WINDOW_ID_PATTERN.test(windowInstanceId)
    ) {
      throw invalid("App or window instance identity is invalid.");
    }
    this.prune();
    if (this.#instances.size >= this.#maxInstances) {
      throw limit("The active window instance limit has been reached.");
    }
    const token = this.#newUniqueToken(this.#instances);
    const expiresAtMs = this.#now() + this.#instanceTtlMs;
    this.#instances.set(token, {
      token,
      appId,
      windowInstanceId,
      expiresAtMs,
    });
    return {
      instanceToken: token,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  closeInstance(instanceToken: string): void {
    this.#instances.delete(instanceToken);
    for (const [handleId, handle] of this.#handles) {
      if (handle.instanceToken === instanceToken) {
        this.#handles.delete(handleId);
      }
    }
  }

  issueHandle(
    instanceToken: string,
    entry: IndexedEntry,
    revision: number,
    writable: boolean,
  ): PublicFileHandle {
    this.#requireInstance(instanceToken);
    if (
      !ENTRY_ID_PATTERN.test(entry.entryIdHex) ||
      !Number.isSafeInteger(revision) ||
      revision < 0
    ) {
      throw invalid("Entry identity or revision is invalid.");
    }
    if (writable && entry.kind !== "file") {
      throw new FileCapabilityError(
        "PERMISSION_DENIED",
        "Directory handles cannot be writable.",
      );
    }
    this.prune();
    if (this.#handles.size >= this.#maxHandles) {
      throw limit("The active file handle limit has been reached.");
    }
    const handleId = this.#newUniqueToken(this.#handles);
    const expiresAtMs = this.#now() + this.#handleTtlMs;
    this.#handles.set(handleId, {
      handleId,
      instanceToken,
      entryIdHex: entry.entryIdHex,
      writable,
      issuedAtRevision: revision,
      expectedContentFidHex: entry.content?.fidHex,
      expiresAtMs,
    });
    return {
      handleId,
      writable,
      expiresAt: new Date(expiresAtMs).toISOString(),
      metadata: {
        entryId: entry.entryIdHex,
        name: entry.name,
        kind: entry.kind,
        ...(entry.content ? { size: entry.content.size } : {}),
        mtimeMs: entry.mtimeMs,
        revision,
      },
    };
  }

  authorizeHandle(
    instanceToken: string,
    handleId: string,
    requireWritable = false,
  ): AuthorizedFileHandle {
    const instance = this.#requireInstance(instanceToken);
    if (!TOKEN_PATTERN.test(handleId)) {
      throw notFound();
    }
    const handle = this.#handles.get(handleId);
    if (!handle || handle.instanceToken !== instanceToken) {
      throw notFound();
    }
    if (handle.expiresAtMs <= this.#now()) {
      this.#handles.delete(handleId);
      throw new FileCapabilityError("HANDLE_EXPIRED", "File handle expired.");
    }
    if (requireWritable && !handle.writable) {
      throw new FileCapabilityError(
        "PERMISSION_DENIED",
        "File handle is read-only.",
      );
    }
    return {
      appId: instance.appId,
      windowInstanceId: instance.windowInstanceId,
      entryIdHex: handle.entryIdHex,
      writable: handle.writable,
      issuedAtRevision: handle.issuedAtRevision,
      expectedContentFidHex: handle.expectedContentFidHex,
    };
  }

  releaseHandle(instanceToken: string, handleId: string): void {
    this.#requireInstance(instanceToken);
    const handle = this.#handles.get(handleId);
    if (!handle || handle.instanceToken !== instanceToken) {
      throw notFound();
    }
    this.#handles.delete(handleId);
  }

  prune(): void {
    const now = this.#now();
    const expiredInstances = new Set<string>();
    for (const [token, instance] of this.#instances) {
      if (instance.expiresAtMs <= now) {
        this.#instances.delete(token);
        expiredInstances.add(token);
      }
    }
    for (const [handleId, handle] of this.#handles) {
      if (
        handle.expiresAtMs <= now ||
        expiredInstances.has(handle.instanceToken)
      ) {
        this.#handles.delete(handleId);
      }
    }
  }

  #requireInstance(token: string): InstanceRecord {
    if (!TOKEN_PATTERN.test(token)) {
      throw notFound();
    }
    const instance = this.#instances.get(token);
    if (!instance) {
      throw notFound();
    }
    if (instance.expiresAtMs <= this.#now()) {
      this.closeInstance(token);
      throw new FileCapabilityError(
        "HANDLE_EXPIRED",
        "Window instance expired.",
      );
    }
    return instance;
  }

  #newUniqueToken(records: Map<string, unknown>): string {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const token = this.#randomToken();
      if (TOKEN_PATTERN.test(token) && !records.has(token)) {
        return token;
      }
    }
    throw new FileCapabilityError(
      "CAPABILITY_LIMIT_REACHED",
      "Unable to allocate a unique capability.",
    );
  }
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function invalid(message: string): FileCapabilityError {
  return new FileCapabilityError("REQUEST_INVALID", message);
}

function notFound(): FileCapabilityError {
  return new FileCapabilityError("HANDLE_NOT_FOUND", "File handle not found.");
}

function limit(message: string): FileCapabilityError {
  return new FileCapabilityError("CAPABILITY_LIMIT_REACHED", message);
}
