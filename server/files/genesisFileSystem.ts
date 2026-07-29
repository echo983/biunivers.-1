import { randomBytes } from "node:crypto";
import type { ImmutableObjectRepository } from "./immutableObjectRepository.js";
import { loadPvlogCore, type PvlogCore } from "./pvlogCore.js";
import {
  SqliteRefStore,
  type FilesystemRef,
} from "./sqliteRefStore.js";

export interface GenesisFileSystemOptions {
  databasePath: string;
  repository: ImmutableObjectRepository;
  writerId: string;
  createdAtMs?: number;
  core?: PvlogCore;
  randomId?: () => Uint8Array;
}

export interface GenesisFileSystemResult {
  ref: FilesystemRef;
  rootEntryIdHex: string;
  checkpointFidHex: string;
  store: SqliteRefStore;
}

export async function initializeGenesisFileSystem(
  options: GenesisFileSystemOptions,
): Promise<GenesisFileSystemResult> {
  const core = options.core ?? loadPvlogCore();
  const createdAtMs = options.createdAtMs ?? Date.now();
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
    throw new Error("Genesis timestamp must be a non-negative safe integer.");
  }
  const randomId = options.randomId ?? (() => randomBytes(16));
  const lineageId = requireRandomId(randomId(), "lineage ID");
  const rootEntryId = requireRandomId(randomId(), "root Entry ID");

  const checkpointBytes = core.encodeGenesisCheckpoint(
    lineageId,
    rootEntryId,
    BigInt(createdAtMs),
  );
  core.validateCheckpoint(checkpointBytes);
  const checkpoint = await options.repository.put(
    "checkpoints",
    checkpointBytes,
  );
  core.validateCheckpoint(
    await options.repository.get("checkpoints", checkpoint.key.fidHex),
  );

  const headBytes = core.encodeGenesisHead(
    lineageId,
    rootEntryId,
    Buffer.from(checkpoint.key.fidHex, "hex"),
    BigInt(createdAtMs),
    options.writerId,
  );
  core.validateHead(headBytes);
  const head = await options.repository.put("heads", headBytes);
  core.validateHead(await options.repository.get("heads", head.key.fidHex));

  const ref: FilesystemRef = {
    refId: "main",
    lineageIdHex: Buffer.from(lineageId).toString("hex"),
    headFidHex: head.key.fidHex,
    revision: 0,
    updatedAtMs: createdAtMs,
  };
  const store = await SqliteRefStore.initializeWithRef(
    options.databasePath,
    ref,
  );
  return {
    ref,
    rootEntryIdHex: Buffer.from(rootEntryId).toString("hex"),
    checkpointFidHex: checkpoint.key.fidHex,
    store,
  };
}

function requireRandomId(value: Uint8Array, label: string): Uint8Array {
  if (value.byteLength !== 16 || value.every((byte) => byte === 0)) {
    throw new Error(`${label} must be a random non-zero 128-bit value.`);
  }
  return Uint8Array.from(value);
}
