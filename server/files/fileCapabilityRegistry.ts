import { randomBytes } from "node:crypto";
import type { IndexedEntry } from "./entryIndex.js";

export type FileCapabilityErrorCode =
  | "REQUEST_INVALID"
  | "HANDLE_NOT_FOUND"
  | "HANDLE_EXPIRED"
  | "TRANSFER_NOT_FOUND"
  | "TRANSFER_EXPIRED"
  | "TRANSFER_TOO_LARGE"
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
  entryIdHex?: string;
  pendingParentEntryIdHex?: string;
  pendingName?: string;
  writable: boolean;
  issuedAtRevision: number;
  expectedContentFidHex?: string;
  contentSize?: number;
  expiresAtMs: number;
}

interface TransferRecord {
  transferId: string;
  instanceToken: string;
  handleId: string;
  method: "GET" | "PUT";
  maxBytes: number;
  expiresAtMs: number;
  active: boolean;
}

export interface PublicFileHandle {
  handleId: string;
  writable: boolean;
  expiresAt: string;
  metadata: {
    entryId?: string;
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
  entryIdHex?: string;
  pendingParentEntryIdHex?: string;
  pendingName?: string;
  writable: boolean;
  issuedAtRevision: number;
  expectedContentFidHex?: string;
  contentSize?: number;
}

export interface PublicFileTransfer {
  transferId: string;
  method: "GET" | "PUT";
  expiresAt: string;
  maxBytes: number;
}

export interface AuthorizedFileTransfer extends AuthorizedFileHandle {
  handleId: string;
  transferId: string;
  method: "GET" | "PUT";
  maxBytes: number;
}

export interface FileTransferIdentity {
  appId: string;
  method: "GET" | "PUT";
}

export interface FileInstanceIdentity {
  appId: string;
  windowInstanceId: string;
}

interface FileCapabilityRegistryOptions {
  now?: () => number;
  randomToken?: () => string;
  instanceTtlMs?: number;
  handleTtlMs?: number;
  transferTtlMs?: number;
  maxInstances?: number;
  maxHandles?: number;
  maxTransfers?: number;
}

const APP_ID_PATTERN = /^[a-z0-9.-]{1,128}$/;
const WINDOW_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ENTRY_ID_PATTERN = /^[0-9a-f]{32}$/;

export class FileCapabilityRegistry {
  readonly #instances = new Map<string, InstanceRecord>();
  readonly #handles = new Map<string, HandleRecord>();
  readonly #transfers = new Map<string, TransferRecord>();
  readonly #now: () => number;
  readonly #randomToken: () => string;
  readonly #instanceTtlMs: number;
  readonly #handleTtlMs: number;
  readonly #transferTtlMs: number;
  readonly #maxInstances: number;
  readonly #maxHandles: number;
  readonly #maxTransfers: number;

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
    this.#transferTtlMs = positive(
      options.transferTtlMs ?? 5 * 60 * 1000,
      "transfer TTL",
    );
    this.#maxInstances = positive(
      options.maxInstances ?? 256,
      "instance limit",
    );
    this.#maxHandles = positive(options.maxHandles ?? 4096, "handle limit");
    this.#maxTransfers = positive(
      options.maxTransfers ?? 1024,
      "transfer limit",
    );
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
    const token = this.#newUniqueToken();
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
    for (const [transferId, transfer] of this.#transfers) {
      if (transfer.instanceToken === instanceToken) {
        this.#transfers.delete(transferId);
      }
    }
  }

  authorizeInstance(instanceToken: string): FileInstanceIdentity {
    const instance = this.#requireInstance(instanceToken);
    return {
      appId: instance.appId,
      windowInstanceId: instance.windowInstanceId,
    };
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
    const handleId = this.#newUniqueToken();
    const expiresAtMs = this.#now() + this.#handleTtlMs;
    this.#handles.set(handleId, {
      handleId,
      instanceToken,
      entryIdHex: entry.entryIdHex,
      writable,
      issuedAtRevision: revision,
      expectedContentFidHex: entry.content?.fidHex,
      contentSize: entry.content?.size,
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

  issuePendingFileHandle(
    instanceToken: string,
    parentEntryIdHex: string,
    name: string,
    revision: number,
  ): PublicFileHandle {
    this.#requireInstance(instanceToken);
    if (
      !ENTRY_ID_PATTERN.test(parentEntryIdHex) ||
      !Number.isSafeInteger(revision) ||
      revision < 0
    ) {
      throw invalid("Parent identity or revision is invalid.");
    }
    this.prune();
    if (this.#handles.size >= this.#maxHandles) {
      throw limit("The active file handle limit has been reached.");
    }
    const handleId = this.#newUniqueToken();
    const expiresAtMs = this.#now() + this.#handleTtlMs;
    this.#handles.set(handleId, {
      handleId,
      instanceToken,
      pendingParentEntryIdHex: parentEntryIdHex,
      pendingName: name,
      writable: true,
      issuedAtRevision: revision,
      expiresAtMs,
    });
    return {
      handleId,
      writable: true,
      expiresAt: new Date(expiresAtMs).toISOString(),
      metadata: {
        name,
        kind: "file",
        size: 0,
        mtimeMs: 0,
        revision,
      },
    };
  }

  commitPendingFileHandle(
    instanceToken: string,
    handleId: string,
    entry: IndexedEntry,
    revision: number,
  ): void {
    this.#requireInstance(instanceToken);
    const handle = this.#handles.get(handleId);
    if (
      !handle ||
      handle.instanceToken !== instanceToken ||
      !handle.pendingParentEntryIdHex ||
      !handle.pendingName ||
      entry.kind !== "file" ||
      !entry.content
    ) {
      throw notFound();
    }
    handle.entryIdHex = entry.entryIdHex;
    handle.expectedContentFidHex = entry.content.fidHex;
    handle.contentSize = entry.content.size;
    handle.issuedAtRevision = revision;
    delete handle.pendingParentEntryIdHex;
    delete handle.pendingName;
  }

  inspectTransfer(transferId: string): FileTransferIdentity {
    if (!TOKEN_PATTERN.test(transferId)) {
      throw transferNotFound();
    }
    const transfer = this.#transfers.get(transferId);
    if (!transfer || transfer.active) {
      throw transferNotFound();
    }
    if (transfer.expiresAtMs <= this.#now()) {
      this.#transfers.delete(transferId);
      throw new FileCapabilityError(
        "TRANSFER_EXPIRED",
        "File transfer expired.",
      );
    }
    const instance = this.#instances.get(transfer.instanceToken);
    if (!instance || instance.expiresAtMs <= this.#now()) {
      this.prune();
      throw transferNotFound();
    }
    return { appId: instance.appId, method: transfer.method };
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
      pendingParentEntryIdHex: handle.pendingParentEntryIdHex,
      pendingName: handle.pendingName,
      writable: handle.writable,
      issuedAtRevision: handle.issuedAtRevision,
      expectedContentFidHex: handle.expectedContentFidHex,
      contentSize: handle.contentSize,
    };
  }

  releaseHandle(instanceToken: string, handleId: string): void {
    this.#requireInstance(instanceToken);
    const handle = this.#handles.get(handleId);
    if (!handle || handle.instanceToken !== instanceToken) {
      throw notFound();
    }
    this.#handles.delete(handleId);
    for (const [transferId, transfer] of this.#transfers) {
      if (transfer.handleId === handleId) {
        this.#transfers.delete(transferId);
      }
    }
  }

  issueTransfer(
    instanceToken: string,
    handleId: string,
    method: "GET" | "PUT",
    maxBytes: number,
  ): PublicFileTransfer {
    const handle = this.authorizeHandle(
      instanceToken,
      handleId,
      method === "PUT",
    );
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw invalid("Transfer byte limit is invalid.");
    }
    if (method === "GET") {
      if (handle.contentSize === undefined) {
        throw new FileCapabilityError(
          "PERMISSION_DENIED",
          "Directory handles cannot create content transfers.",
        );
      }
      maxBytes = handle.contentSize;
    } else if (maxBytes === 0) {
      throw invalid("Write transfer byte limit must be positive.");
    }
    this.prune();
    if (this.#transfers.size >= this.#maxTransfers) {
      throw limit("The active file transfer limit has been reached.");
    }
    const transferId = this.#newUniqueToken();
    const expiresAtMs = this.#now() + this.#transferTtlMs;
    this.#transfers.set(transferId, {
      transferId,
      instanceToken,
      handleId,
      method,
      maxBytes,
      expiresAtMs,
      active: false,
    });
    return {
      transferId,
      method,
      expiresAt: new Date(expiresAtMs).toISOString(),
      maxBytes,
    };
  }

  beginTransfer(
    instanceToken: string,
    transferId: string,
    method: "GET" | "PUT",
    contentLength?: number,
  ): AuthorizedFileTransfer {
    this.#requireInstance(instanceToken);
    if (!TOKEN_PATTERN.test(transferId)) {
      throw transferNotFound();
    }
    const transfer = this.#transfers.get(transferId);
    if (
      !transfer ||
      transfer.instanceToken !== instanceToken ||
      transfer.method !== method ||
      transfer.active
    ) {
      throw transferNotFound();
    }
    if (transfer.expiresAtMs <= this.#now()) {
      this.#transfers.delete(transferId);
      throw new FileCapabilityError(
        "TRANSFER_EXPIRED",
        "File transfer expired.",
      );
    }
    if (
      contentLength !== undefined &&
      (!Number.isSafeInteger(contentLength) ||
        contentLength < 0 ||
        contentLength > transfer.maxBytes)
    ) {
      throw new FileCapabilityError(
        "TRANSFER_TOO_LARGE",
        "Transfer exceeds its byte limit.",
      );
    }
    const handle = this.authorizeHandle(
      instanceToken,
      transfer.handleId,
      method === "PUT",
    );
    transfer.active = true;
    return {
      ...handle,
      handleId: transfer.handleId,
      transferId,
      method,
      maxBytes: transfer.maxBytes,
    };
  }

  finishTransfer(instanceToken: string, transferId: string): void {
    const transfer = this.#transfers.get(transferId);
    if (!transfer || transfer.instanceToken !== instanceToken) {
      throw transferNotFound();
    }
    this.#transfers.delete(transferId);
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
    for (const [transferId, transfer] of this.#transfers) {
      if (
        transfer.expiresAtMs <= now ||
        !this.#instances.has(transfer.instanceToken) ||
        !this.#handles.has(transfer.handleId)
      ) {
        this.#transfers.delete(transferId);
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

  #newUniqueToken(): string {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const token = this.#randomToken();
      if (
        TOKEN_PATTERN.test(token) &&
        !this.#instances.has(token) &&
        !this.#handles.has(token) &&
        !this.#transfers.has(token)
      ) {
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

function transferNotFound(): FileCapabilityError {
  return new FileCapabilityError(
    "TRANSFER_NOT_FOUND",
    "File transfer not found.",
  );
}
