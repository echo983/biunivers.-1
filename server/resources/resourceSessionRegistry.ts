import { randomBytes } from "node:crypto";
import type { FileContentRef } from "../files/fileContentStore.js";
import type { IndexedEntry } from "../files/entryIndex.js";

export type ResourceAccess = "read" | "edit";

export type ResourceSessionErrorCode =
  | "REQUEST_INVALID"
  | "RESOURCE_SESSION_NOT_FOUND"
  | "RESOURCE_SESSION_EXPIRED"
  | "RESOURCE_SESSION_REVOKED"
  | "RESOURCE_ACCESS_DENIED"
  | "RESOURCE_TRANSFER_TOO_LARGE"
  | "FILE_VERSION_CONFLICT"
  | "RESOURCE_SESSION_LIMIT_REACHED";

export class ResourceSessionError extends Error {
  constructor(
    public readonly code: ResourceSessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ResourceSessionError";
  }
}

interface PublicMetadata {
  name: string;
  size: number;
  mtimeMs: number;
  mediaType: string;
  contentVersion: string;
}

interface ResourceSessionRecord {
  sessionId: string;
  appId: string;
  access: ResourceAccess;
  entryIdHex?: string;
  pendingParentEntryIdHex?: string;
  pendingName?: string;
  content?: FileContentRef;
  expectedContentFidHex?: string;
  issuedAtRevision: number;
  metadata: PublicMetadata;
  createdAtMs: number;
  lastRenewedAtMs: number;
  expiresAtMs: number;
  activeUses: Map<string, AbortController>;
}

export interface PublicResourceSession {
  sessionId: string;
  access: ResourceAccess;
  expiresAt: string;
  metadata: PublicMetadata;
}

export interface AuthorizedResourceSession {
  sessionId: string;
  appId: string;
  access: ResourceAccess;
  entryIdHex?: string;
  pendingParentEntryIdHex?: string;
  pendingName?: string;
  content?: FileContentRef;
  expectedContentFidHex?: string;
  issuedAtRevision: number;
  metadata: PublicMetadata;
}

export interface ResourceSessionUse extends AuthorizedResourceSession {
  useId: string;
  signal: AbortSignal;
}

export interface ResourceRenewalResult {
  renewed: Array<{ sessionId: string; expiresAt: string }>;
  rejected: Array<{
    sessionId: string;
    code: "RESOURCE_SESSION_NOT_FOUND" | "RESOURCE_SESSION_EXPIRED";
  }>;
}

interface ResourceSessionRegistryOptions {
  now?: () => number;
  randomToken?: () => string;
  leaseTtlMs?: number;
  maxSessions?: number;
}

const APP_ID_PATTERN = /^[a-z0-9.-]{1,128}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ENTRY_ID_PATTERN = /^[0-9a-f]{32}$/;
const DEFAULT_MEDIA_TYPE = "application/octet-stream";

export class ResourceSessionRegistry {
  readonly #sessions = new Map<string, ResourceSessionRecord>();
  readonly #now: () => number;
  readonly #randomToken: () => string;
  readonly #leaseTtlMs: number;
  readonly #maxSessions: number;

  constructor(options: ResourceSessionRegistryOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#randomToken =
      options.randomToken ?? (() => randomBytes(32).toString("base64url"));
    this.#leaseTtlMs = positive(
      options.leaseTtlMs ?? 300_000,
      "lease TTL",
    );
    this.#maxSessions = positive(
      options.maxSessions ?? 4096,
      "session limit",
    );
  }

  issueFile(
    appId: string,
    entry: IndexedEntry,
    revision: number,
    access: ResourceAccess,
    mediaType = DEFAULT_MEDIA_TYPE,
  ): PublicResourceSession {
    validateAppId(appId);
    validateRevision(revision);
    validateAccess(access);
    if (
      entry.kind !== "file" ||
      !entry.content ||
      !ENTRY_ID_PATTERN.test(entry.entryIdHex)
    ) {
      throw invalid("Only a valid file can create a resource session.");
    }
    return this.#issue({
      appId,
      access,
      entryIdHex: entry.entryIdHex,
      content: { ...entry.content },
      expectedContentFidHex: entry.content.fidHex,
      issuedAtRevision: revision,
      name: entry.name,
      size: entry.content.size,
      mtimeMs: entry.mtimeMs,
      mediaType,
    });
  }

  issueFiles(
    appId: string,
    entries: readonly IndexedEntry[],
    revision: number,
    access: "read",
    mediaTypes: readonly string[],
  ): PublicResourceSession[] {
    validateAppId(appId);
    validateRevision(revision);
    if (
      entries.length < 2 ||
      entries.length > 100 ||
      entries.length !== mediaTypes.length
    ) {
      throw invalid("Resource session batch must contain 2 to 100 files.");
    }
    if (
      entries.some(
        (entry) =>
          entry.kind !== "file" ||
          !entry.content ||
          !ENTRY_ID_PATTERN.test(entry.entryIdHex),
      )
    ) {
      throw invalid("Only valid files can create resource sessions.");
    }
    this.prune();
    if (this.#sessions.size + entries.length > this.#maxSessions) {
      throw new ResourceSessionError(
        "RESOURCE_SESSION_LIMIT_REACHED",
        "Active resource session limit has been reached.",
      );
    }

    const issued: PublicResourceSession[] = [];
    try {
      entries.forEach((entry, index) => {
        issued.push(
          this.issueFile(appId, entry, revision, access, mediaTypes[index]),
        );
      });
      return issued;
    } catch (error) {
      for (const session of issued) {
        this.#sessions.delete(session.sessionId);
      }
      throw error;
    }
  }

  issuePendingFile(
    appId: string,
    parentEntryIdHex: string,
    name: string,
    revision: number,
    mediaType = DEFAULT_MEDIA_TYPE,
  ): PublicResourceSession {
    validateAppId(appId);
    validateRevision(revision);
    if (!ENTRY_ID_PATTERN.test(parentEntryIdHex) || !name) {
      throw invalid("Pending file target is invalid.");
    }
    return this.#issue({
      appId,
      access: "edit",
      pendingParentEntryIdHex: parentEntryIdHex,
      pendingName: name,
      issuedAtRevision: revision,
      name,
      size: 0,
      mtimeMs: 0,
      mediaType,
    });
  }

  authorize(
    appId: string,
    sessionId: string,
    requiredAccess: ResourceAccess = "read",
  ): AuthorizedResourceSession {
    const session = this.#require(appId, sessionId);
    if (requiredAccess === "edit" && session.access !== "edit") {
      throw new ResourceSessionError(
        "RESOURCE_ACCESS_DENIED",
        "Resource session does not allow editing.",
      );
    }
    return snapshot(session);
  }

  beginUse(
    appId: string,
    sessionId: string,
    requiredAccess: ResourceAccess = "read",
  ): ResourceSessionUse {
    const authorized = this.authorize(appId, sessionId, requiredAccess);
    const session = this.#sessions.get(sessionId)!;
    const useId = this.#newUniqueToken();
    const controller = new AbortController();
    session.activeUses.set(useId, controller);
    return {
      ...authorized,
      useId,
      signal: controller.signal,
    };
  }

  finishUse(use: ResourceSessionUse, successful: boolean): void {
    const session = this.#sessions.get(use.sessionId);
    if (!session || session.appId !== use.appId) {
      return;
    }
    session.activeUses.delete(use.useId);
    if (successful) {
      this.#renew(session);
    } else if (
      session.expiresAtMs <= this.#now() &&
      session.activeUses.size === 0
    ) {
      this.#sessions.delete(session.sessionId);
    }
  }

  touch(appId: string, sessionId: string): PublicResourceSession {
    const session = this.#require(appId, sessionId);
    this.#renew(session);
    return publicSession(session);
  }

  renew(appId: string, sessionIds: readonly string[]): ResourceRenewalResult {
    validateAppId(appId);
    if (sessionIds.length > this.#maxSessions) {
      throw invalid("Renewal batch exceeds the resource session limit.");
    }
    const renewed: ResourceRenewalResult["renewed"] = [];
    const rejected: ResourceRenewalResult["rejected"] = [];
    for (const sessionId of new Set(sessionIds)) {
      if (!TOKEN_PATTERN.test(sessionId)) {
        rejected.push({
          sessionId,
          code: "RESOURCE_SESSION_NOT_FOUND",
        });
        continue;
      }
      const session = this.#sessions.get(sessionId);
      if (!session || session.appId !== appId) {
        rejected.push({
          sessionId,
          code: "RESOURCE_SESSION_NOT_FOUND",
        });
        continue;
      }
      if (session.expiresAtMs <= this.#now()) {
        if (session.activeUses.size === 0) {
          this.#sessions.delete(sessionId);
        }
        rejected.push({
          sessionId,
          code: "RESOURCE_SESSION_EXPIRED",
        });
        continue;
      }
      this.#renew(session);
      renewed.push({
        sessionId,
        expiresAt: new Date(session.expiresAtMs).toISOString(),
      });
    }
    return { renewed, rejected };
  }

  release(appId: string, sessionIds: readonly string[]): void {
    validateAppId(appId);
    for (const sessionId of new Set(sessionIds)) {
      const session = this.#sessions.get(sessionId);
      if (!session || session.appId !== appId) {
        continue;
      }
      this.#abortAndDelete(session);
    }
  }

  revokeApp(appId: string): void {
    validateAppId(appId);
    for (const session of this.#sessions.values()) {
      if (session.appId === appId) {
        this.#abortAndDelete(session);
      }
    }
  }

  advanceAfterSave(
    appId: string,
    sessionId: string,
    entry: IndexedEntry,
    revision: number,
  ): PublicResourceSession {
    validateRevision(revision);
    const session = this.#require(appId, sessionId);
    if (session.access !== "edit") {
      throw new ResourceSessionError(
        "RESOURCE_ACCESS_DENIED",
        "Resource session does not allow editing.",
      );
    }
    if (entry.kind !== "file" || !entry.content) {
      throw invalid("Saved resource is not a valid file.");
    }
    session.entryIdHex = entry.entryIdHex;
    session.content = { ...entry.content };
    session.expectedContentFidHex = entry.content.fidHex;
    session.issuedAtRevision = revision;
    session.metadata = {
      ...session.metadata,
      name: entry.name,
      size: entry.content.size,
      mtimeMs: entry.mtimeMs,
      contentVersion: this.#newUniqueToken(),
    };
    delete session.pendingParentEntryIdHex;
    delete session.pendingName;
    this.#renew(session);
    return publicSession(session);
  }

  prune(): void {
    const now = this.#now();
    for (const session of this.#sessions.values()) {
      if (session.expiresAtMs <= now && session.activeUses.size === 0) {
        this.#sessions.delete(session.sessionId);
      }
    }
  }

  #issue(input: {
    appId: string;
    access: ResourceAccess;
    entryIdHex?: string;
    pendingParentEntryIdHex?: string;
    pendingName?: string;
    content?: FileContentRef;
    expectedContentFidHex?: string;
    issuedAtRevision: number;
    name: string;
    size: number;
    mtimeMs: number;
    mediaType: string;
  }): PublicResourceSession {
    this.prune();
    if (this.#sessions.size >= this.#maxSessions) {
      throw new ResourceSessionError(
        "RESOURCE_SESSION_LIMIT_REACHED",
        "Active resource session limit has been reached.",
      );
    }
    const now = this.#now();
    const sessionId = this.#newUniqueToken();
    const publicContentVersion = this.#newUniqueToken(new Set([sessionId]));
    const session: ResourceSessionRecord = {
      sessionId,
      appId: input.appId,
      access: input.access,
      entryIdHex: input.entryIdHex,
      pendingParentEntryIdHex: input.pendingParentEntryIdHex,
      pendingName: input.pendingName,
      content: input.content,
      expectedContentFidHex: input.expectedContentFidHex,
      issuedAtRevision: input.issuedAtRevision,
      metadata: {
        name: input.name,
        size: input.size,
        mtimeMs: input.mtimeMs,
        mediaType: normalizeMediaType(input.mediaType),
        contentVersion: publicContentVersion,
      },
      createdAtMs: now,
      lastRenewedAtMs: now,
      expiresAtMs: now + this.#leaseTtlMs,
      activeUses: new Map(),
    };
    this.#sessions.set(sessionId, session);
    return publicSession(session);
  }

  #require(appId: string, sessionId: string): ResourceSessionRecord {
    validateAppId(appId);
    if (!TOKEN_PATTERN.test(sessionId)) {
      throw notFound();
    }
    const session = this.#sessions.get(sessionId);
    if (!session || session.appId !== appId) {
      throw notFound();
    }
    if (session.expiresAtMs <= this.#now()) {
      if (session.activeUses.size === 0) {
        this.#sessions.delete(sessionId);
      }
      throw new ResourceSessionError(
        "RESOURCE_SESSION_EXPIRED",
        "Resource session lease expired.",
      );
    }
    return session;
  }

  #renew(session: ResourceSessionRecord): void {
    const now = this.#now();
    session.lastRenewedAtMs = now;
    session.expiresAtMs = now + this.#leaseTtlMs;
  }

  #abortAndDelete(session: ResourceSessionRecord): void {
    for (const controller of session.activeUses.values()) {
      controller.abort();
    }
    this.#sessions.delete(session.sessionId);
  }

  #newUniqueToken(excluded = new Set<string>()): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = this.#randomToken();
      if (
        TOKEN_PATTERN.test(token) &&
        !excluded.has(token) &&
        !this.#sessions.has(token) &&
        ![...this.#sessions.values()].some(
          (session) =>
            session.metadata.contentVersion === token ||
            session.activeUses.has(token),
        )
      ) {
        return token;
      }
    }
    throw new ResourceSessionError(
      "RESOURCE_SESSION_LIMIT_REACHED",
      "Unable to allocate a unique resource session token.",
    );
  }
}

function snapshot(session: ResourceSessionRecord): AuthorizedResourceSession {
  return {
    sessionId: session.sessionId,
    appId: session.appId,
    access: session.access,
    entryIdHex: session.entryIdHex,
    pendingParentEntryIdHex: session.pendingParentEntryIdHex,
    pendingName: session.pendingName,
    content: session.content ? { ...session.content } : undefined,
    expectedContentFidHex: session.expectedContentFidHex,
    issuedAtRevision: session.issuedAtRevision,
    metadata: { ...session.metadata },
  };
}

function publicSession(session: ResourceSessionRecord): PublicResourceSession {
  return {
    sessionId: session.sessionId,
    access: session.access,
    expiresAt: new Date(session.expiresAtMs).toISOString(),
    metadata: { ...session.metadata },
  };
}

function validateAppId(appId: string): void {
  if (!APP_ID_PATTERN.test(appId)) {
    throw invalid("App identity is invalid.");
  }
}

function validateRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw invalid("File revision is invalid.");
  }
}

function validateAccess(access: ResourceAccess): void {
  if (access !== "read" && access !== "edit") {
    throw invalid("Resource access is invalid.");
  }
}

function normalizeMediaType(mediaType: string): string {
  const value = mediaType.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value)
    ? value
    : DEFAULT_MEDIA_TYPE;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function invalid(message: string): ResourceSessionError {
  return new ResourceSessionError("REQUEST_INVALID", message);
}

function notFound(): ResourceSessionError {
  return new ResourceSessionError(
    "RESOURCE_SESSION_NOT_FOUND",
    "Resource session was not found.",
  );
}
