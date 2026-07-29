use pvlog_core::{
    CHUNK_SIZE, Checkpoint, CheckpointRef, ChunkRef, ContentRef, Entry, EntryId, EntryKind, Fid,
    Head, Manifest, Operation, Segment, encode_checkpoint, encode_head, encode_manifest,
    encode_segment, fid_hex,
};

fn repeated(value: u8) -> [u8; 16] {
    [value; 16]
}

fn print_vector(name: &str, encoded: Vec<u8>) {
    println!("{name}\t{}\t{}", hex::encode(&encoded), fid_hex(&encoded));
}

fn main() {
    let lineage = repeated(0x10);
    let root = EntryId(repeated(0x20));
    let file = EntryId(repeated(0x21));
    let chunk_a = Fid(repeated(0x30));
    let chunk_b = Fid(repeated(0x31));
    let segment_fid = Fid(repeated(0x40));

    let manifest = Manifest {
        file_size: CHUNK_SIZE + 7,
        chunks: vec![
            ChunkRef {
                fid: chunk_a,
                length: CHUNK_SIZE,
            },
            ChunkRef {
                fid: chunk_b,
                length: 7,
            },
        ],
    };
    let manifest_bytes = encode_manifest(&manifest).expect("valid manifest");
    let manifest_fid = Fid(pvlog_core::fid_bytes(&manifest_bytes).0);

    let head = Head {
        lineage_id: lineage,
        root_entry_id: root,
        revision: 1,
        parent_head: Some(Fid(repeated(0x50))),
        last_segment: Some(segment_fid),
        checkpoint: Some(CheckpointRef {
            fid: Fid(repeated(0x60)),
            revision: 0,
            covered_segment: None,
        }),
        created_at_ms: 1_700_000_000_000,
        writer_id: "writer-1".into(),
    };

    let segment = Segment {
        lineage_id: lineage,
        base_head: Fid(repeated(0x50)),
        previous_segment: None,
        revision: 1,
        transaction_id: repeated(0x70),
        created_at_ms: 1_700_000_000_000,
        writer_id: "writer-1".into(),
        operations: vec![Operation::CreateFile {
            entry_id: file,
            parent_id: root,
            name: "notes.md".into(),
            content: ContentRef::Manifest(manifest_fid),
            size: CHUNK_SIZE + 7,
            mtime_ms: 1_700_000_000_000,
        }],
    };

    let checkpoint = Checkpoint {
        lineage_id: lineage,
        revision: 1,
        covered_segment: Some(segment_fid),
        entries: vec![
            Entry {
                entry_id: file,
                parent_id: Some(root),
                name: "notes.md".into(),
                kind: EntryKind::File {
                    content: ContentRef::Manifest(manifest_fid),
                    size: CHUNK_SIZE + 7,
                },
                created_at_ms: 1_700_000_000_000,
                mtime_ms: 1_700_000_000_000,
            },
            Entry {
                entry_id: root,
                parent_id: None,
                name: "".into(),
                kind: EntryKind::Directory,
                created_at_ms: 1_700_000_000_000,
                mtime_ms: 1_700_000_000_000,
            },
        ],
    };

    print_vector("manifest_v1", manifest_bytes);
    print_vector("head_v1", encode_head(&head));
    print_vector("segment_v1", encode_segment(&segment));
    print_vector("checkpoint_v1", encode_checkpoint(&checkpoint));
}
