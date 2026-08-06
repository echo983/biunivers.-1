import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface PvlogCore {
  abiVersion(): number;
  fidHex(bytes: Uint8Array): string;
  encodeGenesisCheckpoint(
    lineageId: Uint8Array,
    rootEntryId: Uint8Array,
    createdAtMs: bigint,
  ): Uint8Array;
  encodeGenesisCheckpointFromPacked(
    lineageId: Uint8Array,
    entriesPacked: Uint8Array,
  ): Uint8Array;
  encodeGenesisHead(
    lineageId: Uint8Array,
    rootEntryId: Uint8Array,
    checkpointFid: Uint8Array,
    createdAtMs: bigint,
    writerId: string,
  ): Uint8Array;
  encodeManifest(
    fileSize: bigint,
    chunkFids: Uint8Array,
    chunkLengths: BigUint64Array,
  ): Uint8Array;
  encodeCreateFileSegment(
    lineageId: Uint8Array,
    baseHeadFid: Uint8Array,
    previousSegmentFid: Uint8Array,
    revision: bigint,
    transactionId: Uint8Array,
    createdAtMs: bigint,
    writerId: string,
    entryId: Uint8Array,
    parentId: Uint8Array,
    name: string,
    contentKind: number,
    contentFid: Uint8Array,
    size: bigint,
    mtimeMs: bigint,
  ): Uint8Array;
  encodeSetFileContentSegment(
    lineageId: Uint8Array,
    baseHeadFid: Uint8Array,
    previousSegmentFid: Uint8Array,
    revision: bigint,
    transactionId: Uint8Array,
    createdAtMs: bigint,
    writerId: string,
    entryId: Uint8Array,
    expectedContentFid: Uint8Array,
    contentKind: number,
    contentFid: Uint8Array,
    size: bigint,
    mtimeMs: bigint,
  ): Uint8Array;
  encodeCreateDirectorySegment(
    lineageId: Uint8Array,
    baseHeadFid: Uint8Array,
    previousSegmentFid: Uint8Array,
    revision: bigint,
    transactionId: Uint8Array,
    createdAtMs: bigint,
    writerId: string,
    entryId: Uint8Array,
    parentId: Uint8Array,
    name: string,
    mtimeMs: bigint,
  ): Uint8Array;
  encodeMoveEntrySegment(
    lineageId: Uint8Array,
    baseHeadFid: Uint8Array,
    previousSegmentFid: Uint8Array,
    revision: bigint,
    transactionId: Uint8Array,
    createdAtMs: bigint,
    writerId: string,
    entryId: Uint8Array,
    newParentId: Uint8Array,
    newName: string,
  ): Uint8Array;
  encodeRemoveEntrySegment(
    lineageId: Uint8Array,
    baseHeadFid: Uint8Array,
    previousSegmentFid: Uint8Array,
    revision: bigint,
    transactionId: Uint8Array,
    createdAtMs: bigint,
    writerId: string,
    entryId: Uint8Array,
    recursive: boolean,
  ): Uint8Array;
  combineSegmentsPacked(packed: Uint8Array): Uint8Array;
  applySegment(
    checkpointBytes: Uint8Array,
    segmentBytes: Uint8Array,
  ): Uint8Array;
  encodeAdvancedHead(
    previousHeadBytes: Uint8Array,
    segmentFid: Uint8Array,
    checkpointFid: Uint8Array,
    createdAtMs: bigint,
    writerId: string,
  ): Uint8Array;
  validateCheckpoint(bytes: Uint8Array): void;
  validateHead(bytes: Uint8Array): void;
  validateManifest(bytes: Uint8Array): void;
  validateSegment(bytes: Uint8Array): void;
  manifestFileSize(bytes: Uint8Array): bigint;
  manifestChunkFids(bytes: Uint8Array): Uint8Array;
  manifestChunkLengths(bytes: Uint8Array): BigUint64Array;
  headLineageId(bytes: Uint8Array): Uint8Array;
  headRootEntryId(bytes: Uint8Array): Uint8Array;
  headRevision(bytes: Uint8Array): bigint;
  headParentFid(bytes: Uint8Array): Uint8Array;
  headLastSegmentFid(bytes: Uint8Array): Uint8Array;
  headCheckpointFid(bytes: Uint8Array): Uint8Array;
  checkpointEntriesPacked(bytes: Uint8Array): Uint8Array;
}

let cached: PvlogCore | undefined;

export function loadPvlogCore(): PvlogCore {
  if (cached) {
    return cached;
  }
  const modulePath = resolvePvlogCoreModulePath();
  const loaded = createRequire(import.meta.url)(modulePath) as PvlogCore;
  if (loaded.abiVersion() !== 1) {
    throw new Error(
      `Unsupported PVLog Core ABI version: ${loaded.abiVersion()}.`,
    );
  }
  cached = loaded;
  return loaded;
}

export function resolvePvlogCoreModulePath(
  moduleUrl = import.meta.url,
): string {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const relativePath = "generated/pvlog-core-wasm/pvlog_core.js";
  const candidates = [
    resolve(moduleDirectory, "../../../", relativePath),
    resolve(moduleDirectory, "../../", relativePath),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `PVLog Core WASM module is missing; checked: ${candidates.join(", ")}`,
    );
  }
  return found;
}
