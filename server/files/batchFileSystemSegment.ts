import type { FileContentRef } from "./fileContentStore.js";
import type { PvlogCore } from "./pvlogCore.js";

export type BatchFileSystemOperation =
  | {
      kind: "create-directory";
      entryIdHex: string;
      parentEntryIdHex: string;
      name: string;
      mtimeMs: number;
    }
  | {
      kind: "create-file";
      entryIdHex: string;
      parentEntryIdHex: string;
      name: string;
      content: FileContentRef;
      mtimeMs: number;
    }
  | {
      kind: "move";
      entryIdHex: string;
      newParentEntryIdHex: string;
      newName: string;
    }
  | {
      kind: "set-file-content";
      entryIdHex: string;
      expectedContentFidHex: string;
      content: FileContentRef;
      mtimeMs: number;
    }
  | {
      kind: "remove";
      entryIdHex: string;
      recursive: boolean;
    };

export function encodeBatchFileSystemSegment(input: {
  core: PvlogCore;
  operations: readonly BatchFileSystemOperation[];
  lineageId: Uint8Array;
  baseHeadFid: Uint8Array;
  previousSegmentFid: Uint8Array;
  revision: number;
  transactionId: Uint8Array;
  timestampMs: number;
  writerId: string;
}): Uint8Array {
  if (input.operations.length === 0 || input.operations.length > 10_000) {
    throw new Error("Batch operation count must be 1 to 10000.");
  }
  const segments = input.operations.map((operation) => {
    const common = [
      input.lineageId,
      input.baseHeadFid,
      input.previousSegmentFid,
      BigInt(input.revision),
      input.transactionId,
      BigInt(input.timestampMs),
      input.writerId,
    ] as const;
    if (operation.kind === "create-directory") {
      return input.core.encodeCreateDirectorySegment(
        ...common,
        hexId(operation.entryIdHex, "Entry ID"),
        hexId(operation.parentEntryIdHex, "parent Entry ID"),
        operation.name,
        BigInt(operation.mtimeMs),
      );
    }
    if (operation.kind === "create-file") {
      return input.core.encodeCreateFileSegment(
        ...common,
        hexId(operation.entryIdHex, "Entry ID"),
        hexId(operation.parentEntryIdHex, "parent Entry ID"),
        operation.name,
        contentKind(operation.content),
        hexId(operation.content.fidHex, "content FID"),
        BigInt(operation.content.size),
        BigInt(operation.mtimeMs),
      );
    }
    if (operation.kind === "move") {
      return input.core.encodeMoveEntrySegment(
        ...common,
        hexId(operation.entryIdHex, "Entry ID"),
        hexId(operation.newParentEntryIdHex, "new parent Entry ID"),
        operation.newName,
      );
    }
    if (operation.kind === "set-file-content") {
      return input.core.encodeSetFileContentSegment(
        ...common,
        hexId(operation.entryIdHex, "Entry ID"),
        hexId(operation.expectedContentFidHex, "expected content FID"),
        contentKind(operation.content),
        hexId(operation.content.fidHex, "content FID"),
        BigInt(operation.content.size),
        BigInt(operation.mtimeMs),
      );
    }
    return input.core.encodeRemoveEntrySegment(
      ...common,
      hexId(operation.entryIdHex, "Entry ID"),
      operation.recursive,
    );
  });
  return input.core.combineSegmentsPacked(packSegments(segments));
}

function packSegments(segments: Uint8Array[]): Uint8Array {
  const size =
    4 + segments.reduce((total, segment) => total + 4 + segment.length, 0);
  const packed = new Uint8Array(size);
  const view = new DataView(packed.buffer);
  view.setUint32(0, segments.length);
  let offset = 4;
  for (const segment of segments) {
    view.setUint32(offset, segment.length);
    offset += 4;
    packed.set(segment, offset);
    offset += segment.length;
  }
  return packed;
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
