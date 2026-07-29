use std::collections::{HashMap, HashSet};
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

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct Fid(pub [u8; 16]);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
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

struct Decoder<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Decoder<'a> {
    fn new(bytes: &'a [u8]) -> Result<Self, String> {
        if bytes.len() > MAX_ENCODED_OBJECT_BYTES {
            return Err("encoded object exceeds 32 MiB".into());
        }
        Ok(Self { bytes, offset: 0 })
    }

    fn finish(self) -> Result<(), String> {
        if self.offset != self.bytes.len() {
            return Err("trailing CBOR bytes".into());
        }
        Ok(())
    }

    fn byte(&mut self) -> Result<u8, String> {
        let value = self
            .bytes
            .get(self.offset)
            .copied()
            .ok_or_else(|| "unexpected end of CBOR".to_string())?;
        self.offset += 1;
        Ok(value)
    }

    fn exact<const N: usize>(&mut self) -> Result<[u8; N], String> {
        let end = self
            .offset
            .checked_add(N)
            .ok_or_else(|| "CBOR offset overflow".to_string())?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or_else(|| "unexpected end of CBOR".to_string())?;
        self.offset = end;
        value
            .try_into()
            .map_err(|_| "invalid fixed CBOR value".to_string())
    }

    fn initial(&mut self, expected_major: u8) -> Result<u64, String> {
        let initial = self.byte()?;
        let major = initial >> 5;
        if major != expected_major {
            return Err(format!(
                "expected CBOR major type {expected_major}, found {major}"
            ));
        }
        let additional = initial & 0x1f;
        match additional {
            0..=23 => Ok(u64::from(additional)),
            24 => {
                let value = u64::from(self.byte()?);
                if value < 24 {
                    return Err("non-canonical CBOR integer".into());
                }
                Ok(value)
            }
            25 => {
                let value = u64::from(u16::from_be_bytes(self.exact()?));
                if value <= u64::from(u8::MAX) {
                    return Err("non-canonical CBOR integer".into());
                }
                Ok(value)
            }
            26 => {
                let value = u64::from(u32::from_be_bytes(self.exact()?));
                if value <= u64::from(u16::MAX) {
                    return Err("non-canonical CBOR integer".into());
                }
                Ok(value)
            }
            27 => {
                let value = u64::from_be_bytes(self.exact()?);
                if value <= u64::from(u32::MAX) {
                    return Err("non-canonical CBOR integer".into());
                }
                Ok(value)
            }
            _ => Err("indefinite or reserved CBOR length is forbidden".into()),
        }
    }

    fn uint(&mut self) -> Result<u64, String> {
        self.initial(0)
    }

    fn map(&mut self, expected_length: u64) -> Result<(), String> {
        if self.initial(5)? != expected_length {
            return Err("unexpected CBOR map length".into());
        }
        Ok(())
    }

    fn array(&mut self) -> Result<u64, String> {
        self.initial(4)
    }

    fn key(&mut self, expected: u64) -> Result<(), String> {
        if self.uint()? != expected {
            return Err("unexpected or non-ordered CBOR map key".into());
        }
        Ok(())
    }

    fn bytes(&mut self, maximum: usize) -> Result<Vec<u8>, String> {
        let length = usize::try_from(self.initial(2)?)
            .map_err(|_| "CBOR byte string is too large".to_string())?;
        if length > maximum {
            return Err("CBOR byte string exceeds its limit".into());
        }
        let end = self
            .offset
            .checked_add(length)
            .ok_or_else(|| "CBOR offset overflow".to_string())?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or_else(|| "unexpected end of CBOR".to_string())?
            .to_vec();
        self.offset = end;
        Ok(value)
    }

    fn bytes_16(&mut self) -> Result<[u8; 16], String> {
        self.bytes(16)?
            .try_into()
            .map_err(|_| "identifier must contain exactly 16 bytes".to_string())
    }

    fn text(&mut self, maximum: usize) -> Result<String, String> {
        let bytes = self.bytes_with_major(3, maximum)?;
        String::from_utf8(bytes).map_err(|_| "CBOR text is not valid UTF-8".into())
    }

    fn bytes_with_major(&mut self, major: u8, maximum: usize) -> Result<Vec<u8>, String> {
        let length = usize::try_from(self.initial(major)?)
            .map_err(|_| "CBOR string is too large".to_string())?;
        if length > maximum {
            return Err("CBOR string exceeds its limit".into());
        }
        let end = self
            .offset
            .checked_add(length)
            .ok_or_else(|| "CBOR offset overflow".to_string())?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or_else(|| "unexpected end of CBOR".to_string())?
            .to_vec();
        self.offset = end;
        Ok(value)
    }

    fn option_fid(&mut self) -> Result<Option<Fid>, String> {
        if self.bytes.get(self.offset) == Some(&0xf6) {
            self.offset += 1;
            return Ok(None);
        }
        Ok(Some(Fid(self.bytes_16()?)))
    }
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

fn decode_content_ref(decoder: &mut Decoder<'_>) -> Result<ContentRef, String> {
    decoder.map(2)?;
    decoder.key(0)?;
    let kind = decoder.uint()?;
    decoder.key(1)?;
    let fid = Fid(decoder.bytes_16()?);
    match kind {
        1 => Ok(ContentRef::Chunk(fid)),
        2 => Ok(ContentRef::Manifest(fid)),
        _ => Err("unknown content reference kind".into()),
    }
}

fn decode_checkpoint_ref(decoder: &mut Decoder<'_>) -> Result<CheckpointRef, String> {
    decoder.map(3)?;
    decoder.key(0)?;
    let fid = Fid(decoder.bytes_16()?);
    decoder.key(1)?;
    let revision = decoder.uint()?;
    decoder.key(2)?;
    let covered_segment = decoder.option_fid()?;
    Ok(CheckpointRef {
        fid,
        revision,
        covered_segment,
    })
}

fn decode_operation(decoder: &mut Decoder<'_>) -> Result<Operation, String> {
    let map_length = decoder.initial(5)?;
    decoder.key(0)?;
    let operation_type = decoder.uint()?;
    let operation = match operation_type {
        1 => {
            if map_length != 5 {
                return Err("unexpected CreateDirectory map length".into());
            }
            decoder.key(1)?;
            let entry_id = EntryId(decoder.bytes_16()?);
            decoder.key(2)?;
            let parent_id = EntryId(decoder.bytes_16()?);
            decoder.key(3)?;
            let name = decoder.text(MAX_ENTRY_NAME_BYTES)?;
            decoder.key(4)?;
            let mtime_ms = decoder.uint()?;
            validate_entry_id(entry_id)?;
            validate_entry_id(parent_id)?;
            validate_entry_name(&name)?;
            Operation::CreateDirectory {
                entry_id,
                parent_id,
                name,
                mtime_ms,
            }
        }
        2 => {
            if map_length != 7 {
                return Err("unexpected CreateFile map length".into());
            }
            decoder.key(1)?;
            let entry_id = EntryId(decoder.bytes_16()?);
            decoder.key(2)?;
            let parent_id = EntryId(decoder.bytes_16()?);
            decoder.key(3)?;
            let name = decoder.text(MAX_ENTRY_NAME_BYTES)?;
            decoder.key(4)?;
            let content = decode_content_ref(decoder)?;
            decoder.key(5)?;
            let size = decoder.uint()?;
            decoder.key(6)?;
            let mtime_ms = decoder.uint()?;
            validate_entry_id(entry_id)?;
            validate_entry_id(parent_id)?;
            validate_entry_name(&name)?;
            Operation::CreateFile {
                entry_id,
                parent_id,
                name,
                content,
                size,
                mtime_ms,
            }
        }
        3 => {
            if map_length != 6 {
                return Err("unexpected SetFileContent map length".into());
            }
            decoder.key(1)?;
            let entry_id = EntryId(decoder.bytes_16()?);
            decoder.key(2)?;
            let expected_content = decoder.option_fid()?;
            decoder.key(3)?;
            let content = decode_content_ref(decoder)?;
            decoder.key(4)?;
            let size = decoder.uint()?;
            decoder.key(5)?;
            let mtime_ms = decoder.uint()?;
            validate_entry_id(entry_id)?;
            Operation::SetFileContent {
                entry_id,
                expected_content,
                content,
                size,
                mtime_ms,
            }
        }
        4 => {
            if map_length != 4 {
                return Err("unexpected MoveEntry map length".into());
            }
            decoder.key(1)?;
            let entry_id = EntryId(decoder.bytes_16()?);
            decoder.key(2)?;
            let new_parent_id = EntryId(decoder.bytes_16()?);
            decoder.key(3)?;
            let new_name = decoder.text(MAX_ENTRY_NAME_BYTES)?;
            validate_entry_id(entry_id)?;
            validate_entry_id(new_parent_id)?;
            validate_entry_name(&new_name)?;
            Operation::MoveEntry {
                entry_id,
                new_parent_id,
                new_name,
            }
        }
        5 => {
            if map_length != 3 {
                return Err("unexpected RemoveEntry map length".into());
            }
            decoder.key(1)?;
            let entry_id = EntryId(decoder.bytes_16()?);
            decoder.key(2)?;
            let recursive = match decoder.byte()? {
                0xf4 => false,
                0xf5 => true,
                _ => return Err("recursive must be a CBOR boolean".into()),
            };
            validate_entry_id(entry_id)?;
            Operation::RemoveEntry {
                entry_id,
                recursive,
            }
        }
        _ => return Err("unknown Segment operation type".into()),
    };
    Ok(operation)
}

fn decode_entry(decoder: &mut Decoder<'_>) -> Result<Entry, String> {
    let map_length = decoder.initial(5)?;
    if map_length != 6 && map_length != 8 {
        return Err("unexpected Checkpoint Entry map length".into());
    }
    decoder.key(0)?;
    let entry_id = EntryId(decoder.bytes_16()?);
    validate_entry_id(entry_id)?;
    decoder.key(1)?;
    let parent_id = if decoder.bytes.get(decoder.offset) == Some(&0xf6) {
        decoder.offset += 1;
        None
    } else {
        Some(EntryId(decoder.bytes_16()?))
    };
    decoder.key(2)?;
    let name = decoder.text(MAX_ENTRY_NAME_BYTES)?;
    decoder.key(3)?;
    let kind = decoder.uint()?;
    decoder.key(4)?;
    let created_at_ms = decoder.uint()?;
    decoder.key(5)?;
    let mtime_ms = decoder.uint()?;
    let kind = match kind {
        1 if map_length == 6 => EntryKind::Directory,
        2 if map_length == 8 => {
            decoder.key(6)?;
            let content = decode_content_ref(decoder)?;
            decoder.key(7)?;
            let size = decoder.uint()?;
            EntryKind::File { content, size }
        }
        _ => return Err("Entry kind does not match its map fields".into()),
    };
    Ok(Entry {
        entry_id,
        parent_id,
        name,
        kind,
        created_at_ms,
        mtime_ms,
    })
}

fn validate_checkpoint_entries(entries: &[Entry]) -> Result<(), String> {
    if entries.is_empty() || entries.len() > 1_000_000 {
        return Err("Checkpoint Entry count is outside its limit".into());
    }
    let mut by_id = HashMap::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        if by_id.insert(entry.entry_id, index).is_some() {
            return Err("Checkpoint contains a duplicate Entry ID".into());
        }
    }

    let roots: Vec<&Entry> = entries
        .iter()
        .filter(|entry| entry.parent_id.is_none())
        .collect();
    if roots.len() != 1
        || !roots[0].name.is_empty()
        || !matches!(roots[0].kind, EntryKind::Directory)
    {
        return Err("Checkpoint must contain exactly one valid root directory".into());
    }

    let mut sibling_names = HashSet::with_capacity(entries.len());
    for entry in entries {
        if let Some(parent_id) = entry.parent_id {
            validate_entry_name(&entry.name)?;
            let parent_index = by_id
                .get(&parent_id)
                .ok_or_else(|| "Checkpoint Entry parent does not exist".to_string())?;
            if !matches!(entries[*parent_index].kind, EntryKind::Directory) {
                return Err("Checkpoint Entry parent is not a directory".into());
            }
            if !sibling_names.insert((parent_id, entry.name.clone())) {
                return Err("Checkpoint contains a duplicate sibling name".into());
            }

            let mut cursor = Some(parent_id);
            let mut remaining = entries.len();
            while let Some(current_id) = cursor {
                if current_id == entry.entry_id {
                    return Err("Checkpoint Entry graph contains a cycle".into());
                }
                if remaining == 0 {
                    return Err("Checkpoint Entry graph exceeds its depth limit".into());
                }
                remaining -= 1;
                let current_index = by_id
                    .get(&current_id)
                    .ok_or_else(|| "Checkpoint Entry ancestor does not exist".to_string())?;
                cursor = entries[*current_index].parent_id;
            }
        }
    }
    Ok(())
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

pub fn decode_head(bytes: &[u8]) -> Result<Head, String> {
    let mut decoder = Decoder::new(bytes)?;
    decoder.map(10)?;
    decoder.key(0)?;
    if decoder.uint()? != TYPE_HEAD {
        return Err("object is not a Head".into());
    }
    decoder.key(1)?;
    if decoder.uint()? != FORMAT_VERSION {
        return Err("unsupported Head format version".into());
    }
    decoder.key(2)?;
    let lineage_id = decoder.bytes_16()?;
    decoder.key(3)?;
    let root_entry_id = EntryId(decoder.bytes_16()?);
    validate_entry_id(root_entry_id)?;
    decoder.key(4)?;
    let revision = decoder.uint()?;
    decoder.key(5)?;
    let parent_head = decoder.option_fid()?;
    decoder.key(6)?;
    let last_segment = decoder.option_fid()?;
    decoder.key(7)?;
    let checkpoint = if decoder.bytes.get(decoder.offset) == Some(&0xf6) {
        decoder.offset += 1;
        None
    } else {
        Some(decode_checkpoint_ref(&mut decoder)?)
    };
    decoder.key(8)?;
    let created_at_ms = decoder.uint()?;
    decoder.key(9)?;
    let writer_id = decoder.text(255)?;
    if writer_id.is_empty() {
        return Err("writer ID must not be empty".into());
    }
    decoder.finish()?;

    let head = Head {
        lineage_id,
        root_entry_id,
        revision,
        parent_head,
        last_segment,
        checkpoint,
        created_at_ms,
        writer_id,
    };
    if encode_head(&head) != bytes {
        return Err("Head is not canonically encoded".into());
    }
    Ok(head)
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

pub fn decode_segment(bytes: &[u8]) -> Result<Segment, String> {
    let mut decoder = Decoder::new(bytes)?;
    decoder.map(10)?;
    decoder.key(0)?;
    if decoder.uint()? != TYPE_SEGMENT {
        return Err("object is not a Segment".into());
    }
    decoder.key(1)?;
    if decoder.uint()? != FORMAT_VERSION {
        return Err("unsupported Segment format version".into());
    }
    decoder.key(2)?;
    let lineage_id = decoder.bytes_16()?;
    if lineage_id == [0; 16] {
        return Err("lineage ID must not be all zeroes".into());
    }
    decoder.key(3)?;
    let base_head = Fid(decoder.bytes_16()?);
    decoder.key(4)?;
    let previous_segment = decoder.option_fid()?;
    decoder.key(5)?;
    let revision = decoder.uint()?;
    decoder.key(6)?;
    let transaction_id = decoder.bytes_16()?;
    if transaction_id == [0; 16] {
        return Err("transaction ID must not be all zeroes".into());
    }
    decoder.key(7)?;
    let created_at_ms = decoder.uint()?;
    decoder.key(8)?;
    let writer_id = decoder.text(255)?;
    if writer_id.is_empty() {
        return Err("writer ID must not be empty".into());
    }
    decoder.key(9)?;
    let operation_count = usize::try_from(decoder.array()?)
        .map_err(|_| "Segment operation count is too large".to_string())?;
    if operation_count == 0 || operation_count > 100_000 {
        return Err("Segment operation count is outside its limit".into());
    }
    let mut operations = Vec::with_capacity(operation_count);
    for _ in 0..operation_count {
        operations.push(decode_operation(&mut decoder)?);
    }
    decoder.finish()?;

    let segment = Segment {
        lineage_id,
        base_head,
        previous_segment,
        revision,
        transaction_id,
        created_at_ms,
        writer_id,
        operations,
    };
    if encode_segment(&segment) != bytes {
        return Err("Segment is not canonically encoded".into());
    }
    Ok(segment)
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

pub fn decode_manifest(bytes: &[u8]) -> Result<Manifest, String> {
    let mut decoder = Decoder::new(bytes)?;
    decoder.map(5)?;
    decoder.key(0)?;
    if decoder.uint()? != TYPE_MANIFEST {
        return Err("object is not a Manifest".into());
    }
    decoder.key(1)?;
    if decoder.uint()? != FORMAT_VERSION {
        return Err("unsupported Manifest format version".into());
    }
    decoder.key(2)?;
    let file_size = decoder.uint()?;
    decoder.key(3)?;
    if decoder.uint()? != CHUNK_SIZE {
        return Err("Manifest chunk size is not 64 MiB".into());
    }
    decoder.key(4)?;
    let chunk_count = usize::try_from(decoder.array()?)
        .map_err(|_| "Manifest chunk count is too large".to_string())?;
    if chunk_count > MAX_ENCODED_OBJECT_BYTES / 20 {
        return Err("Manifest chunk count exceeds its limit".into());
    }
    let mut chunks = Vec::with_capacity(chunk_count);
    for _ in 0..chunk_count {
        decoder.map(2)?;
        decoder.key(0)?;
        let fid = Fid(decoder.bytes_16()?);
        decoder.key(1)?;
        let length = decoder.uint()?;
        chunks.push(ChunkRef { fid, length });
    }
    decoder.finish()?;

    let manifest = Manifest { file_size, chunks };
    validate_manifest(&manifest)?;
    if encode_manifest(&manifest)? != bytes {
        return Err("Manifest is not canonically encoded".into());
    }
    Ok(manifest)
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

pub fn decode_checkpoint(bytes: &[u8]) -> Result<Checkpoint, String> {
    let mut decoder = Decoder::new(bytes)?;
    decoder.map(6)?;
    decoder.key(0)?;
    if decoder.uint()? != TYPE_CHECKPOINT {
        return Err("object is not a Checkpoint".into());
    }
    decoder.key(1)?;
    if decoder.uint()? != FORMAT_VERSION {
        return Err("unsupported Checkpoint format version".into());
    }
    decoder.key(2)?;
    let lineage_id = decoder.bytes_16()?;
    if lineage_id == [0; 16] {
        return Err("lineage ID must not be all zeroes".into());
    }
    decoder.key(3)?;
    let revision = decoder.uint()?;
    decoder.key(4)?;
    let covered_segment = decoder.option_fid()?;
    decoder.key(5)?;
    let entry_count = usize::try_from(decoder.array()?)
        .map_err(|_| "Checkpoint Entry count is too large".to_string())?;
    if entry_count == 0 || entry_count > 1_000_000 {
        return Err("Checkpoint Entry count is outside its limit".into());
    }
    let mut entries = Vec::with_capacity(entry_count);
    for _ in 0..entry_count {
        entries.push(decode_entry(&mut decoder)?);
    }
    decoder.finish()?;
    validate_checkpoint_entries(&entries)?;

    let checkpoint = Checkpoint {
        lineage_id,
        revision,
        covered_segment,
        entries,
    };
    if encode_checkpoint(&checkpoint) != bytes {
        return Err("Checkpoint is not canonically encoded".into());
    }
    Ok(checkpoint)
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

pub fn apply_segment(checkpoint: &Checkpoint, segment: &Segment) -> Result<Checkpoint, String> {
    validate_checkpoint_entries(&checkpoint.entries)?;
    if checkpoint.lineage_id != segment.lineage_id {
        return Err("Segment lineage does not match Checkpoint".into());
    }
    if checkpoint.revision.checked_add(1) != Some(segment.revision) {
        return Err("Segment revision does not follow Checkpoint".into());
    }

    let mut entries = checkpoint.entries.clone();
    for operation in &segment.operations {
        match operation {
            Operation::CreateDirectory {
                entry_id,
                parent_id,
                name,
                mtime_ms,
            } => {
                ensure_new_entry(&entries, *entry_id, *parent_id, name)?;
                entries.push(Entry {
                    entry_id: *entry_id,
                    parent_id: Some(*parent_id),
                    name: name.clone(),
                    kind: EntryKind::Directory,
                    created_at_ms: segment.created_at_ms,
                    mtime_ms: *mtime_ms,
                });
            }
            Operation::CreateFile {
                entry_id,
                parent_id,
                name,
                content,
                size,
                mtime_ms,
            } => {
                ensure_new_entry(&entries, *entry_id, *parent_id, name)?;
                entries.push(Entry {
                    entry_id: *entry_id,
                    parent_id: Some(*parent_id),
                    name: name.clone(),
                    kind: EntryKind::File {
                        content: content.clone(),
                        size: *size,
                    },
                    created_at_ms: segment.created_at_ms,
                    mtime_ms: *mtime_ms,
                });
            }
            Operation::SetFileContent {
                entry_id,
                expected_content,
                content,
                size,
                mtime_ms,
            } => {
                let entry = entries
                    .iter_mut()
                    .find(|entry| entry.entry_id == *entry_id)
                    .ok_or_else(|| "SetFileContent Entry does not exist".to_string())?;
                let EntryKind::File {
                    content: current_content,
                    size: current_size,
                } = &mut entry.kind
                else {
                    return Err("SetFileContent target is not a file".into());
                };
                if let Some(expected_fid) = expected_content
                    && content_fid(current_content) != *expected_fid
                {
                    return Err("SetFileContent expected content does not match".into());
                }
                *current_content = content.clone();
                *current_size = *size;
                entry.mtime_ms = *mtime_ms;
            }
            Operation::MoveEntry {
                entry_id,
                new_parent_id,
                new_name,
            } => {
                if entries
                    .iter()
                    .find(|entry| entry.entry_id == *entry_id)
                    .is_some_and(|entry| entry.parent_id.is_none())
                {
                    return Err("root Entry cannot be moved".into());
                }
                ensure_parent_and_name(&entries, *new_parent_id, new_name, Some(*entry_id))?;
                let entry = entries
                    .iter_mut()
                    .find(|entry| entry.entry_id == *entry_id)
                    .ok_or_else(|| "MoveEntry target does not exist".to_string())?;
                entry.parent_id = Some(*new_parent_id);
                entry.name = new_name.clone();
            }
            Operation::RemoveEntry {
                entry_id,
                recursive,
            } => {
                let target = entries
                    .iter()
                    .find(|entry| entry.entry_id == *entry_id)
                    .ok_or_else(|| "RemoveEntry target does not exist".to_string())?;
                if target.parent_id.is_none() {
                    return Err("root Entry cannot be removed".into());
                }
                let descendants = descendant_ids(&entries, *entry_id);
                if !*recursive && !descendants.is_empty() {
                    return Err("non-empty directory removal requires recursive=true".into());
                }
                entries.retain(|entry| {
                    entry.entry_id != *entry_id && !descendants.contains(&entry.entry_id)
                });
            }
        }
        validate_checkpoint_entries(&entries)?;
    }

    Ok(Checkpoint {
        lineage_id: checkpoint.lineage_id,
        revision: segment.revision,
        covered_segment: None,
        entries,
    })
}

fn ensure_new_entry(
    entries: &[Entry],
    entry_id: EntryId,
    parent_id: EntryId,
    name: &str,
) -> Result<(), String> {
    if entries.iter().any(|entry| entry.entry_id == entry_id) {
        return Err("Entry ID already exists".into());
    }
    ensure_parent_and_name(entries, parent_id, name, None)
}

fn ensure_parent_and_name(
    entries: &[Entry],
    parent_id: EntryId,
    name: &str,
    moving_entry_id: Option<EntryId>,
) -> Result<(), String> {
    validate_entry_name(name)?;
    let parent = entries
        .iter()
        .find(|entry| entry.entry_id == parent_id)
        .ok_or_else(|| "parent Entry does not exist".to_string())?;
    if !matches!(parent.kind, EntryKind::Directory) {
        return Err("parent Entry is not a directory".into());
    }
    if entries.iter().any(|entry| {
        entry.parent_id == Some(parent_id)
            && entry.name == name
            && Some(entry.entry_id) != moving_entry_id
    }) {
        return Err("sibling name already exists".into());
    }
    Ok(())
}

fn descendant_ids(entries: &[Entry], entry_id: EntryId) -> HashSet<EntryId> {
    let mut descendants = HashSet::new();
    let mut frontier = vec![entry_id];
    while let Some(parent_id) = frontier.pop() {
        for child in entries
            .iter()
            .filter(|entry| entry.parent_id == Some(parent_id))
        {
            if descendants.insert(child.entry_id) {
                frontier.push(child.entry_id);
            }
        }
    }
    descendants
}

fn content_fid(content: &ContentRef) -> Fid {
    match content {
        ContentRef::Chunk(fid) | ContentRef::Manifest(fid) => *fid,
    }
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
        ABI_VERSION, Checkpoint, CheckpointRef, ChunkRef, Entry, EntryId, EntryKind, Fid, Head,
        IncrementalFidHasher, MAX_ABI_INPUT_BYTES, Manifest, Operation, Segment, apply_segment,
        decode_checkpoint, decode_head, decode_manifest, decode_segment, encode_checkpoint,
        encode_head, encode_manifest, encode_segment, fid_bytes, fid_hex, validate_entry_id,
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

    #[wasm_bindgen(js_name = validateHead)]
    pub fn validate_head_wasm(bytes: &[u8]) -> Result<(), JsError> {
        decode_head(bytes)
            .map(|_| ())
            .map_err(|error| JsError::new(&error))
    }

    #[wasm_bindgen(js_name = headLineageId)]
    pub fn head_lineage_id_wasm(bytes: &[u8]) -> Result<Vec<u8>, JsError> {
        decode_head(bytes)
            .map(|head| head.lineage_id.to_vec())
            .map_err(|error| JsError::new(&error))
    }

    #[wasm_bindgen(js_name = headRootEntryId)]
    pub fn head_root_entry_id_wasm(bytes: &[u8]) -> Result<Vec<u8>, JsError> {
        decode_head(bytes)
            .map(|head| head.root_entry_id.0.to_vec())
            .map_err(|error| JsError::new(&error))
    }

    #[wasm_bindgen(js_name = headRevision)]
    pub fn head_revision_wasm(bytes: &[u8]) -> Result<u64, JsError> {
        decode_head(bytes)
            .map(|head| head.revision)
            .map_err(|error| JsError::new(&error))
    }

    #[wasm_bindgen(js_name = headLastSegmentFid)]
    pub fn head_last_segment_fid_wasm(bytes: &[u8]) -> Result<Vec<u8>, JsError> {
        decode_head(bytes)
            .map(|head| {
                head.last_segment
                    .map_or_else(Vec::new, |fid| fid.0.to_vec())
            })
            .map_err(|error| JsError::new(&error))
    }

    #[wasm_bindgen(js_name = headCheckpointFid)]
    pub fn head_checkpoint_fid_wasm(bytes: &[u8]) -> Result<Vec<u8>, JsError> {
        decode_head(bytes)
            .and_then(|head| {
                head.checkpoint
                    .map(|checkpoint| checkpoint.fid.0.to_vec())
                    .ok_or_else(|| "Head does not reference a Checkpoint".to_string())
            })
            .map_err(|error| JsError::new(&error))
    }

    #[wasm_bindgen(js_name = validateManifest)]
    pub fn validate_manifest_wasm(bytes: &[u8]) -> Result<(), JsError> {
        decode_manifest(bytes)
            .map(|_| ())
            .map_err(|error| JsError::new(&error))
    }

    #[wasm_bindgen(js_name = manifestFileSize)]
    pub fn manifest_file_size_wasm(bytes: &[u8]) -> Result<u64, JsError> {
        decode_manifest(bytes)
            .map(|manifest| manifest.file_size)
            .map_err(|error| JsError::new(&error))
    }

    #[wasm_bindgen(js_name = manifestChunkFids)]
    pub fn manifest_chunk_fids_wasm(bytes: &[u8]) -> Result<Vec<u8>, JsError> {
        decode_manifest(bytes)
            .map(|manifest| {
                manifest
                    .chunks
                    .into_iter()
                    .flat_map(|chunk| chunk.fid.0)
                    .collect()
            })
            .map_err(|error| JsError::new(&error))
    }

    #[wasm_bindgen(js_name = manifestChunkLengths)]
    pub fn manifest_chunk_lengths_wasm(bytes: &[u8]) -> Result<Vec<u64>, JsError> {
        decode_manifest(bytes)
            .map(|manifest| {
                manifest
                    .chunks
                    .into_iter()
                    .map(|chunk| chunk.length)
                    .collect()
            })
            .map_err(|error| JsError::new(&error))
    }

    #[wasm_bindgen(js_name = validateSegment)]
    pub fn validate_segment_wasm(bytes: &[u8]) -> Result<(), JsError> {
        decode_segment(bytes)
            .map(|_| ())
            .map_err(|error| JsError::new(&error))
    }

    #[wasm_bindgen(js_name = validateCheckpoint)]
    pub fn validate_checkpoint_wasm(bytes: &[u8]) -> Result<(), JsError> {
        decode_checkpoint(bytes)
            .map(|_| ())
            .map_err(|error| JsError::new(&error))
    }

    #[wasm_bindgen(js_name = encodeGenesisCheckpoint)]
    pub fn encode_genesis_checkpoint_wasm(
        lineage_id: &[u8],
        root_entry_id: &[u8],
        created_at_ms: u64,
    ) -> Result<Vec<u8>, JsError> {
        let lineage_id = array_16(lineage_id, "lineage ID")?;
        if lineage_id == [0; 16] {
            return Err(JsError::new("lineage ID must not be all zeroes"));
        }
        let root_entry_id = EntryId(array_16(root_entry_id, "root Entry ID")?);
        validate_entry_id(root_entry_id).map_err(|error| JsError::new(&error))?;
        Ok(encode_checkpoint(&Checkpoint {
            lineage_id,
            revision: 0,
            covered_segment: None,
            entries: vec![Entry {
                entry_id: root_entry_id,
                parent_id: None,
                name: String::new(),
                kind: EntryKind::Directory,
                created_at_ms,
                mtime_ms: created_at_ms,
            }],
        }))
    }

    #[wasm_bindgen(js_name = encodeGenesisHead)]
    pub fn encode_genesis_head_wasm(
        lineage_id: &[u8],
        root_entry_id: &[u8],
        checkpoint_fid: &[u8],
        created_at_ms: u64,
        writer_id: String,
    ) -> Result<Vec<u8>, JsError> {
        let lineage_id = array_16(lineage_id, "lineage ID")?;
        if lineage_id == [0; 16] {
            return Err(JsError::new("lineage ID must not be all zeroes"));
        }
        let root_entry_id = EntryId(array_16(root_entry_id, "root Entry ID")?);
        validate_entry_id(root_entry_id).map_err(|error| JsError::new(&error))?;
        let checkpoint_fid = Fid(array_16(checkpoint_fid, "Checkpoint FID")?);
        if writer_id.is_empty() || writer_id.len() > 255 {
            return Err(JsError::new("writer ID must contain 1 to 255 UTF-8 bytes"));
        }
        Ok(encode_head(&Head {
            lineage_id,
            root_entry_id,
            revision: 0,
            parent_head: None,
            last_segment: None,
            checkpoint: Some(CheckpointRef {
                fid: checkpoint_fid,
                revision: 0,
                covered_segment: None,
            }),
            created_at_ms,
            writer_id,
        }))
    }

    #[wasm_bindgen(js_name = encodeCreateFileSegment)]
    #[allow(clippy::too_many_arguments)]
    pub fn encode_create_file_segment_wasm(
        lineage_id: &[u8],
        base_head_fid: &[u8],
        previous_segment_fid: &[u8],
        revision: u64,
        transaction_id: &[u8],
        created_at_ms: u64,
        writer_id: String,
        entry_id: &[u8],
        parent_id: &[u8],
        name: String,
        content_kind: u32,
        content_fid: &[u8],
        size: u64,
        mtime_ms: u64,
    ) -> Result<Vec<u8>, JsError> {
        let segment = segment_base(
            lineage_id,
            base_head_fid,
            previous_segment_fid,
            revision,
            transaction_id,
            created_at_ms,
            writer_id,
        )?;
        let operation = Operation::CreateFile {
            entry_id: EntryId(array_16(entry_id, "Entry ID")?),
            parent_id: EntryId(array_16(parent_id, "parent Entry ID")?),
            name,
            content: content_ref(content_kind, content_fid)?,
            size,
            mtime_ms,
        };
        let segment = Segment {
            operations: vec![operation],
            ..segment
        };
        decode_segment(&encode_segment(&segment))
            .map(|_| encode_segment(&segment))
            .map_err(|error| JsError::new(&error))
    }

    #[wasm_bindgen(js_name = encodeSetFileContentSegment)]
    #[allow(clippy::too_many_arguments)]
    pub fn encode_set_file_content_segment_wasm(
        lineage_id: &[u8],
        base_head_fid: &[u8],
        previous_segment_fid: &[u8],
        revision: u64,
        transaction_id: &[u8],
        created_at_ms: u64,
        writer_id: String,
        entry_id: &[u8],
        expected_content_fid: &[u8],
        content_kind: u32,
        content_fid: &[u8],
        size: u64,
        mtime_ms: u64,
    ) -> Result<Vec<u8>, JsError> {
        let segment = segment_base(
            lineage_id,
            base_head_fid,
            previous_segment_fid,
            revision,
            transaction_id,
            created_at_ms,
            writer_id,
        )?;
        let expected_content = if expected_content_fid.is_empty() {
            None
        } else {
            Some(Fid(array_16(expected_content_fid, "expected content FID")?))
        };
        let operation = Operation::SetFileContent {
            entry_id: EntryId(array_16(entry_id, "Entry ID")?),
            expected_content,
            content: content_ref(content_kind, content_fid)?,
            size,
            mtime_ms,
        };
        let segment = Segment {
            operations: vec![operation],
            ..segment
        };
        decode_segment(&encode_segment(&segment))
            .map(|_| encode_segment(&segment))
            .map_err(|error| JsError::new(&error))
    }

    #[wasm_bindgen(js_name = encodeCreateDirectorySegment)]
    #[allow(clippy::too_many_arguments)]
    pub fn encode_create_directory_segment_wasm(
        lineage_id: &[u8],
        base_head_fid: &[u8],
        previous_segment_fid: &[u8],
        revision: u64,
        transaction_id: &[u8],
        created_at_ms: u64,
        writer_id: String,
        entry_id: &[u8],
        parent_id: &[u8],
        name: String,
        mtime_ms: u64,
    ) -> Result<Vec<u8>, JsError> {
        let segment = segment_base(
            lineage_id,
            base_head_fid,
            previous_segment_fid,
            revision,
            transaction_id,
            created_at_ms,
            writer_id,
        )?;
        let segment = Segment {
            operations: vec![Operation::CreateDirectory {
                entry_id: EntryId(array_16(entry_id, "Entry ID")?),
                parent_id: EntryId(array_16(parent_id, "parent Entry ID")?),
                name,
                mtime_ms,
            }],
            ..segment
        };
        validated_segment_bytes(segment)
    }

    #[wasm_bindgen(js_name = encodeMoveEntrySegment)]
    #[allow(clippy::too_many_arguments)]
    pub fn encode_move_entry_segment_wasm(
        lineage_id: &[u8],
        base_head_fid: &[u8],
        previous_segment_fid: &[u8],
        revision: u64,
        transaction_id: &[u8],
        created_at_ms: u64,
        writer_id: String,
        entry_id: &[u8],
        new_parent_id: &[u8],
        new_name: String,
    ) -> Result<Vec<u8>, JsError> {
        let segment = segment_base(
            lineage_id,
            base_head_fid,
            previous_segment_fid,
            revision,
            transaction_id,
            created_at_ms,
            writer_id,
        )?;
        let segment = Segment {
            operations: vec![Operation::MoveEntry {
                entry_id: EntryId(array_16(entry_id, "Entry ID")?),
                new_parent_id: EntryId(array_16(new_parent_id, "new parent Entry ID")?),
                new_name,
            }],
            ..segment
        };
        validated_segment_bytes(segment)
    }

    #[wasm_bindgen(js_name = encodeRemoveEntrySegment)]
    #[allow(clippy::too_many_arguments)]
    pub fn encode_remove_entry_segment_wasm(
        lineage_id: &[u8],
        base_head_fid: &[u8],
        previous_segment_fid: &[u8],
        revision: u64,
        transaction_id: &[u8],
        created_at_ms: u64,
        writer_id: String,
        entry_id: &[u8],
        recursive: bool,
    ) -> Result<Vec<u8>, JsError> {
        let segment = segment_base(
            lineage_id,
            base_head_fid,
            previous_segment_fid,
            revision,
            transaction_id,
            created_at_ms,
            writer_id,
        )?;
        let segment = Segment {
            operations: vec![Operation::RemoveEntry {
                entry_id: EntryId(array_16(entry_id, "Entry ID")?),
                recursive,
            }],
            ..segment
        };
        validated_segment_bytes(segment)
    }

    #[wasm_bindgen(js_name = applySegment)]
    pub fn apply_segment_wasm(
        checkpoint_bytes: &[u8],
        segment_bytes: &[u8],
    ) -> Result<Vec<u8>, JsError> {
        let checkpoint =
            decode_checkpoint(checkpoint_bytes).map_err(|error| JsError::new(&error))?;
        let segment = decode_segment(segment_bytes).map_err(|error| JsError::new(&error))?;
        let mut applied =
            apply_segment(&checkpoint, &segment).map_err(|error| JsError::new(&error))?;
        applied.covered_segment = Some(fid_bytes(segment_bytes));
        Ok(encode_checkpoint(&applied))
    }

    #[wasm_bindgen(js_name = checkpointEntriesPacked)]
    pub fn checkpoint_entries_packed_wasm(bytes: &[u8]) -> Result<Vec<u8>, JsError> {
        let checkpoint = decode_checkpoint(bytes).map_err(|error| JsError::new(&error))?;
        let count = u32::try_from(checkpoint.entries.len())
            .map_err(|_| JsError::new("Checkpoint contains too many Entries"))?;
        let mut packed = Vec::new();
        packed.extend(count.to_be_bytes());
        for entry in checkpoint.entries {
            packed.extend(entry.entry_id.0);
            match entry.parent_id {
                Some(parent_id) => {
                    packed.push(1);
                    packed.extend(parent_id.0);
                }
                None => {
                    packed.push(0);
                    packed.extend([0_u8; 16]);
                }
            }
            match entry.kind {
                EntryKind::Directory => {
                    packed.push(1);
                    packed.extend(entry.created_at_ms.to_be_bytes());
                    packed.extend(entry.mtime_ms.to_be_bytes());
                    packed.extend(0_u64.to_be_bytes());
                    packed.push(0);
                    packed.extend([0_u8; 16]);
                }
                EntryKind::File { content, size } => {
                    packed.push(2);
                    packed.extend(entry.created_at_ms.to_be_bytes());
                    packed.extend(entry.mtime_ms.to_be_bytes());
                    packed.extend(size.to_be_bytes());
                    match content {
                        super::ContentRef::Chunk(fid) => {
                            packed.push(1);
                            packed.extend(fid.0);
                        }
                        super::ContentRef::Manifest(fid) => {
                            packed.push(2);
                            packed.extend(fid.0);
                        }
                    }
                }
            }
            let name = entry.name.as_bytes();
            let name_length =
                u32::try_from(name.len()).map_err(|_| JsError::new("Entry name is too large"))?;
            packed.extend(name_length.to_be_bytes());
            packed.extend(name);
        }
        Ok(packed)
    }

    #[wasm_bindgen(js_name = encodeAdvancedHead)]
    pub fn encode_advanced_head_wasm(
        previous_head_bytes: &[u8],
        segment_fid: &[u8],
        checkpoint_fid: &[u8],
        created_at_ms: u64,
        writer_id: String,
    ) -> Result<Vec<u8>, JsError> {
        let previous = decode_head(previous_head_bytes).map_err(|error| JsError::new(&error))?;
        let revision = previous
            .revision
            .checked_add(1)
            .ok_or_else(|| JsError::new("Head revision overflow"))?;
        if writer_id.is_empty() || writer_id.len() > 255 {
            return Err(JsError::new("writer ID must contain 1 to 255 UTF-8 bytes"));
        }
        Ok(encode_head(&Head {
            lineage_id: previous.lineage_id,
            root_entry_id: previous.root_entry_id,
            revision,
            parent_head: Some(fid_bytes(previous_head_bytes)),
            last_segment: Some(Fid(array_16(segment_fid, "Segment FID")?)),
            checkpoint: Some(CheckpointRef {
                fid: Fid(array_16(checkpoint_fid, "Checkpoint FID")?),
                revision,
                covered_segment: Some(Fid(array_16(segment_fid, "Segment FID")?)),
            }),
            created_at_ms,
            writer_id,
        }))
    }

    fn segment_base(
        lineage_id: &[u8],
        base_head_fid: &[u8],
        previous_segment_fid: &[u8],
        revision: u64,
        transaction_id: &[u8],
        created_at_ms: u64,
        writer_id: String,
    ) -> Result<Segment, JsError> {
        let lineage_id = array_16(lineage_id, "lineage ID")?;
        if lineage_id == [0; 16] {
            return Err(JsError::new("lineage ID must not be all zeroes"));
        }
        let previous_segment = if previous_segment_fid.is_empty() {
            None
        } else {
            Some(Fid(array_16(previous_segment_fid, "previous Segment FID")?))
        };
        if writer_id.is_empty() || writer_id.len() > 255 {
            return Err(JsError::new("writer ID must contain 1 to 255 UTF-8 bytes"));
        }
        Ok(Segment {
            lineage_id,
            base_head: Fid(array_16(base_head_fid, "base Head FID")?),
            previous_segment,
            revision,
            transaction_id: array_16(transaction_id, "transaction ID")?,
            created_at_ms,
            writer_id,
            operations: Vec::new(),
        })
    }

    fn validated_segment_bytes(segment: Segment) -> Result<Vec<u8>, JsError> {
        let bytes = encode_segment(&segment);
        decode_segment(&bytes)
            .map(|_| bytes)
            .map_err(|error| JsError::new(&error))
    }

    fn content_ref(kind: u32, fid: &[u8]) -> Result<super::ContentRef, JsError> {
        let fid = Fid(array_16(fid, "content FID")?);
        match kind {
            1 => Ok(super::ContentRef::Chunk(fid)),
            2 => Ok(super::ContentRef::Manifest(fid)),
            _ => Err(JsError::new("content kind must be 1 or 2")),
        }
    }

    fn array_16(bytes: &[u8], label: &str) -> Result<[u8; 16], JsError> {
        bytes
            .try_into()
            .map_err(|_| JsError::new(&format!("{label} must contain exactly 16 bytes")))
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

    #[test]
    fn head_and_manifest_round_trip_through_strict_decoders() {
        let head = Head {
            lineage_id: bytes(1),
            root_entry_id: EntryId(bytes(2)),
            revision: 1,
            parent_head: Some(Fid(bytes(3))),
            last_segment: None,
            checkpoint: Some(CheckpointRef {
                fid: Fid(bytes(4)),
                revision: 0,
                covered_segment: None,
            }),
            created_at_ms: 1_785_320_000_000,
            writer_id: "writer-1".into(),
        };
        let encoded_head = encode_head(&head);
        assert_eq!(decode_head(&encoded_head), Ok(head));

        let manifest = Manifest {
            file_size: CHUNK_SIZE + 7,
            chunks: vec![
                ChunkRef {
                    fid: Fid(bytes(5)),
                    length: CHUNK_SIZE,
                },
                ChunkRef {
                    fid: Fid(bytes(6)),
                    length: 7,
                },
            ],
        };
        let encoded_manifest = encode_manifest(&manifest).unwrap();
        assert_eq!(decode_manifest(&encoded_manifest), Ok(manifest));
    }

    #[test]
    fn segment_and_checkpoint_round_trip_through_strict_decoders() {
        let content = ContentRef::Chunk(Fid(bytes(9)));
        let segment = Segment {
            lineage_id: bytes(1),
            base_head: Fid(bytes(2)),
            previous_segment: None,
            revision: 1,
            transaction_id: bytes(3),
            created_at_ms: 1_785_320_000_000,
            writer_id: "writer-1".into(),
            operations: vec![Operation::CreateFile {
                entry_id: EntryId(bytes(5)),
                parent_id: EntryId(bytes(4)),
                name: "notes.md".into(),
                content: content.clone(),
                size: 9,
                mtime_ms: 1_785_320_000_000,
            }],
        };
        let encoded_segment = encode_segment(&segment);
        assert_eq!(decode_segment(&encoded_segment), Ok(segment));

        let checkpoint = Checkpoint {
            lineage_id: bytes(1),
            revision: 1,
            covered_segment: Some(Fid(bytes(6))),
            entries: vec![
                Entry {
                    entry_id: EntryId(bytes(4)),
                    parent_id: None,
                    name: String::new(),
                    kind: EntryKind::Directory,
                    created_at_ms: 1_785_320_000_000,
                    mtime_ms: 1_785_320_000_000,
                },
                Entry {
                    entry_id: EntryId(bytes(5)),
                    parent_id: Some(EntryId(bytes(4))),
                    name: "notes.md".into(),
                    kind: EntryKind::File { content, size: 9 },
                    created_at_ms: 1_785_320_000_000,
                    mtime_ms: 1_785_320_000_000,
                },
            ],
        };
        let encoded_checkpoint = encode_checkpoint(&checkpoint);
        assert_eq!(decode_checkpoint(&encoded_checkpoint), Ok(checkpoint));
    }

    #[test]
    fn decoders_reject_trailing_noncanonical_and_invalid_data() {
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
        let mut trailing = encode_manifest(&manifest).unwrap();
        trailing.push(0);
        assert!(decode_manifest(&trailing).is_err());

        let mut wrong_chunk_size = encode_manifest(&manifest).unwrap();
        let position = wrong_chunk_size
            .windows(5)
            .position(|window| window == [0x1a, 0x04, 0x00, 0x00, 0x00])
            .unwrap();
        wrong_chunk_size[position + 4] = 1;
        assert!(decode_manifest(&wrong_chunk_size).is_err());
    }

    #[test]
    fn segment_application_enforces_identity_updates_and_root_protection() {
        let root_id = EntryId(bytes(1));
        let directory_id = EntryId(bytes(2));
        let file_id = EntryId(bytes(3));
        let checkpoint = Checkpoint {
            lineage_id: bytes(9),
            revision: 0,
            covered_segment: None,
            entries: vec![Entry {
                entry_id: root_id,
                parent_id: None,
                name: String::new(),
                kind: EntryKind::Directory,
                created_at_ms: 10,
                mtime_ms: 10,
            }],
        };
        let segment = Segment {
            lineage_id: bytes(9),
            base_head: Fid(bytes(8)),
            previous_segment: None,
            revision: 1,
            transaction_id: bytes(7),
            created_at_ms: 20,
            writer_id: "test".into(),
            operations: vec![
                Operation::CreateDirectory {
                    entry_id: directory_id,
                    parent_id: root_id,
                    name: "docs".into(),
                    mtime_ms: 20,
                },
                Operation::CreateFile {
                    entry_id: file_id,
                    parent_id: directory_id,
                    name: "notes.md".into(),
                    content: ContentRef::Chunk(Fid(bytes(4))),
                    size: 1,
                    mtime_ms: 20,
                },
                Operation::SetFileContent {
                    entry_id: file_id,
                    expected_content: Some(Fid(bytes(4))),
                    content: ContentRef::Chunk(Fid(bytes(5))),
                    size: 2,
                    mtime_ms: 21,
                },
                Operation::MoveEntry {
                    entry_id: file_id,
                    new_parent_id: root_id,
                    new_name: "moved.md".into(),
                },
            ],
        };
        let applied = apply_segment(&checkpoint, &segment).unwrap();
        assert_eq!(applied.revision, 1);
        assert!(applied.entries.iter().any(|entry| {
            entry.entry_id == file_id
                && entry.parent_id == Some(root_id)
                && entry.name == "moved.md"
                && matches!(
                    entry.kind,
                    EntryKind::File {
                        content: ContentRef::Chunk(Fid(fid)),
                        size: 2
                    } if fid == bytes(5)
                )
        }));

        let non_recursive = Segment {
            lineage_id: bytes(9),
            base_head: Fid(bytes(6)),
            previous_segment: None,
            revision: 2,
            transaction_id: bytes(6),
            created_at_ms: 30,
            writer_id: "test".into(),
            operations: vec![Operation::RemoveEntry {
                entry_id: root_id,
                recursive: true,
            }],
        };
        assert!(apply_segment(&applied, &non_recursive).is_err());
    }
}
