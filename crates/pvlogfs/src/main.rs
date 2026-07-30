use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsStr;
use std::fs::File;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use fuser::{
    Config, Errno, FileAttr, FileHandle, FileType, Filesystem, FopenFlags, Generation, INodeNo,
    LockOwner, MountOption, OpenAccMode, OpenFlags, ReplyAttr, ReplyData, ReplyDirectory,
    ReplyEntry, ReplyOpen, ReplyStatfs, Request,
};
use serde::Deserialize;

const TTL: Duration = Duration::from_secs(1);
const PROTOCOL_VERSION: u8 = 1;
const OP_READ: u8 = 1;
const MAX_READ_BYTES: u32 = 1024 * 1024;
const READ_REQUEST_BYTES: usize = 62;
const MAX_RESPONSE_BYTES: usize = MAX_READ_BYTES as usize + 1;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    workspace_id_hex: String,
    head_fid_hex: String,
    revision: u64,
    root_inode: u64,
    entries: Vec<SnapshotEntry>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotEntry {
    inode: u64,
    parent_inode: Option<u64>,
    entry_id_hex: String,
    name: String,
    kind: EntryKind,
    size: u64,
    mtime_ms: u64,
}

#[derive(Clone, Copy, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
enum EntryKind {
    Directory,
    File,
}

struct PvlogFs {
    socket_path: PathBuf,
    capability: [u8; 32],
    root_inode: u64,
    entries: HashMap<u64, SnapshotEntry>,
    lookup: HashMap<(u64, String), u64>,
    children: HashMap<u64, Vec<u64>>,
}

impl PvlogFs {
    fn from_snapshot(
        snapshot: Snapshot,
        socket_path: PathBuf,
        capability: [u8; 32],
    ) -> Result<Self, String> {
        if snapshot.entries.is_empty()
            || snapshot.root_inode != 1
            || !is_hex(&snapshot.workspace_id_hex, 32)
            || !is_hex(&snapshot.head_fid_hex, 32)
        {
            return Err("snapshot identity or root is invalid".to_owned());
        }
        let mut entries = HashMap::new();
        let mut lookup = HashMap::new();
        let mut children: HashMap<u64, Vec<u64>> = HashMap::new();
        for entry in snapshot.entries {
            if entry.inode == 0
                || !is_hex(&entry.entry_id_hex, 32)
                || entries.insert(entry.inode, entry.clone()).is_some()
            {
                return Err("snapshot contains an invalid Entry or inode".to_owned());
            }
            if let Some(parent) = entry.parent_inode {
                if entry.name.is_empty()
                    || entry.name == "."
                    || entry.name == ".."
                    || entry.name.contains('/')
                    || entry.name.contains('\0')
                    || lookup
                        .insert((parent, entry.name.clone()), entry.inode)
                        .is_some()
                {
                    return Err("snapshot contains an invalid sibling name".to_owned());
                }
                children.entry(parent).or_default().push(entry.inode);
            } else if !entry.name.is_empty() {
                return Err("snapshot root name is invalid".to_owned());
            }
        }
        let root = entries
            .get(&snapshot.root_inode)
            .ok_or_else(|| "snapshot root inode is missing".to_owned())?;
        if root.parent_inode.is_some() || root.kind != EntryKind::Directory {
            return Err("snapshot root is invalid".to_owned());
        }
        for entry in entries.values() {
            if let Some(parent) = entry.parent_inode
                && entries.get(&parent).map(|value| value.kind) != Some(EntryKind::Directory)
            {
                return Err("snapshot Entry parent is invalid".to_owned());
            }
        }
        validate_reachable(snapshot.root_inode, &entries, &children)?;
        for values in children.values_mut() {
            values.sort_by(|left, right| {
                entries[left]
                    .name
                    .as_bytes()
                    .cmp(entries[right].name.as_bytes())
            });
        }
        eprintln!(
            "PVLogFS fixed Workspace {} HEAD {} revision {} with {} Entries",
            snapshot.workspace_id_hex,
            snapshot.head_fid_hex,
            snapshot.revision,
            entries.len()
        );
        Ok(Self {
            socket_path,
            capability,
            root_inode: snapshot.root_inode,
            entries,
            lookup,
            children,
        })
    }

    fn attr(&self, inode: u64) -> Option<FileAttr> {
        let entry = self.entries.get(&inode)?;
        let kind = match entry.kind {
            EntryKind::Directory => FileType::Directory,
            EntryKind::File => FileType::RegularFile,
        };
        let mtime = UNIX_EPOCH
            .checked_add(Duration::from_millis(entry.mtime_ms))
            .unwrap_or(UNIX_EPOCH);
        Some(FileAttr {
            ino: INodeNo(inode),
            size: entry.size,
            blocks: entry.size.div_ceil(512),
            atime: mtime,
            mtime,
            ctime: mtime,
            crtime: mtime,
            kind,
            perm: if entry.kind == EntryKind::Directory {
                0o755
            } else {
                0o644
            },
            nlink: if entry.kind == EntryKind::Directory {
                2 + self.children.get(&inode).map_or(0, |items| {
                    items
                        .iter()
                        .filter(|child| self.entries[child].kind == EntryKind::Directory)
                        .count()
                }) as u32
            } else {
                1
            },
            uid: unsafe { libc_getuid() },
            gid: unsafe { libc_getgid() },
            rdev: 0,
            blksize: 4096,
            flags: 0,
        })
    }

    fn read_gateway(
        &self,
        entry: &SnapshotEntry,
        offset: u64,
        size: u32,
    ) -> Result<Vec<u8>, String> {
        let size = size.min(MAX_READ_BYTES);
        let mut payload = Vec::with_capacity(READ_REQUEST_BYTES);
        payload.push(PROTOCOL_VERSION);
        payload.push(OP_READ);
        payload.extend(self.capability);
        payload.extend(decode_hex::<16>(&entry.entry_id_hex)?);
        payload.extend(offset.to_be_bytes());
        payload.extend(size.to_be_bytes());
        debug_assert_eq!(payload.len(), READ_REQUEST_BYTES);

        let mut stream =
            UnixStream::connect(&self.socket_path).map_err(|error| error.to_string())?;
        stream
            .write_all(&(payload.len() as u32).to_be_bytes())
            .and_then(|_| stream.write_all(&payload))
            .and_then(|_| stream.shutdown(std::net::Shutdown::Write))
            .map_err(|error| error.to_string())?;
        let mut length_bytes = [0_u8; 4];
        stream
            .read_exact(&mut length_bytes)
            .map_err(|error| error.to_string())?;
        let length = u32::from_be_bytes(length_bytes) as usize;
        if length == 0 || length > MAX_RESPONSE_BYTES {
            return Err("Gateway response length is invalid".to_owned());
        }
        let mut response = vec![0_u8; length];
        stream
            .read_exact(&mut response)
            .map_err(|error| error.to_string())?;
        let status = response[0];
        let body = response.split_off(1);
        if status != 0 {
            return Err(String::from_utf8(body)
                .unwrap_or_else(|_| "Gateway returned an invalid error".to_owned()));
        }
        if body.len() > size as usize {
            return Err("Gateway returned more bytes than requested".to_owned());
        }
        Ok(body)
    }
}

impl Filesystem for PvlogFs {
    fn lookup(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
        let Some(name) = name.to_str() else {
            reply.error(Errno::ENOENT);
            return;
        };
        match self.lookup.get(&(u64::from(parent), name.to_owned())) {
            Some(inode) => reply.entry(
                &TTL,
                &self.attr(*inode).expect("indexed inode"),
                Generation(0),
            ),
            None => reply.error(Errno::ENOENT),
        }
    }

    fn getattr(&self, _req: &Request, ino: INodeNo, _fh: Option<FileHandle>, reply: ReplyAttr) {
        match self.attr(u64::from(ino)) {
            Some(value) => reply.attr(&TTL, &value),
            None => reply.error(Errno::ENOENT),
        }
    }

    fn readdir(
        &self,
        _req: &Request,
        ino: INodeNo,
        _fh: FileHandle,
        offset: u64,
        mut reply: ReplyDirectory,
    ) {
        let inode = u64::from(ino);
        let Some(entry) = self.entries.get(&inode) else {
            reply.error(Errno::ENOENT);
            return;
        };
        if entry.kind != EntryKind::Directory {
            reply.error(Errno::ENOTDIR);
            return;
        }
        let parent = entry.parent_inode.unwrap_or(self.root_inode);
        let mut values: Vec<(u64, FileType, &str)> = vec![
            (inode, FileType::Directory, "."),
            (parent, FileType::Directory, ".."),
        ];
        for child in self.children.get(&inode).into_iter().flatten() {
            let child_entry = &self.entries[child];
            values.push((
                *child,
                if child_entry.kind == EntryKind::Directory {
                    FileType::Directory
                } else {
                    FileType::RegularFile
                },
                &child_entry.name,
            ));
        }
        for (index, value) in values.into_iter().enumerate().skip(offset as usize) {
            if reply.add(INodeNo(value.0), (index + 1) as u64, value.1, value.2) {
                break;
            }
        }
        reply.ok();
    }

    fn open(&self, _req: &Request, ino: INodeNo, flags: OpenFlags, reply: ReplyOpen) {
        let Some(entry) = self.entries.get(&u64::from(ino)) else {
            reply.error(Errno::ENOENT);
            return;
        };
        if entry.kind != EntryKind::File {
            reply.error(Errno::EISDIR);
        } else if flags.acc_mode() != OpenAccMode::O_RDONLY {
            reply.error(Errno::EROFS);
        } else {
            reply.opened(FileHandle(0), FopenFlags::empty());
        }
    }

    fn read(
        &self,
        _req: &Request,
        ino: INodeNo,
        _fh: FileHandle,
        offset: u64,
        size: u32,
        _flags: OpenFlags,
        _lock_owner: Option<LockOwner>,
        reply: ReplyData,
    ) {
        let Some(entry) = self.entries.get(&u64::from(ino)) else {
            reply.error(Errno::ENOENT);
            return;
        };
        if entry.kind != EntryKind::File {
            reply.error(Errno::EISDIR);
            return;
        }
        let start = offset.min(entry.size);
        let remaining = entry.size - start;
        let requested = size.min(MAX_READ_BYTES).min(remaining as u32);
        if requested == 0 {
            reply.data(&[]);
            return;
        }
        match self.read_gateway(entry, start, requested) {
            Ok(bytes) => reply.data(&bytes),
            Err(error) => {
                eprintln!("PVLogFS Gateway read failed: {error}");
                reply.error(Errno::EIO);
            }
        }
    }

    fn statfs(&self, _req: &Request, _ino: INodeNo, reply: ReplyStatfs) {
        let bytes = self.entries.values().map(|entry| entry.size).sum::<u64>();
        let blocks = bytes.div_ceil(512);
        reply.statfs(blocks, 0, 0, self.entries.len() as u64, 0, 512, 255, 4096);
    }
}

fn validate_reachable(
    root: u64,
    entries: &HashMap<u64, SnapshotEntry>,
    children: &HashMap<u64, Vec<u64>>,
) -> Result<(), String> {
    let mut queue = VecDeque::from([root]);
    let mut visited = HashSet::new();
    while let Some(inode) = queue.pop_front() {
        if !visited.insert(inode) {
            return Err("snapshot Entry graph contains a cycle".to_owned());
        }
        queue.extend(children.get(&inode).into_iter().flatten());
    }
    if visited.len() != entries.len() {
        return Err("snapshot contains unreachable Entries".to_owned());
    }
    Ok(())
}

fn is_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn decode_hex<const N: usize>(value: &str) -> Result<[u8; N], String> {
    if !is_hex(value, N * 2) {
        return Err("hex value is invalid".to_owned());
    }
    let mut output = [0_u8; N];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|error| error.to_string())?;
    }
    Ok(output)
}

fn main() {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    let (allow_other, values) = if arguments
        .first()
        .is_some_and(|value| value == "--allow-other")
    {
        (true, &arguments[1..])
    } else {
        (false, &arguments[..])
    };
    if values.len() != 4 {
        eprintln!(
            "usage: biunivers-pvlogfs [--allow-other] <snapshot-json> <socket> <capability-hex> <mountpoint>"
        );
        std::process::exit(2);
    }
    let snapshot_path = Path::new(&values[0]);
    let socket_path = PathBuf::from(&values[1]);
    let capability_value = values[2].to_string_lossy();
    let capability = decode_hex::<32>(&capability_value).unwrap_or_else(|error| {
        eprintln!("invalid capability: {error}");
        std::process::exit(2);
    });
    if capability == [0; 32] {
        eprintln!("capability must not be all zeroes");
        std::process::exit(2);
    }
    let mountpoint = PathBuf::from(&values[3]);
    let snapshot: Snapshot =
        serde_json::from_reader(File::open(snapshot_path).unwrap_or_else(|error| {
            eprintln!("cannot open snapshot: {error}");
            std::process::exit(1);
        }))
        .unwrap_or_else(|error| {
            eprintln!("cannot parse snapshot: {error}");
            std::process::exit(1);
        });
    let filesystem =
        PvlogFs::from_snapshot(snapshot, socket_path, capability).unwrap_or_else(|error| {
            eprintln!("invalid snapshot: {error}");
            std::process::exit(1);
        });
    let mut config = Config::default();
    config.mount_options.extend([
        MountOption::RO,
        MountOption::FSName("biunivers-pvlogfs".to_owned()),
        MountOption::NoAtime,
        MountOption::DefaultPermissions,
    ]);
    if allow_other {
        config
            .mount_options
            .push(MountOption::CUSTOM("allow_other".to_owned()));
    }
    if let Err(error) = fuser::mount(filesystem, mountpoint, &config) {
        eprintln!("PVLogFS mount failed: {error}");
        std::process::exit(1);
    }
}

unsafe extern "C" {
    #[link_name = "getuid"]
    fn libc_getuid() -> u32;
    #[link_name = "getgid"]
    fn libc_getgid() -> u32;
}

#[cfg(test)]
mod tests {
    use super::{decode_hex, is_hex};

    #[test]
    fn strict_lowercase_hex_decoding() {
        assert!(is_hex("0011aaff", 8));
        assert!(!is_hex("0011AAFF", 8));
        assert_eq!(decode_hex::<4>("0011aaff").unwrap(), [0, 17, 170, 255]);
        assert!(decode_hex::<4>("0011aaf").is_err());
    }
}
