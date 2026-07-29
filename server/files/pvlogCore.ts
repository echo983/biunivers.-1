import { createRequire } from "node:module";
import { join } from "node:path";

export interface PvlogCore {
  abiVersion(): number;
  fidHex(bytes: Uint8Array): string;
  encodeGenesisCheckpoint(
    lineageId: Uint8Array,
    rootEntryId: Uint8Array,
    createdAtMs: bigint,
  ): Uint8Array;
  encodeGenesisHead(
    lineageId: Uint8Array,
    rootEntryId: Uint8Array,
    checkpointFid: Uint8Array,
    createdAtMs: bigint,
    writerId: string,
  ): Uint8Array;
  validateCheckpoint(bytes: Uint8Array): void;
  validateHead(bytes: Uint8Array): void;
  validateManifest(bytes: Uint8Array): void;
  validateSegment(bytes: Uint8Array): void;
}

let cached: PvlogCore | undefined;

export function loadPvlogCore(): PvlogCore {
  if (cached) {
    return cached;
  }
  const modulePath = join(
    process.cwd(),
    "generated",
    "pvlog-core-wasm",
    "pvlog_core.js",
  );
  const loaded = createRequire(import.meta.url)(modulePath) as PvlogCore;
  if (loaded.abiVersion() !== 1) {
    throw new Error(
      `Unsupported PVLog Core ABI version: ${loaded.abiVersion()}.`,
    );
  }
  cached = loaded;
  return loaded;
}
