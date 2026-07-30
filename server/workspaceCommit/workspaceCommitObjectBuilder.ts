import { randomBytes } from "node:crypto";
import { encodeBatchFileSystemSegment } from "../files/batchFileSystemSegment.js";
import type { ImmutableObjectRepository } from "../files/immutableObjectRepository.js";
import { loadPvlogCore, type PvlogCore } from "../files/pvlogCore.js";
import type { CommitOperation } from "./commitOperationPlanner.js";

export interface WorkspaceCommitObjects {
  baseHeadFidHex: string;
  revision: number;
  segmentFidHex: string;
  checkpointFidHex: string;
  headFidHex: string;
}

export class WorkspaceCommitObjectBuilder {
  readonly #repository: ImmutableObjectRepository;
  readonly #writerId: string;
  readonly #core: PvlogCore;
  readonly #randomId: () => Uint8Array;

  constructor(options: {
    repository: ImmutableObjectRepository;
    writerId: string;
    core?: PvlogCore;
    randomId?: () => Uint8Array;
  }) {
    this.#repository = options.repository;
    this.#writerId = options.writerId;
    this.#core = options.core ?? loadPvlogCore();
    this.#randomId = options.randomId ?? (() => randomBytes(16));
  }

  async build(input: {
    baseHeadFidHex: string;
    expectedRevision: number;
    operations: readonly CommitOperation[];
    timestampMs: number;
  }): Promise<WorkspaceCommitObjects> {
    validateFid(input.baseHeadFidHex);
    validateSafeInteger(input.expectedRevision, "expected revision");
    validateSafeInteger(input.timestampMs, "commit timestamp");
    const transactionId = requireId(this.#randomId());
    const headBytes = await this.#repository.get(
      "heads",
      input.baseHeadFidHex,
    );
    this.#core.validateHead(headBytes);
    if (Number(this.#core.headRevision(headBytes)) !== input.expectedRevision) {
      throw new Error("Fixed input Head revision does not match.");
    }
    const checkpointFidHex = Buffer.from(
      this.#core.headCheckpointFid(headBytes),
    ).toString("hex");
    const checkpointBytes = await this.#repository.get(
      "checkpoints",
      checkpointFidHex,
    );
    this.#core.validateCheckpoint(checkpointBytes);

    const segmentBytes = encodeBatchFileSystemSegment({
      core: this.#core,
      operations: input.operations,
      lineageId: this.#core.headLineageId(headBytes),
      baseHeadFid: Buffer.from(input.baseHeadFidHex, "hex"),
      previousSegmentFid: this.#core.headLastSegmentFid(headBytes),
      revision: input.expectedRevision + 1,
      transactionId,
      timestampMs: input.timestampMs,
      writerId: this.#writerId,
    });
    this.#core.validateSegment(segmentBytes);
    const nextCheckpointBytes = this.#core.applySegment(
      checkpointBytes,
      segmentBytes,
    );
    this.#core.validateCheckpoint(nextCheckpointBytes);

    const segment = await this.#repository.put("segments", segmentBytes);
    const checkpoint = await this.#repository.put(
      "checkpoints",
      nextCheckpointBytes,
    );
    const nextHeadBytes = this.#core.encodeAdvancedHead(
      headBytes,
      Buffer.from(segment.key.fidHex, "hex"),
      Buffer.from(checkpoint.key.fidHex, "hex"),
      BigInt(input.timestampMs),
      this.#writerId,
    );
    this.#core.validateHead(nextHeadBytes);
    const head = await this.#repository.put("heads", nextHeadBytes);

    this.#core.validateSegment(
      await this.#repository.get("segments", segment.key.fidHex),
    );
    this.#core.validateCheckpoint(
      await this.#repository.get("checkpoints", checkpoint.key.fidHex),
    );
    this.#core.validateHead(
      await this.#repository.get("heads", head.key.fidHex),
    );
    return {
      baseHeadFidHex: input.baseHeadFidHex,
      revision: input.expectedRevision + 1,
      segmentFidHex: segment.key.fidHex,
      checkpointFidHex: checkpoint.key.fidHex,
      headFidHex: head.key.fidHex,
    };
  }
}

function validateFid(value: string): void {
  if (!/^[0-9a-f]{32}$/.test(value)) {
    throw new Error("Fixed input Head FID is invalid.");
  }
}

function validateSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid.`);
  }
}

function requireId(value: Uint8Array): Uint8Array {
  if (value.byteLength !== 16 || value.every((byte) => byte === 0)) {
    throw new Error("Transaction ID must be a random non-zero 128-bit value.");
  }
  return Uint8Array.from(value);
}
