use unicode_normalization::UnicodeNormalization;
use xxhash_rust::xxh3::{Xxh3, xxh3_128_with_seed};

pub const ABI_VERSION: u32 = 1;
pub const FORMAT_VERSION: u64 = 1;
pub const CHUNK_SIZE: u64 = 64 * 1024 * 1024;
pub const MAX_ENTRY_NAME_BYTES: usize = 255;
pub const MAX_ABI_INPUT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_ENCODED_OBJECT_BYTES: usize = 32 * 1024 * 1024;

const TYPE_HEAD: u64 = 1;
const TYPE_SEGMENT: u64 = 2;
const TYPE_CHECKPOINT: u64 = 3;
const TYPE_MANIFEST: u64 = 4;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Fid(pub [u8; 16]);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EntryId(pub [u8; 16]);

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ContentRef {
    Chunk(Fid),
    Manifest(Fid),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChunkRef {
    pub fid: Fid,
    pub length: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Manifest {
    pub file_size: u64,
    pub chunks: Vec<ChunkRef>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CheckpointRef {
    pub fid: Fid,
    pub revision: u64,
    pub covered_segment: Option<Fid>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Head {
    pub lineage_id: [u8; 16],
    pub root_entry_id: EntryId,
    pub revision: u64,
    pub parent_head: Option<Fid>,
    pub last_segment: Option<Fid>,
    pub checkpoint: Option<CheckpointRef>,
    pub created_at_ms: u64,
    pub writer_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Operation {
    CreateDirectory {
        entry_id: EntryId,
        parent_id: EntryId,
        name: String,
        mtime_ms: u64,
    },
    CreateFile {
        entry_id: EntryId,
        parent_id: EntryId,
        name: String,
        content: ContentRef,
        size: u64,
        mtime_ms: u64,
    },
    SetFileContent {
        entry_id: EntryId,
        expected_content: Option<Fid>,
        content: ContentRef,
        size: u64,
        mtime_ms: u64,
    },
    MoveEntry {
        entry_id: EntryId,
        new_parent_id: EntryId,
        new_name: String,
    },
    RemoveEntry {
        entry_id: EntryId,
        recursive: bool,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Segment {
    pub lineage_id: [u8; 16],
    pub base_head: Fid,
    pub previous_segment: Option<Fid>,
    pub revision: u64,
    pub transaction_id: [u8; 16],
    pub created_at_ms: u64,
    pub writer_id: String,
    pub operations: Vec<Operation>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EntryKind {
    Directory,
    File { content: ContentRef, size: u64 },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Entry {
    pub entry_id: EntryId,
    pub parent_id: Option<EntryId>,
    pub name: String,
    pub kind: EntryKind,
    pub created_at_ms: u64,
    pub mtime_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Checkpoint {
    pub lineage_id: [u8; 16],
    pub revision: u64,
    pub covered_segment: Option<Fid>,
    pub entries: Vec<Entry>,
}

#[derive(Default)]
struct Encoder {
    bytes: Vec<u8>,
}

impl Encoder {
    fn finish(self) -> Vec<u8> {
        self.bytes
    }

    fn major(&mut self, major: u8, value: u64) {
        let prefix = major << 5;
        match value {
            0..=23 => self.bytes.push(prefix | value as u8),
            24..=0xff => self.bytes.extend([prefix | 24, value as u8]),
            0x100..=0xffff => {
                self.bytes.push(prefix | 25);
                self.bytes.extend((value as u16).to_be_bytes());
            }
            0x1_0000..=0xffff_ffff => {
                self.bytes.push(prefix | 26);
                self.bytes.extend((value as u32).to_be_bytes());
            }
            _ => {
                self.bytes.push(prefix | 27);
                self.bytes.extend(value.to_be_bytes());
            }
        }
    }

    fn uint(&mut self, value: u64) {
        self.major(0, value);
    }

    fn bytes(&mut self, value: &[u8]) {
        self.major(2, value.len() as u64);
        self.bytes.extend(value);
    }

    fn text(&mut self, value: &str) {
        self.major(3, value.len() as u64);
        self.bytes.extend(value.as_bytes());
    }

    fn array(&mut self, length: usize) {
        self.major(4, length as u64);
    }

    fn map(&mut self, length: usize) {
        self.major(5, length as u64);
    }

    fn null(&mut self) {
        self.bytes.push(0xf6);
    }

    fn boolean(&mut self, value: bool) {
        self.bytes.push(if value { 0xf5 } else { 0xf4 });
    }
}

fn encode_option_fid(encoder: &mut Encoder, value: Option<Fid>) {
    match value {
        Some(fid) => encoder.bytes(&fid.0),
        None => encoder.null(),
    }
}

fn encode_content_ref(encoder: &mut Encoder, content: &ContentRef) {
    encoder.map(2);
    encoder.uint(0);
    match content {
        ContentRef::Chunk(_) => encoder.uint(1),
        ContentRef::Manifest(_) => encoder.uint(2),
    }
    encoder.uint(1);
    match content {
        ContentRef::Chunk(fid) | ContentRef::Manifest(fid) => encoder.bytes(&fid.0),
    }
}

fn encode_checkpoint_ref(encoder: &mut Encoder, checkpoint: &CheckpointRef) {
    encoder.map(3);
    encoder.uint(0);
    encoder.bytes(&checkpoint.fid.0);
    encoder.uint(1);
    encoder.uint(checkpoint.revision);
    encoder.uint(2);
    encode_option_fid(encoder, checkpoint.covered_segment);
}

fn encode_operation(encoder: &mut Encoder, operation: &Operation) {
    match operation {
        Operation::CreateDirectory {
            entry_id,
            parent_id,
            name,
            mtime_ms,
        } => {
            encoder.map(5);
            encoder.uint(0);
            encoder.uint(1);
            encoder.uint(1);
            encoder.bytes(&entry_id.0);
            encoder.uint(2);
            encoder.bytes(&parent_id.0);
            encoder.uint(3);
            encoder.text(name);
            encoder.uint(4);
            encoder.uint(*mtime_ms);
        }
        Operation::CreateFile {
            entry_id,
            parent_id,
            name,
            content,
            size,
            mtime_ms,
        } => {
            encoder.map(7);
            encoder.uint(0);
            encoder.uint(2);
            encoder.uint(1);
            encoder.bytes(&entry_id.0);
            encoder.uint(2);
            encoder.bytes(&parent_id.0);
            encoder.uint(3);
            encoder.text(name);
            encoder.uint(4);
            encode_content_ref(encoder, content);
            encoder.uint(5);
            encoder.uint(*size);
            encoder.uint(6);
            encoder.uint(*mtime_ms);
        }
        Operation::SetFileContent {
            entry_id,
            expected_content,
            content,
            size,
            mtime_ms,
        } => {
            encoder.map(6);
            encoder.uint(0);
            encoder.uint(3);
            encoder.uint(1);
            encoder.bytes(&entry_id.0);
            encoder.uint(2);
            encode_option_fid(encoder, *expected_content);
            encoder.uint(3);
            encode_content_ref(encoder, content);
            encoder.uint(4);
            encoder.uint(*size);
            encoder.uint(5);
            encoder.uint(*mtime_ms);
        }
        Operation::MoveEntry {
            entry_id,
            new_parent_id,
            new_name,
        } => {
            encoder.map(4);
            encoder.uint(0);
            encoder.uint(4);
            encoder.uint(1);
            encoder.bytes(&entry_id.0);
            encoder.uint(2);
            encoder.bytes(&new_parent_id.0);
            encoder.uint(3);
            encoder.text(new_name);
        }
        Operation::RemoveEntry {
            entry_id,
            recursive,
        } => {
            encoder.map(3);
            encoder.uint(0);
            encoder.uint(5);
            encoder.uint(1);
            encoder.bytes(&entry_id.0);
            encoder.uint(2);
            encoder.boolean(*recursive);
        }
    }
}

fn encode_entry(encoder: &mut Encoder, entry: &Entry) {
    let is_file = matches!(entry.kind, EntryKind::File { .. });
    encoder.map(if is_file { 8 } else { 6 });
    encoder.uint(0);
    encoder.bytes(&entry.entry_id.0);
    encoder.uint(1);
    match entry.parent_id {
        Some(parent_id) => encoder.bytes(&parent_id.0),
        None => encoder.null(),
    }
    encoder.uint(2);
    encoder.text(&entry.name);
    encoder.uint(3);
    encoder.uint(if is_file { 2 } else { 1 });
    encoder.uint(4);
    encoder.uint(entry.created_at_ms);
    encoder.uint(5);
    encoder.uint(entry.mtime_ms);
    if let EntryKind::File { content, size } = &entry.kind {
        encoder.uint(6);
        encode_content_ref(encoder, content);
        encoder.uint(7);
        encoder.uint(*size);
    }
}

pub fn encode_head(head: &Head) -> Vec<u8> {
    let mut encoder = Encoder::default();
    encoder.map(10);
    encoder.uint(0);
    encoder.uint(TYPE_HEAD);
    encoder.uint(1);
    encoder.uint(FORMAT_VERSION);
    encoder.uint(2);
    encoder.bytes(&head.lineage_id);
    encoder.uint(3);
    encoder.bytes(&head.root_entry_id.0);
    encoder.uint(4);
    encoder.uint(head.revision);
    encoder.uint(5);
    encode_option_fid(&mut encoder, head.parent_head);
    encoder.uint(6);
    encode_option_fid(&mut encoder, head.last_segment);
    encoder.uint(7);
    match &head.checkpoint {
        Some(checkpoint) => encode_checkpoint_ref(&mut encoder, checkpoint),
        None => encoder.null(),
    }
    encoder.uint(8);
    encoder.uint(head.created_at_ms);
    encoder.uint(9);
    encoder.text(&head.writer_id);
    encoder.finish()
}

pub fn encode_segment(segment: &Segment) -> Vec<u8> {
    let mut encoder = Encoder::default();
    encoder.map(10);
    encoder.uint(0);
    encoder.uint(TYPE_SEGMENT);
    encoder.uint(1);
    encoder.uint(FORMAT_VERSION);
    encoder.uint(2);
    encoder.bytes(&segment.lineage_id);
    encoder.uint(3);
    encoder.bytes(&segment.base_head.0);
    encoder.uint(4);
    encode_option_fid(&mut encoder, segment.previous_segment);
    encoder.uint(5);
    encoder.uint(segment.revision);
    encoder.uint(6);
    encoder.bytes(&segment.transaction_id);
    encoder.uint(7);
    encoder.uint(segment.created_at_ms);
    encoder.uint(8);
    encoder.text(&segment.writer_id);
    encoder.uint(9);
    encoder.array(segment.operations.len());
    for operation in &segment.operations {
        encode_operation(&mut encoder, operation);
    }
    encoder.finish()
}

pub fn encode_manifest(manifest: &Manifest) -> Result<Vec<u8>, String> {
    validate_manifest(manifest)?;
    let mut encoder = Encoder::default();
    encoder.map(5);
    encoder.uint(0);
    encoder.uint(TYPE_MANIFEST);
    encoder.uint(1);
    encoder.uint(FORMAT_VERSION);
    encoder.uint(2);
    encoder.uint(manifest.file_size);
    encoder.uint(3);
    encoder.uint(CHUNK_SIZE);
    encoder.uint(4);
    encoder.array(manifest.chunks.len());
    for chunk in &manifest.chunks {
        encoder.map(2);
        encoder.uint(0);
        encoder.bytes(&chunk.fid.0);
        encoder.uint(1);
        encoder.uint(chunk.length);
    }
    Ok(encoder.finish())
}

pub fn encode_checkpoint(checkpoint: &Checkpoint) -> Vec<u8> {
    let mut entries = checkpoint.entries.clone();
    entries.sort_by_key(|entry| entry.entry_id.0);

    let mut encoder = Encoder::default();
    encoder.map(6);
    encoder.uint(0);
    encoder.uint(TYPE_CHECKPOINT);
    encoder.uint(1);
    encoder.uint(FORMAT_VERSION);
    encoder.uint(2);
    encoder.bytes(&checkpoint.lineage_id);
    encoder.uint(3);
    encoder.uint(checkpoint.revision);
    encoder.uint(4);
    encode_option_fid(&mut encoder, checkpoint.covered_segment);
    encoder.uint(5);
    encoder.array(entries.len());
    for entry in &entries {
        encode_entry(&mut encoder, entry);
    }
    encoder.finish()
}

pub fn validate_manifest(manifest: &Manifest) -> Result<(), String> {
    if manifest.file_size <= CHUNK_SIZE {
        return Err("manifest file_size must be greater than 64 MiB".into());
    }
    if manifest.chunks.len() < 2 {
        return Err("manifest must contain at least two chunks".into());
    }

    let mut total = 0_u64;
    for (index, chunk) in manifest.chunks.iter().enumerate() {
        let is_last = index + 1 == manifest.chunks.len();
        if (!is_last && chunk.length != CHUNK_SIZE)
            || (is_last && !(1..=CHUNK_SIZE).contains(&chunk.length))
        {
            return Err("manifest chunk length violates fixed chunking".into());
        }
        total = total
            .checked_add(chunk.length)
            .ok_or_else(|| "manifest file size overflow".to_string())?;
    }
    if total != manifest.file_size {
        return Err("manifest chunk lengths do not match file_size".into());
    }
    Ok(())
}

pub fn fid_bytes(bytes: &[u8]) -> Fid {
    Fid(xxh3_128_with_seed(bytes, 0).to_be_bytes())
}

pub fn fid_hex(bytes: &[u8]) -> String {
    format!("{:032x}", xxh3_128_with_seed(bytes, 0))
}

pub struct IncrementalFidHasher {
    hasher: Xxh3,
}

impl Default for IncrementalFidHasher {
    fn default() -> Self {
        Self {
            hasher: Xxh3::with_seed(0),
        }
    }
}

impl IncrementalFidHasher {
    pub fn update(&mut self, bytes: &[u8]) {
        self.hasher.update(bytes);
    }

    pub fn finish_hex(&self) -> String {
        format!("{:032x}", self.hasher.digest128())
    }
}

pub fn validate_entry_id(entry_id: EntryId) -> Result<(), String> {
    if entry_id.0 == [0; 16] {
        return Err("entry ID must not be all zeroes".into());
    }
    Ok(())
}

pub fn validate_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("entry name must not be empty".into());
    }
    if name.len() > MAX_ENTRY_NAME_BYTES {
        return Err("entry name exceeds 255 UTF-8 bytes".into());
    }
    if name == "." || name == ".." {
        return Err("entry name must not be . or ..".into());
    }
    if name
        .chars()
        .any(|character| character == '/' || character == '\0' || character.is_control())
    {
        return Err("entry name contains a forbidden character".into());
    }
    if name.nfc().ne(name.chars()) {
        return Err("entry name must be NFC-normalized".into());
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::{
        ABI_VERSION, ChunkRef, Fid, IncrementalFidHasher, MAX_ABI_INPUT_BYTES, Manifest,
        encode_manifest, fid_hex,
    };
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen(js_name = abiVersion)]
    pub fn abi_version() -> u32 {
        ABI_VERSION
    }

    #[wasm_bindgen(js_name = fidHex)]
    pub fn fid_hex_wasm(bytes: &[u8]) -> Result<String, JsError> {
        if bytes.len() > MAX_ABI_INPUT_BYTES {
            return Err(JsError::new("input exceeds 4 MiB ABI call limit"));
        }
        Ok(fid_hex(bytes))
    }

    #[wasm_bindgen(js_name = encodeManifest)]
    pub fn encode_manifest_wasm(
        file_size: u64,
        chunk_fids: &[u8],
        chunk_lengths: Vec<u64>,
    ) -> Result<Vec<u8>, JsError> {
        if chunk_fids.len() != chunk_lengths.len() * 16 {
            return Err(JsError::new("chunk_fids length does not match chunks"));
        }
        let chunks = chunk_lengths
            .into_iter()
            .enumerate()
            .map(|(index, length)| {
                let mut fid = [0_u8; 16];
                fid.copy_from_slice(&chunk_fids[index * 16..(index + 1) * 16]);
                ChunkRef {
                    fid: Fid(fid),
                    length,
                }
            })
            .collect();
        encode_manifest(&Manifest { file_size, chunks }).map_err(|error| JsError::new(&error))
    }

    #[wasm_bindgen(js_name = FidHasher)]
    pub struct FidHasher {
        inner: IncrementalFidHasher,
    }

    #[wasm_bindgen(js_class = FidHasher)]
    impl FidHasher {
        #[wasm_bindgen(constructor)]
        pub fn new() -> Self {
            Self {
                inner: IncrementalFidHasher::default(),
            }
        }

        pub fn update(&mut self, bytes: &[u8]) -> Result<(), JsError> {
            if bytes.len() > MAX_ABI_INPUT_BYTES {
                return Err(JsError::new("input exceeds 4 MiB ABI call limit"));
            }
            self.inner.update(bytes);
            Ok(())
        }

        #[wasm_bindgen(js_name = finishHex)]
        pub fn finish_hex(&self) -> String {
            self.inner.finish_hex()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(value: u8) -> [u8; 16] {
        [value; 16]
    }

    #[test]
    fn xxh3_128_uses_seed_zero_and_fixed_hex() {
        assert_eq!(fid_hex(b""), "99aa06d3014798d86001c324468d497f");
        assert_eq!(fid_hex(b"Biunivers"), "a4ff15b821d21370db519c84c1a8498c");
    }

    #[test]
    fn manifest_requires_fixed_64_mib_chunks() {
        let manifest = Manifest {
            file_size: CHUNK_SIZE + 1,
            chunks: vec![
                ChunkRef {
                    fid: Fid(bytes(1)),
                    length: CHUNK_SIZE,
                },
                ChunkRef {
                    fid: Fid(bytes(2)),
                    length: 1,
                },
            ],
        };
        assert!(encode_manifest(&manifest).is_ok());
    }

    #[test]
    fn incremental_fid_matches_single_pass() {
        let mut hasher = IncrementalFidHasher::default();
        hasher.update(b"Biu");
        hasher.update(b"nivers");
        assert_eq!(hasher.finish_hex(), fid_hex(b"Biunivers"));
    }

    #[test]
    fn entry_identity_and_name_validation_is_strict() {
        assert!(validate_entry_id(EntryId([0; 16])).is_err());
        assert!(validate_entry_id(EntryId([1; 16])).is_ok());
        assert!(validate_entry_name("notes.md").is_ok());
        assert!(validate_entry_name("..").is_err());
        assert!(validate_entry_name("bad/name").is_err());
        assert!(validate_entry_name("e\u{301}").is_err());
        assert!(validate_entry_name("é").is_ok());
    }
}
