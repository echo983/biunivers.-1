import { randomBytes } from "node:crypto";
import {
  EntryIndex,
  loadCurrentEntryIndex,
  type IndexedEntry,
} from "../files/entryIndex.js";
import {
  MAX_METADATA_OBJECT_BYTES,
  type ImmutableObjectRepository,
} from "../files/immutableObjectRepository.js";
import { loadPvlogCore, type PvlogCore } from "../files/pvlogCore.js";
import {
  type SqliteRefStore,
  type WorkspaceRecord,
  type WorkspaceRetention,
} from "../files/sqliteRefStore.js";

const ID_HEX_PATTERN = /^[0-9a-f]{32}$/;

export type WorkspaceDerivationErrorCode =
  | "INVALID_SELECTION"
  | "SELECTION_NOT_FOUND"
  | "SELECTION_PARENT_MISMATCH"
  | "SELECTION_LIMIT_EXCEEDED"
  | "ENTRY_LIMIT_EXCEEDED"
  | "DEPTH_LIMIT_EXCEEDED"
  | "METADATA_LIMIT_EXCEEDED"
  | "RANDOM_ID_FAILURE";

export class WorkspaceDerivationError extends Error {
  constructor(
    public readonly code: WorkspaceDerivationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceDerivationError";
  }
}

export interface DeriveWorkspaceInput {
  name: string;
  selectedEntryIdsHex: string[];
  retention?: WorkspaceRetention;
}

export interface DerivedWorkspace {
  workspace: WorkspaceRecord;
  rootEntryIdHex: string;
  checkpointFidHex: string;
  entryCount: number;
}

export interface WorkspaceDeriverOptions {
  repository: ImmutableObjectRepository;
  refStore: SqliteRefStore;
  writerId: string;
  sourceRefId?: string;
  now?: () => number;
  randomId?: () => Uint8Array;
  core?: PvlogCore;
  maxSelectedEntries?: number;
  maxDerivedEntries?: number;
  maxDepth?: number;
  maxPackedBytes?: number;
  beforePublish?: () => void | Promise<void>;
}

interface DerivedEntry extends IndexedEntry {
  depth: number;
}

export class WorkspaceDeriver {
  readonly #repository: ImmutableObjectRepository;
  readonly #refStore: SqliteRefStore;
  readonly #writerId: string;
  readonly #sourceRefId: string;
  readonly #now: () => number;
  readonly #randomId: () => Uint8Array;
  readonly #core: PvlogCore;
  readonly #maxSelectedEntries: number;
  readonly #maxDerivedEntries: number;
  readonly #maxDepth: number;
  readonly #maxPackedBytes: number;
  readonly #beforePublish?: () => void | Promise<void>;

  constructor(options: WorkspaceDeriverOptions) {
    this.#repository = options.repository;
    this.#refStore = options.refStore;
    this.#writerId = options.writerId;
    this.#sourceRefId = options.sourceRefId ?? "main";
    this.#now = options.now ?? Date.now;
    this.#randomId = options.randomId ?? (() => randomBytes(16));
    this.#core = options.core ?? loadPvlogCore();
    this.#maxSelectedEntries = positiveLimit(
      options.maxSelectedEntries ?? 100,
      "selected Entry limit",
    );
    this.#maxDerivedEntries = positiveLimit(
      options.maxDerivedEntries ?? 100_000,
      "derived Entry limit",
    );
    this.#maxDepth = positiveLimit(options.maxDepth ?? 128, "depth limit");
    this.#maxPackedBytes = positiveLimit(
      options.maxPackedBytes ?? MAX_METADATA_OBJECT_BYTES,
      "packed metadata limit",
    );
    this.#beforePublish = options.beforePublish;
    if (
      this.#maxPackedBytes > MAX_METADATA_OBJECT_BYTES ||
      Buffer.byteLength(this.#writerId) === 0 ||
      Buffer.byteLength(this.#writerId) > 255
    ) {
      throw new Error("WorkspaceDeriver options are invalid.");
    }
  }

  async derive(input: DeriveWorkspaceInput): Promise<DerivedWorkspace> {
    validateSelection(input.selectedEntryIdsHex, this.#maxSelectedEntries);
    const createdAtMs = this.#now();
    if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
      throw new Error("Workspace creation timestamp is invalid.");
    }

    const sourceRef = this.#refStore.getRef(this.#sourceRefId);
    const sourceIndex = await loadCurrentEntryIndex(
      this.#repository,
      this.#refStore,
      this.#sourceRefId,
      this.#core,
    );
    const selected = input.selectedEntryIdsHex.map((entryIdHex) => {
      const entry = sourceIndex.get(entryIdHex);
      if (!entry || entry.parentEntryIdHex === null) {
        throw new WorkspaceDerivationError(
          "SELECTION_NOT_FOUND",
          `Selected Entry ${entryIdHex} does not exist or is the source root.`,
        );
      }
      return entry;
    });
    const sourceParentIdHex = selected[0].parentEntryIdHex;
    if (selected.some((entry) => entry.parentEntryIdHex !== sourceParentIdHex)) {
      throw new WorkspaceDerivationError(
        "SELECTION_PARENT_MISMATCH",
        "Selected Entries must be direct children of the same directory.",
      );
    }

    const allocated = new Set<string>([sourceRef.lineageIdHex]);
    const workspaceIdHex = this.#allocateId(allocated, sourceIndex);
    const lineageIdHex = this.#allocateId(allocated, sourceIndex);
    const rootEntryIdHex = this.#allocateId(allocated, sourceIndex);
    const derivedEntries: DerivedEntry[] = [
      {
        entryIdHex: rootEntryIdHex,
        parentEntryIdHex: null,
        name: "",
        kind: "directory",
        createdAtMs,
        mtimeMs: createdAtMs,
        depth: 0,
      },
    ];
    for (const entry of selected) {
      this.#copyTree(
        sourceIndex,
        entry,
        rootEntryIdHex,
        1,
        allocated,
        derivedEntries,
      );
    }

    const packedEntries = packEntries(derivedEntries);
    if (packedEntries.byteLength > this.#maxPackedBytes) {
      throw new WorkspaceDerivationError(
        "METADATA_LIMIT_EXCEEDED",
        "Derived Workspace Entry metadata exceeds its packed size limit.",
      );
    }
    const lineageId = Buffer.from(lineageIdHex, "hex");
    const checkpointBytes = this.#core.encodeGenesisCheckpointFromPacked(
      lineageId,
      packedEntries,
    );
    this.#core.validateCheckpoint(checkpointBytes);
    const checkpoint = await this.#repository.put(
      "checkpoints",
      checkpointBytes,
    );
    const headBytes = this.#core.encodeGenesisHead(
      lineageId,
      Buffer.from(rootEntryIdHex, "hex"),
      Buffer.from(checkpoint.key.fidHex, "hex"),
      BigInt(createdAtMs),
      this.#writerId,
    );
    this.#core.validateHead(headBytes);
    const head = await this.#repository.put("heads", headBytes);

    await this.#beforePublish?.();
    const refId = `ws-${workspaceIdHex}`;
    const workspace = this.#refStore.createWorkspace({
      workspaceIdHex,
      refId,
      name: input.name,
      sourceRefId: this.#sourceRefId,
      sourceHeadFidHex: sourceRef.headFidHex,
      baselineHeadFidHex: head.key.fidHex,
      state: "READY",
      retention: input.retention ?? "TEMPORARY",
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
    });
    return {
      workspace,
      rootEntryIdHex,
      checkpointFidHex: checkpoint.key.fidHex,
      entryCount: derivedEntries.length,
    };
  }

  #copyTree(
    sourceIndex: EntryIndex,
    source: IndexedEntry,
    parentEntryIdHex: string,
    depth: number,
    allocated: Set<string>,
    output: DerivedEntry[],
  ): void {
    if (depth > this.#maxDepth) {
      throw new WorkspaceDerivationError(
        "DEPTH_LIMIT_EXCEEDED",
        "Derived Workspace tree exceeds its depth limit.",
      );
    }
    if (output.length >= this.#maxDerivedEntries) {
      throw new WorkspaceDerivationError(
        "ENTRY_LIMIT_EXCEEDED",
        "Derived Workspace exceeds its Entry count limit.",
      );
    }
    const entryIdHex = this.#allocateId(allocated, sourceIndex);
    output.push({
      ...source,
      entryIdHex,
      parentEntryIdHex,
      content: source.content ? { ...source.content } : undefined,
      depth,
    });
    if (source.kind === "directory") {
      for (const child of sourceIndex.listChildren(source.entryIdHex)) {
        this.#copyTree(
          sourceIndex,
          child,
          entryIdHex,
          depth + 1,
          allocated,
          output,
        );
      }
    }
  }

  #allocateId(allocated: Set<string>, sourceIndex: EntryIndex): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const bytes = this.#randomId();
      if (bytes.byteLength !== 16 || bytes.every((byte) => byte === 0)) {
        continue;
      }
      const value = Buffer.from(bytes).toString("hex");
      if (!allocated.has(value) && !sourceIndex.has(value)) {
        allocated.add(value);
        return value;
      }
    }
    throw new WorkspaceDerivationError(
      "RANDOM_ID_FAILURE",
      "Could not allocate a unique non-zero 128-bit ID.",
    );
  }
}

function validateSelection(
  selectedEntryIdsHex: string[],
  maximum: number,
): void {
  if (
    selectedEntryIdsHex.length === 0 ||
    selectedEntryIdsHex.some((value) => !ID_HEX_PATTERN.test(value)) ||
    new Set(selectedEntryIdsHex).size !== selectedEntryIdsHex.length
  ) {
    throw new WorkspaceDerivationError(
      "INVALID_SELECTION",
      "Workspace selection must contain unique valid Entry IDs.",
    );
  }
  if (selectedEntryIdsHex.length > maximum) {
    throw new WorkspaceDerivationError(
      "SELECTION_LIMIT_EXCEEDED",
      "Workspace selection exceeds its Entry count limit.",
    );
  }
}

function packEntries(entries: DerivedEntry[]): Uint8Array {
  const chunks: Buffer[] = [];
  const count = Buffer.allocUnsafe(4);
  count.writeUInt32BE(entries.length);
  chunks.push(count);
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const fixed = Buffer.alloc(79);
    let offset = 0;
    Buffer.from(entry.entryIdHex, "hex").copy(fixed, offset);
    offset += 16;
    fixed[offset] = entry.parentEntryIdHex === null ? 0 : 1;
    offset += 1;
    if (entry.parentEntryIdHex !== null) {
      Buffer.from(entry.parentEntryIdHex, "hex").copy(fixed, offset);
    }
    offset += 16;
    fixed[offset] = entry.kind === "directory" ? 1 : 2;
    offset += 1;
    fixed.writeBigUInt64BE(BigInt(entry.createdAtMs), offset);
    offset += 8;
    fixed.writeBigUInt64BE(BigInt(entry.mtimeMs), offset);
    offset += 8;
    fixed.writeBigUInt64BE(BigInt(entry.content?.size ?? 0), offset);
    offset += 8;
    fixed[offset] =
      entry.content?.kind === "chunk"
        ? 1
        : entry.content?.kind === "manifest"
          ? 2
          : 0;
    offset += 1;
    if (entry.content) {
      Buffer.from(entry.content.fidHex, "hex").copy(fixed, offset);
    }
    offset += 16;
    fixed.writeUInt32BE(name.byteLength, offset);
    chunks.push(fixed, name);
  }
  return Buffer.concat(chunks);
}

function positiveLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`WorkspaceDeriver ${label} is invalid.`);
  }
  return value;
}
