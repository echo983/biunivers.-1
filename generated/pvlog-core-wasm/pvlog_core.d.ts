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

export function encodeGenesisCheckpoint(lineage_id: Uint8Array, root_entry_id: Uint8Array, created_at_ms: bigint): Uint8Array;

export function encodeGenesisHead(lineage_id: Uint8Array, root_entry_id: Uint8Array, checkpoint_fid: Uint8Array, created_at_ms: bigint, writer_id: string): Uint8Array;

export function encodeManifest(file_size: bigint, chunk_fids: Uint8Array, chunk_lengths: BigUint64Array): Uint8Array;

export function fidHex(bytes: Uint8Array): string;

export function validateCheckpoint(bytes: Uint8Array): void;

export function validateHead(bytes: Uint8Array): void;

export function validateManifest(bytes: Uint8Array): void;

export function validateSegment(bytes: Uint8Array): void;
