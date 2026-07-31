import { randomBytes } from "node:crypto";
import type { ImmutableObjectRepository } from "../files/immutableObjectRepository.js";
import { loadPvlogCore, type PvlogCore } from "../files/pvlogCore.js";
import type {
  BwaInstanceRecord,
  BwaStartupPolicy,
  SqliteRefStore,
  WorkspaceRecord,
} from "../files/sqliteRefStore.js";

export class BlankBwaInstanceCreator {
  readonly #repository: ImmutableObjectRepository;
  readonly #refStore: SqliteRefStore;
  readonly #writerId: string;
  readonly #core: PvlogCore;
  readonly #now: () => number;
  readonly #randomId: () => Buffer;

  constructor(options: {
    repository: ImmutableObjectRepository;
    refStore: SqliteRefStore;
    writerId: string;
    core?: PvlogCore;
    now?: () => number;
    randomId?: () => Buffer;
  }) {
    this.#repository = options.repository;
    this.#refStore = options.refStore;
    this.#writerId = options.writerId;
    this.#core = options.core ?? loadPvlogCore();
    this.#now = options.now ?? Date.now;
    this.#randomId = options.randomId ?? (() => randomBytes(16));
  }

  async create(input: {
    applicationId: string;
    workspaceName: string;
    instanceName: string;
    startupPolicy?: BwaStartupPolicy;
  }): Promise<{ workspace: WorkspaceRecord; instance: BwaInstanceRecord }> {
    const application = this.#refStore.getBwaApplication(input.applicationId);
    if (!application.enabled) throw new Error("BWA Application is disabled.");
    const createdAtMs = this.#timestamp();
    const allocated = new Set<string>();
    const workspaceIdHex = this.#id(allocated);
    const lineageIdHex = this.#id(allocated);
    const rootEntryIdHex = this.#id(allocated);
    const instanceIdHex = this.#id(allocated);
    const packedEntries = packEmptyRoot(rootEntryIdHex, createdAtMs);
    const checkpointBytes = this.#core.encodeGenesisCheckpointFromPacked(
      Buffer.from(lineageIdHex, "hex"),
      packedEntries,
    );
    this.#core.validateCheckpoint(checkpointBytes);
    const checkpoint = await this.#repository.put("checkpoints", checkpointBytes);
    const headBytes = this.#core.encodeGenesisHead(
      Buffer.from(lineageIdHex, "hex"),
      Buffer.from(rootEntryIdHex, "hex"),
      Buffer.from(checkpoint.key.fidHex, "hex"),
      BigInt(createdAtMs),
      this.#writerId,
    );
    this.#core.validateHead(headBytes);
    const head = await this.#repository.put("heads", headBytes);
    const source = this.#refStore.getRef("main");
    const refId = `ws-${workspaceIdHex}`;
    return this.#refStore.createWorkspaceWithBwaInstance({
      workspace: {
        workspaceIdHex,
        refId,
        name: input.workspaceName,
        sourceRefId: "main",
        sourceHeadFidHex: source.headFidHex,
        baselineHeadFidHex: head.key.fidHex,
        state: "READY",
        retention: "KEPT",
        activeWriteRunIdHex: null,
        createdAtMs,
        updatedAtMs: createdAtMs,
        ref: {
          refId,
          lineageIdHex,
          headFidHex: head.key.fidHex,
          revision: 0,
          updatedAtMs: createdAtMs,
        },
      },
      instance: {
        instanceIdHex,
        applicationId: input.applicationId,
        workspaceIdHex,
        desiredState: "STOPPED",
        startupPolicy: input.startupPolicy ?? "MANUAL",
        displayName: input.instanceName,
        createdAtMs,
        updatedAtMs: createdAtMs,
      },
    });
  }

  fork(input: {
    applicationId: string;
    sourceWorkspaceIdHex: string;
    workspaceName: string;
    instanceName: string;
    startupPolicy?: BwaStartupPolicy;
  }): { workspace: WorkspaceRecord; instance: BwaInstanceRecord } {
    const application = this.#refStore.getBwaApplication(input.applicationId);
    if (!application.enabled) throw new Error("BWA Application is disabled.");
    const sourceWorkspace = this.#refStore.getWorkspace(input.sourceWorkspaceIdHex);
    const sourceRef = this.#refStore.getRef(sourceWorkspace.refId);
    const createdAtMs = this.#timestamp();
    const allocated = new Set<string>();
    const workspaceIdHex = this.#id(allocated);
    const instanceIdHex = this.#id(allocated);
    const refId = `ws-${workspaceIdHex}`;
    return this.#refStore.createWorkspaceWithBwaInstance({
      workspace: {
        workspaceIdHex,
        refId,
        name: input.workspaceName,
        sourceRefId: sourceWorkspace.refId,
        sourceHeadFidHex: sourceRef.headFidHex,
        baselineHeadFidHex: sourceRef.headFidHex,
        state: "READY",
        retention: "KEPT",
        activeWriteRunIdHex: null,
        createdAtMs,
        updatedAtMs: createdAtMs,
        ref: {
          refId,
          lineageIdHex: sourceRef.lineageIdHex,
          headFidHex: sourceRef.headFidHex,
          revision: 0,
          updatedAtMs: createdAtMs,
        },
      },
      instance: {
        instanceIdHex,
        applicationId: input.applicationId,
        workspaceIdHex,
        desiredState: "STOPPED",
        startupPolicy: input.startupPolicy ?? "MANUAL",
        displayName: input.instanceName,
        createdAtMs,
        updatedAtMs: createdAtMs,
      },
    });
  }

  #timestamp(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("BWA timestamp is invalid.");
    return value;
  }

  #id(allocated: Set<string>): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const bytes = this.#randomId();
      if (bytes.byteLength !== 16 || bytes.every((byte) => byte === 0)) continue;
      const value = bytes.toString("hex");
      if (!allocated.has(value)) {
        allocated.add(value);
        return value;
      }
    }
    throw new Error("Could not allocate a unique BWA identity.");
  }
}

function packEmptyRoot(rootEntryIdHex: string, timestampMs: number): Uint8Array {
  const count = Buffer.allocUnsafe(4);
  count.writeUInt32BE(1);
  const fixed = Buffer.alloc(79);
  let offset = 0;
  Buffer.from(rootEntryIdHex, "hex").copy(fixed, offset);
  offset += 16;
  fixed[offset] = 0;
  offset += 1 + 16;
  fixed[offset] = 1;
  offset += 1;
  fixed.writeBigUInt64BE(BigInt(timestampMs), offset);
  offset += 8;
  fixed.writeBigUInt64BE(BigInt(timestampMs), offset);
  offset += 8;
  fixed.writeBigUInt64BE(0n, offset);
  offset += 8;
  fixed[offset] = 0;
  offset += 1 + 16;
  fixed.writeUInt32BE(0, offset);
  return Buffer.concat([count, fixed]);
}
