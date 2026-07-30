/* @ts-self-types="./pvlog_core.d.ts" */

class FidHasher {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FidHasherFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fidhasher_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    finishHex() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.fidhasher_finishHex(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    constructor() {
        const ret = wasm.fidhasher_new();
        this.__wbg_ptr = ret;
        FidHasherFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {Uint8Array} bytes
     */
    update(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fidhasher_update(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
}
if (Symbol.dispose) FidHasher.prototype[Symbol.dispose] = FidHasher.prototype.free;
exports.FidHasher = FidHasher;

/**
 * @returns {number}
 */
function abiVersion() {
    const ret = wasm.abiVersion();
    return ret >>> 0;
}
exports.abiVersion = abiVersion;

/**
 * @param {Uint8Array} checkpoint_bytes
 * @param {Uint8Array} segment_bytes
 * @returns {Uint8Array}
 */
function applySegment(checkpoint_bytes, segment_bytes) {
    const ptr0 = passArray8ToWasm0(checkpoint_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(segment_bytes, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.applySegment(ptr0, len0, ptr1, len1);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}
exports.applySegment = applySegment;

/**
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function checkpointEntriesPacked(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.checkpointEntriesPacked(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}
exports.checkpointEntriesPacked = checkpointEntriesPacked;

/**
 * @param {Uint8Array} packed
 * @returns {Uint8Array}
 */
function combineSegmentsPacked(packed) {
    const ptr0 = passArray8ToWasm0(packed, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.combineSegmentsPacked(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}
exports.combineSegmentsPacked = combineSegmentsPacked;

/**
 * @param {Uint8Array} previous_head_bytes
 * @param {Uint8Array} segment_fid
 * @param {Uint8Array} checkpoint_fid
 * @param {bigint} created_at_ms
 * @param {string} writer_id
 * @returns {Uint8Array}
 */
function encodeAdvancedHead(previous_head_bytes, segment_fid, checkpoint_fid, created_at_ms, writer_id) {
    const ptr0 = passArray8ToWasm0(previous_head_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(segment_fid, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(checkpoint_fid, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passStringToWasm0(writer_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.encodeAdvancedHead(ptr0, len0, ptr1, len1, ptr2, len2, created_at_ms, ptr3, len3);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v5 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v5;
}
exports.encodeAdvancedHead = encodeAdvancedHead;

/**
 * @param {Uint8Array} lineage_id
 * @param {Uint8Array} base_head_fid
 * @param {Uint8Array} previous_segment_fid
 * @param {bigint} revision
 * @param {Uint8Array} transaction_id
 * @param {bigint} created_at_ms
 * @param {string} writer_id
 * @param {Uint8Array} entry_id
 * @param {Uint8Array} parent_id
 * @param {string} name
 * @param {bigint} mtime_ms
 * @returns {Uint8Array}
 */
function encodeCreateDirectorySegment(lineage_id, base_head_fid, previous_segment_fid, revision, transaction_id, created_at_ms, writer_id, entry_id, parent_id, name, mtime_ms) {
    const ptr0 = passArray8ToWasm0(lineage_id, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(base_head_fid, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(previous_segment_fid, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(transaction_id, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passStringToWasm0(writer_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArray8ToWasm0(entry_id, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ptr6 = passArray8ToWasm0(parent_id, wasm.__wbindgen_malloc);
    const len6 = WASM_VECTOR_LEN;
    const ptr7 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len7 = WASM_VECTOR_LEN;
    const ret = wasm.encodeCreateDirectorySegment(ptr0, len0, ptr1, len1, ptr2, len2, revision, ptr3, len3, created_at_ms, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, mtime_ms);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v9 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v9;
}
exports.encodeCreateDirectorySegment = encodeCreateDirectorySegment;

/**
 * @param {Uint8Array} lineage_id
 * @param {Uint8Array} base_head_fid
 * @param {Uint8Array} previous_segment_fid
 * @param {bigint} revision
 * @param {Uint8Array} transaction_id
 * @param {bigint} created_at_ms
 * @param {string} writer_id
 * @param {Uint8Array} entry_id
 * @param {Uint8Array} parent_id
 * @param {string} name
 * @param {number} content_kind
 * @param {Uint8Array} content_fid
 * @param {bigint} size
 * @param {bigint} mtime_ms
 * @returns {Uint8Array}
 */
function encodeCreateFileSegment(lineage_id, base_head_fid, previous_segment_fid, revision, transaction_id, created_at_ms, writer_id, entry_id, parent_id, name, content_kind, content_fid, size, mtime_ms) {
    const ptr0 = passArray8ToWasm0(lineage_id, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(base_head_fid, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(previous_segment_fid, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(transaction_id, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passStringToWasm0(writer_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArray8ToWasm0(entry_id, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ptr6 = passArray8ToWasm0(parent_id, wasm.__wbindgen_malloc);
    const len6 = WASM_VECTOR_LEN;
    const ptr7 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len7 = WASM_VECTOR_LEN;
    const ptr8 = passArray8ToWasm0(content_fid, wasm.__wbindgen_malloc);
    const len8 = WASM_VECTOR_LEN;
    const ret = wasm.encodeCreateFileSegment(ptr0, len0, ptr1, len1, ptr2, len2, revision, ptr3, len3, created_at_ms, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, content_kind, ptr8, len8, size, mtime_ms);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v10 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v10;
}
exports.encodeCreateFileSegment = encodeCreateFileSegment;

/**
 * @param {Uint8Array} lineage_id
 * @param {Uint8Array} root_entry_id
 * @param {bigint} created_at_ms
 * @returns {Uint8Array}
 */
function encodeGenesisCheckpoint(lineage_id, root_entry_id, created_at_ms) {
    const ptr0 = passArray8ToWasm0(lineage_id, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(root_entry_id, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.encodeGenesisCheckpoint(ptr0, len0, ptr1, len1, created_at_ms);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}
exports.encodeGenesisCheckpoint = encodeGenesisCheckpoint;

/**
 * @param {Uint8Array} lineage_id
 * @param {Uint8Array} packed
 * @returns {Uint8Array}
 */
function encodeGenesisCheckpointFromPacked(lineage_id, packed) {
    const ptr0 = passArray8ToWasm0(lineage_id, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(packed, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.encodeGenesisCheckpointFromPacked(ptr0, len0, ptr1, len1);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}
exports.encodeGenesisCheckpointFromPacked = encodeGenesisCheckpointFromPacked;

/**
 * @param {Uint8Array} lineage_id
 * @param {Uint8Array} root_entry_id
 * @param {Uint8Array} checkpoint_fid
 * @param {bigint} created_at_ms
 * @param {string} writer_id
 * @returns {Uint8Array}
 */
function encodeGenesisHead(lineage_id, root_entry_id, checkpoint_fid, created_at_ms, writer_id) {
    const ptr0 = passArray8ToWasm0(lineage_id, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(root_entry_id, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(checkpoint_fid, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passStringToWasm0(writer_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.encodeGenesisHead(ptr0, len0, ptr1, len1, ptr2, len2, created_at_ms, ptr3, len3);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v5 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v5;
}
exports.encodeGenesisHead = encodeGenesisHead;

/**
 * @param {bigint} file_size
 * @param {Uint8Array} chunk_fids
 * @param {BigUint64Array} chunk_lengths
 * @returns {Uint8Array}
 */
function encodeManifest(file_size, chunk_fids, chunk_lengths) {
    const ptr0 = passArray8ToWasm0(chunk_fids, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray64ToWasm0(chunk_lengths, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.encodeManifest(file_size, ptr0, len0, ptr1, len1);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}
exports.encodeManifest = encodeManifest;

/**
 * @param {Uint8Array} lineage_id
 * @param {Uint8Array} base_head_fid
 * @param {Uint8Array} previous_segment_fid
 * @param {bigint} revision
 * @param {Uint8Array} transaction_id
 * @param {bigint} created_at_ms
 * @param {string} writer_id
 * @param {Uint8Array} entry_id
 * @param {Uint8Array} new_parent_id
 * @param {string} new_name
 * @returns {Uint8Array}
 */
function encodeMoveEntrySegment(lineage_id, base_head_fid, previous_segment_fid, revision, transaction_id, created_at_ms, writer_id, entry_id, new_parent_id, new_name) {
    const ptr0 = passArray8ToWasm0(lineage_id, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(base_head_fid, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(previous_segment_fid, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(transaction_id, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passStringToWasm0(writer_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArray8ToWasm0(entry_id, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ptr6 = passArray8ToWasm0(new_parent_id, wasm.__wbindgen_malloc);
    const len6 = WASM_VECTOR_LEN;
    const ptr7 = passStringToWasm0(new_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len7 = WASM_VECTOR_LEN;
    const ret = wasm.encodeMoveEntrySegment(ptr0, len0, ptr1, len1, ptr2, len2, revision, ptr3, len3, created_at_ms, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v9 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v9;
}
exports.encodeMoveEntrySegment = encodeMoveEntrySegment;

/**
 * @param {Uint8Array} lineage_id
 * @param {Uint8Array} base_head_fid
 * @param {Uint8Array} previous_segment_fid
 * @param {bigint} revision
 * @param {Uint8Array} transaction_id
 * @param {bigint} created_at_ms
 * @param {string} writer_id
 * @param {Uint8Array} entry_id
 * @param {boolean} recursive
 * @returns {Uint8Array}
 */
function encodeRemoveEntrySegment(lineage_id, base_head_fid, previous_segment_fid, revision, transaction_id, created_at_ms, writer_id, entry_id, recursive) {
    const ptr0 = passArray8ToWasm0(lineage_id, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(base_head_fid, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(previous_segment_fid, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(transaction_id, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passStringToWasm0(writer_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArray8ToWasm0(entry_id, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ret = wasm.encodeRemoveEntrySegment(ptr0, len0, ptr1, len1, ptr2, len2, revision, ptr3, len3, created_at_ms, ptr4, len4, ptr5, len5, recursive);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v7 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v7;
}
exports.encodeRemoveEntrySegment = encodeRemoveEntrySegment;

/**
 * @param {Uint8Array} lineage_id
 * @param {Uint8Array} base_head_fid
 * @param {Uint8Array} previous_segment_fid
 * @param {bigint} revision
 * @param {Uint8Array} transaction_id
 * @param {bigint} created_at_ms
 * @param {string} writer_id
 * @param {Uint8Array} entry_id
 * @param {Uint8Array} expected_content_fid
 * @param {number} content_kind
 * @param {Uint8Array} content_fid
 * @param {bigint} size
 * @param {bigint} mtime_ms
 * @returns {Uint8Array}
 */
function encodeSetFileContentSegment(lineage_id, base_head_fid, previous_segment_fid, revision, transaction_id, created_at_ms, writer_id, entry_id, expected_content_fid, content_kind, content_fid, size, mtime_ms) {
    const ptr0 = passArray8ToWasm0(lineage_id, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(base_head_fid, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(previous_segment_fid, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(transaction_id, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passStringToWasm0(writer_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArray8ToWasm0(entry_id, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ptr6 = passArray8ToWasm0(expected_content_fid, wasm.__wbindgen_malloc);
    const len6 = WASM_VECTOR_LEN;
    const ptr7 = passArray8ToWasm0(content_fid, wasm.__wbindgen_malloc);
    const len7 = WASM_VECTOR_LEN;
    const ret = wasm.encodeSetFileContentSegment(ptr0, len0, ptr1, len1, ptr2, len2, revision, ptr3, len3, created_at_ms, ptr4, len4, ptr5, len5, ptr6, len6, content_kind, ptr7, len7, size, mtime_ms);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v9 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v9;
}
exports.encodeSetFileContentSegment = encodeSetFileContentSegment;

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function fidHex(bytes) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fidHex(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}
exports.fidHex = fidHex;

/**
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function headCheckpointFid(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.headCheckpointFid(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}
exports.headCheckpointFid = headCheckpointFid;

/**
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function headLastSegmentFid(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.headLastSegmentFid(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}
exports.headLastSegmentFid = headLastSegmentFid;

/**
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function headLineageId(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.headLineageId(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}
exports.headLineageId = headLineageId;

/**
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function headParentFid(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.headParentFid(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}
exports.headParentFid = headParentFid;

/**
 * @param {Uint8Array} bytes
 * @returns {bigint}
 */
function headRevision(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.headRevision(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return BigInt.asUintN(64, ret[0]);
}
exports.headRevision = headRevision;

/**
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function headRootEntryId(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.headRootEntryId(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}
exports.headRootEntryId = headRootEntryId;

/**
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function manifestChunkFids(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.manifestChunkFids(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}
exports.manifestChunkFids = manifestChunkFids;

/**
 * @param {Uint8Array} bytes
 * @returns {BigUint64Array}
 */
function manifestChunkLengths(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.manifestChunkLengths(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}
exports.manifestChunkLengths = manifestChunkLengths;

/**
 * @param {Uint8Array} bytes
 * @returns {bigint}
 */
function manifestFileSize(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.manifestFileSize(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return BigInt.asUintN(64, ret[0]);
}
exports.manifestFileSize = manifestFileSize;

/**
 * @param {Uint8Array} bytes
 */
function validateCheckpoint(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.validateCheckpoint(ptr0, len0);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}
exports.validateCheckpoint = validateCheckpoint;

/**
 * @param {Uint8Array} bytes
 */
function validateHead(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.validateHead(ptr0, len0);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}
exports.validateHead = validateHead;

/**
 * @param {Uint8Array} bytes
 */
function validateManifest(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.validateManifest(ptr0, len0);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}
exports.validateManifest = validateManifest;

/**
 * @param {Uint8Array} bytes
 */
function validateSegment(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.validateSegment(ptr0, len0);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}
exports.validateSegment = validateSegment;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_92b29b0548f8b746: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./pvlog_core_bg.js": import0,
    };
}

const FidHasherFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fidhasher_free(ptr, 1));

function getArrayU64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getBigUint64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedBigUint64ArrayMemory0 = null;
function getBigUint64ArrayMemory0() {
    if (cachedBigUint64ArrayMemory0 === null || cachedBigUint64ArrayMemory0.byteLength === 0) {
        cachedBigUint64ArrayMemory0 = new BigUint64Array(wasm.memory.buffer);
    }
    return cachedBigUint64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getBigUint64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
function decodeText(ptr, len) {
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

const wasmPath = `${__dirname}/pvlog_core_bg.wasm`;
const wasmBytes = require('fs').readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
let wasmInstance = new WebAssembly.Instance(wasmModule, __wbg_get_imports());
let wasm = wasmInstance.exports;
wasm.__wbindgen_start();
