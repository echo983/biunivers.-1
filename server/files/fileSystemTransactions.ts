import { randomBytes } from "node:crypto";
import {
  encodeBatchFileSystemSegment,
  type BatchFileSystemOperation,
} from "./batchFileSystemSegment.js";
import type { FileContentRef } from "./fileContentStore.js";
import type { ImmutableObjectRepository } from "./immutableObjectRepository.js";
import { ObjectStoreError } from "./objectStore.js";
import { loadPvlogCore, type PvlogCore } from "./pvlogCore.js";
import {
  RefStoreError,
  SqliteRefStore,
  type FilesystemRef,
  type RefGuardInput,
} from "./sqliteRefStore.js";

interface TransactionServiceOptions {
  repository: ImmutableObjectRepository;
  refStore: SqliteRefStore;
  refId: string;
  writerId: string;
  core?: PvlogCore;
  now?: () => number;
  randomId?: () => Uint8Array;
  beforePublish?: () => Promise<void>;
}

export interface CreateFileInput {
  parentEntryIdHex: string;
  name: string;
  content: FileContentRef;
  mtimeMs?: number;
  expectedRevision?: number;
}

export interface SetFileContentInput {
  entryIdHex: string;
  expectedContentFidHex: string;
  content: FileContentRef;
  mtimeMs?: number;
}

export interface CreateDirectoryInput {
  parentEntryIdHex: string;
  name: string;
  mtimeMs?: number;
  expectedRevision?: number;
}

export interface MoveEntryInput {
  entryIdHex: string;
  newParentEntryIdHex: string;
  newName: string;
  timestampMs?: number;
  expectedRevision?: number;
}

export interface RemoveEntryInput {
  entryIdHex: string;
  recursive: boolean;
  timestampMs?: number;
  expectedRevision?: number;
}

export type { BatchFileSystemOperation } from "./batchFileSystemSegment.js";

export interface PublishedFileSystemTransaction {
  ref: FilesystemRef;
  entryIdHex: string;
  segmentFidHex: string;
  checkpointFidHex: string;
}

interface CurrentFileSystemState {
  ref: FilesystemRef;
  headBytes: Uint8Array;
  checkpointBytes: Uint8Array;
  lineageId: Uint8Array;
  lastSegmentFid: Uint8Array;
}

export class FileSystemTransactions {
  readonly #repository: ImmutableObjectRepository;
  readonly #refStore: SqliteRefStore;
  readonly #refId: string;
  readonly #writerId: string;
  readonly #core: PvlogCore;
  readonly #now: () => number;
  readonly #randomId: () => Uint8Array;
  readonly #beforePublish?: () => Promise<void>;

  constructor(options: TransactionServiceOptions) {
    this.#repository = options.repository;
    this.#refStore = options.refStore;
    this.#refId = options.refId;
    this.#writerId = options.writerId;
    this.#core = options.core ?? loadPvlogCore();
    this.#now = options.now ?? Date.now;
    this.#randomId = options.randomId ?? (() => randomBytes(16));
    this.#beforePublish = options.beforePublish;
  }

  async createFile(
    input: CreateFileInput,
  ): Promise<PublishedFileSystemTransaction> {
    const state = await this.#loadCurrentState(input.expectedRevision);
    const entryId = requireId(this.#randomId(), "Entry ID");
    const transactionId = requireId(this.#randomId(), "transaction ID");
    const timestamp = input.mtimeMs ?? this.#now();
    validateTimestamp(timestamp);
    const segmentBytes = this.#core.encodeCreateFileSegment(
      state.lineageId,
      Buffer.from(state.ref.headFidHex, "hex"),
      state.lastSegmentFid,
      BigInt(state.ref.revision + 1),
      transactionId,
      BigInt(timestamp),
      this.#writerId,
      entryId,
      hexId(input.parentEntryIdHex, "parent Entry ID"),
      input.name,
      contentKind(input.content),
      Buffer.from(input.content.fidHex, "hex"),
      BigInt(input.content.size),
      BigInt(timestamp),
    );
    return await this.#publish(
      state,
      segmentBytes,
      Buffer.from(entryId).toString("hex"),
      timestamp,
    );
  }

  async setFileContent(
    input: SetFileContentInput,
  ): Promise<PublishedFileSystemTransaction> {
    const state = await this.#loadCurrentState();
    const transactionId = requireId(this.#randomId(), "transaction ID");
    const timestamp = input.mtimeMs ?? this.#now();
    validateTimestamp(timestamp);
    const entryId = hexId(input.entryIdHex, "Entry ID");
    const segmentBytes = this.#core.encodeSetFileContentSegment(
      state.lineageId,
      Buffer.from(state.ref.headFidHex, "hex"),
      state.lastSegmentFid,
      BigInt(state.ref.revision + 1),
      transactionId,
      BigInt(timestamp),
      this.#writerId,
      entryId,
      hexId(input.expectedContentFidHex, "expected content FID"),
      contentKind(input.content),
      Buffer.from(input.content.fidHex, "hex"),
      BigInt(input.content.size),
      BigInt(timestamp),
    );
    return await this.#publish(
      state,
      segmentBytes,
      input.entryIdHex,
      timestamp,
    );
  }

  async createDirectory(
    input: CreateDirectoryInput,
  ): Promise<PublishedFileSystemTransaction> {
    const state = await this.#loadCurrentState(input.expectedRevision);
    const entryId = requireId(this.#randomId(), "Entry ID");
    const transactionId = requireId(this.#randomId(), "transaction ID");
    const timestamp = input.mtimeMs ?? this.#now();
    validateTimestamp(timestamp);
    const segmentBytes = this.#core.encodeCreateDirectorySegment(
      state.lineageId,
      Buffer.from(state.ref.headFidHex, "hex"),
      state.lastSegmentFid,
      BigInt(state.ref.revision + 1),
      transactionId,
      BigInt(timestamp),
      this.#writerId,
      entryId,
      hexId(input.parentEntryIdHex, "parent Entry ID"),
      input.name,
      BigInt(timestamp),
    );
    return await this.#publish(
      state,
      segmentBytes,
      Buffer.from(entryId).toString("hex"),
      timestamp,
    );
  }

  async moveEntry(
    input: MoveEntryInput,
  ): Promise<PublishedFileSystemTransaction> {
    const state = await this.#loadCurrentState(input.expectedRevision);
    const transactionId = requireId(this.#randomId(), "transaction ID");
    const timestamp = input.timestampMs ?? this.#now();
    validateTimestamp(timestamp);
    const segmentBytes = this.#core.encodeMoveEntrySegment(
      state.lineageId,
      Buffer.from(state.ref.headFidHex, "hex"),
      state.lastSegmentFid,
      BigInt(state.ref.revision + 1),
      transactionId,
      BigInt(timestamp),
      this.#writerId,
      hexId(input.entryIdHex, "Entry ID"),
      hexId(input.newParentEntryIdHex, "new parent Entry ID"),
      input.newName,
    );
    return await this.#publish(
      state,
      segmentBytes,
      input.entryIdHex,
      timestamp,
    );
  }

  async removeEntry(
    input: RemoveEntryInput,
  ): Promise<PublishedFileSystemTransaction> {
    const state = await this.#loadCurrentState(input.expectedRevision);
    const transactionId = requireId(this.#randomId(), "transaction ID");
    const timestamp = input.timestampMs ?? this.#now();
    validateTimestamp(timestamp);
    const segmentBytes = this.#core.encodeRemoveEntrySegment(
      state.lineageId,
      Buffer.from(state.ref.headFidHex, "hex"),
      state.lastSegmentFid,
      BigInt(state.ref.revision + 1),
      transactionId,
      BigInt(timestamp),
      this.#writerId,
      hexId(input.entryIdHex, "Entry ID"),
      input.recursive,
    );
    return await this.#publish(
      state,
      segmentBytes,
      input.entryIdHex,
      timestamp,
    );
  }

  async applyBatch(input: {
    operations: BatchFileSystemOperation[];
    expectedRevision: number;
    timestampMs?: number;
    guardRef?: RefGuardInput;
    writableWorkspaceIdHex?: string;
  }): Promise<PublishedFileSystemTransaction> {
    if (input.operations.length === 0 || input.operations.length > 10_000) {
      throw integrityFailure("Batch operation count must be 1 to 10000.");
    }
    const state = await this.#loadCurrentState(input.expectedRevision);
    const transactionId = requireId(this.#randomId(), "transaction ID");
    const timestamp = input.timestampMs ?? this.#now();
    validateTimestamp(timestamp);
    const combined = encodeBatchFileSystemSegment({
      core: this.#core,
      operations: input.operations,
      lineageId: state.lineageId,
      baseHeadFid: Buffer.from(state.ref.headFidHex, "hex"),
      previousSegmentFid: state.lastSegmentFid,
      revision: state.ref.revision + 1,
      transactionId,
      timestampMs: timestamp,
      writerId: this.#writerId,
    });
    return await this.#publish(
      state,
      combined,
      input.operations[0].entryIdHex,
      timestamp,
      input.guardRef,
      input.writableWorkspaceIdHex,
    );
  }

  async #loadCurrentState(
    expectedRevision?: number,
  ): Promise<CurrentFileSystemState> {
    const ref = this.#refStore.getRef(this.#refId);
    if (
      expectedRevision !== undefined &&
      ref.revision !== expectedRevision
    ) {
      throw new RefStoreError(
        "REF_CONFLICT",
        "Ref main changed before the transaction started.",
      );
    }
    const headBytes = await this.#repository.get("heads", ref.headFidHex);
    this.#core.validateHead(headBytes);
    const headRevision = Number(this.#core.headRevision(headBytes));
    const lineageId = this.#core.headLineageId(headBytes);
    if (
      headRevision !== ref.revision ||
      Buffer.from(lineageId).toString("hex") !== ref.lineageIdHex
    ) {
      throw integrityFailure("Ref metadata does not match its Head.");
    }
    const checkpointFidHex = Buffer.from(
      this.#core.headCheckpointFid(headBytes),
    ).toString("hex");
    const checkpointBytes = await this.#repository.get(
      "checkpoints",
      checkpointFidHex,
    );
    this.#core.validateCheckpoint(checkpointBytes);
    return {
      ref,
      headBytes,
      checkpointBytes,
      lineageId,
      lastSegmentFid: this.#core.headLastSegmentFid(headBytes),
    };
  }

  async #publish(
    state: CurrentFileSystemState,
    segmentBytes: Uint8Array,
    entryIdHex: string,
    timestamp: number,
    guardRef?: RefGuardInput,
    writableWorkspaceIdHex?: string,
  ): Promise<PublishedFileSystemTransaction> {
    this.#core.validateSegment(segmentBytes);
    const nextCheckpointBytes = this.#core.applySegment(
      state.checkpointBytes,
      segmentBytes,
    );
    this.#core.validateCheckpoint(nextCheckpointBytes);

    const segment = await this.#repository.put("segments", segmentBytes);
    const checkpoint = await this.#repository.put(
      "checkpoints",
      nextCheckpointBytes,
    );
    const nextHeadBytes = this.#core.encodeAdvancedHead(
      state.headBytes,
      Buffer.from(segment.key.fidHex, "hex"),
      Buffer.from(checkpoint.key.fidHex, "hex"),
      BigInt(timestamp),
      this.#writerId,
    );
    this.#core.validateHead(nextHeadBytes);
    const head = await this.#repository.put("heads", nextHeadBytes);
    this.#core.validateHead(
      await this.#repository.get("heads", head.key.fidHex),
    );

    await this.#beforePublish?.();
    const cas = {
      refId: this.#refId,
      expectedHeadFidHex: state.ref.headFidHex,
      expectedRevision: state.ref.revision,
      newHeadFidHex: head.key.fidHex,
      newRevision: state.ref.revision + 1,
      updatedAtMs: timestamp,
    };
    const ref = guardRef || writableWorkspaceIdHex
      ? this.#refStore.compareAndSwapGuarded(cas, guardRef, writableWorkspaceIdHex)
      : this.#refStore.compareAndSwap(cas);
    return {
      ref,
      entryIdHex,
      segmentFidHex: segment.key.fidHex,
      checkpointFidHex: checkpoint.key.fidHex,
    };
  }
}

function contentKind(content: FileContentRef): number {
  return content.kind === "chunk" ? 1 : 2;
}

function hexId(value: string, label: string): Uint8Array {
  if (!/^[0-9a-f]{32}$/.test(value) || value === "0".repeat(32)) {
    throw new Error(`${label} is invalid.`);
  }
  return Buffer.from(value, "hex");
}

function requireId(value: Uint8Array, label: string): Uint8Array {
  if (value.byteLength !== 16 || value.every((byte) => byte === 0)) {
    throw new Error(`${label} must be a random non-zero 128-bit value.`);
  }
  return Uint8Array.from(value);
}

function validateTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Transaction timestamp is invalid.");
  }
}

function integrityFailure(message: string): ObjectStoreError {
  return new ObjectStoreError("OBJECT_INTEGRITY_FAILURE", message);
}
