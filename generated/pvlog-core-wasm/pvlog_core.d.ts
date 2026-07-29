/* tslint:disable */
/* eslint-disable */

export class FidHasher {
    free(): void;
    [Symbol.dispose](): void;
    finishHex(): string;
    constructor();
    update(bytes: Uint8Array): void;
}

export function abiVersion(): number;

export function applySegment(checkpoint_bytes: Uint8Array, segment_bytes: Uint8Array): Uint8Array;

export function checkpointEntriesPacked(bytes: Uint8Array): Uint8Array;

export function encodeAdvancedHead(previous_head_bytes: Uint8Array, segment_fid: Uint8Array, checkpoint_fid: Uint8Array, created_at_ms: bigint, writer_id: string): Uint8Array;

export function encodeCreateDirectorySegment(lineage_id: Uint8Array, base_head_fid: Uint8Array, previous_segment_fid: Uint8Array, revision: bigint, transaction_id: Uint8Array, created_at_ms: bigint, writer_id: string, entry_id: Uint8Array, parent_id: Uint8Array, name: string, mtime_ms: bigint): Uint8Array;

export function encodeCreateFileSegment(lineage_id: Uint8Array, base_head_fid: Uint8Array, previous_segment_fid: Uint8Array, revision: bigint, transaction_id: Uint8Array, created_at_ms: bigint, writer_id: string, entry_id: Uint8Array, parent_id: Uint8Array, name: string, content_kind: number, content_fid: Uint8Array, size: bigint, mtime_ms: bigint): Uint8Array;

export function encodeGenesisCheckpoint(lineage_id: Uint8Array, root_entry_id: Uint8Array, created_at_ms: bigint): Uint8Array;

export function encodeGenesisHead(lineage_id: Uint8Array, root_entry_id: Uint8Array, checkpoint_fid: Uint8Array, created_at_ms: bigint, writer_id: string): Uint8Array;

export function encodeManifest(file_size: bigint, chunk_fids: Uint8Array, chunk_lengths: BigUint64Array): Uint8Array;

export function encodeMoveEntrySegment(lineage_id: Uint8Array, base_head_fid: Uint8Array, previous_segment_fid: Uint8Array, revision: bigint, transaction_id: Uint8Array, created_at_ms: bigint, writer_id: string, entry_id: Uint8Array, new_parent_id: Uint8Array, new_name: string): Uint8Array;

export function encodeRemoveEntrySegment(lineage_id: Uint8Array, base_head_fid: Uint8Array, previous_segment_fid: Uint8Array, revision: bigint, transaction_id: Uint8Array, created_at_ms: bigint, writer_id: string, entry_id: Uint8Array, recursive: boolean): Uint8Array;

export function encodeSetFileContentSegment(lineage_id: Uint8Array, base_head_fid: Uint8Array, previous_segment_fid: Uint8Array, revision: bigint, transaction_id: Uint8Array, created_at_ms: bigint, writer_id: string, entry_id: Uint8Array, expected_content_fid: Uint8Array, content_kind: number, content_fid: Uint8Array, size: bigint, mtime_ms: bigint): Uint8Array;

export function fidHex(bytes: Uint8Array): string;

export function headCheckpointFid(bytes: Uint8Array): Uint8Array;

export function headLastSegmentFid(bytes: Uint8Array): Uint8Array;

export function headLineageId(bytes: Uint8Array): Uint8Array;

export function headParentFid(bytes: Uint8Array): Uint8Array;

export function headRevision(bytes: Uint8Array): bigint;

export function headRootEntryId(bytes: Uint8Array): Uint8Array;

export function manifestChunkFids(bytes: Uint8Array): Uint8Array;

export function manifestChunkLengths(bytes: Uint8Array): BigUint64Array;

export function manifestFileSize(bytes: Uint8Array): bigint;

export function validateCheckpoint(bytes: Uint8Array): void;

export function validateHead(bytes: Uint8Array): void;

export function validateManifest(bytes: Uint8Array): void;

export function validateSegment(bytes: Uint8Array): void;
