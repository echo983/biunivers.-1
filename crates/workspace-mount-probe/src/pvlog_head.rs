use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs::File;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use base64::Engine;
use fuser::{
    Config, Errno, FileAttr, FileHandle, FileType, Filesystem, Generation, INodeNo, LockOwner,
    MountOption, OpenFlags, ReplyAttr, ReplyData, ReplyDirectory, ReplyEntry, Request,
};
use serde::Deserialize;
use serde_json::json;

const TTL: Duration = Duration::from_secs(1);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    revision: u64,
    head_fid_hex: String,
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

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum EntryKind {
    Directory,
    File,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeResponse {
    ok: bool,
    data_base64: Option<String>,
    error: Option<String>,
}

struct PvlogFs {
    socket_path: PathBuf,
    root_inode: u64,
    entries: HashMap<u64, SnapshotEntry>,
    lookup: HashMap<(u64, String), u64>,
    children: HashMap<u64, Vec<u64>>,
}

impl PvlogFs {
    fn from_snapshot(snapshot: Snapshot, socket_path: PathBuf) -> Result<Self, String> {
        if snapshot.entries.is_empty() || snapshot.root_inode == 0 {
            return Err("snapshot is empty".to_owned());
        }
        let mut entries = HashMap::new();
        let mut lookup = HashMap::new();
        let mut children: HashMap<u64, Vec<u64>> = HashMap::new();
        for entry in snapshot.entries {
            if entry.inode == 0 || entries.insert(entry.inode, entry.clone()).is_some() {
                return Err("snapshot contains an invalid or duplicate inode".to_owned());
            }
            if let Some(parent) = entry.parent_inode {
                if lookup
                    .insert((parent, entry.name.clone()), entry.inode)
                    .is_some()
                {
                    return Err("snapshot contains duplicate sibling names".to_owned());
                }
                children.entry(parent).or_default().push(entry.inode);
            }
        }
        let root = entries
            .get(&snapshot.root_inode)
            .ok_or_else(|| "snapshot root inode is missing".to_owned())?;
        if root.parent_inode.is_some() || root.kind != EntryKind::Directory {
            return Err("snapshot root is invalid".to_owned());
        }
        for entry in entries.values() {
            if let Some(parent) = entry.parent_inode {
                if entries.get(&parent).map(|value| value.kind) != Some(EntryKind::Directory) {
                    return Err("snapshot entry has an invalid parent".to_owned());
                }
            }
        }
        for values in children.values_mut() {
            values.sort_by(|left, right| entries[left].name.cmp(&entries[right].name));
        }
        eprintln!(
            "fixed PVLog HEAD {} revision {} with {} entries",
            snapshot.head_fid_hex,
            snapshot.revision,
            entries.len()
        );
        Ok(Self {
            socket_path,
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
        let mtime = UNIX_EPOCH + Duration::from_millis(entry.mtime_ms);
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

    fn read_from_bridge(
        &self,
        entry: &SnapshotEntry,
        offset: u64,
        size: u32,
    ) -> Result<Vec<u8>, String> {
        let mut stream =
            UnixStream::connect(&self.socket_path).map_err(|error| error.to_string())?;
        let request = json!({
            "op": "read",
            "entryIdHex": entry.entry_id_hex,
            "offset": offset,
            "size": size,
        });
        stream
            .write_all(request.to_string().as_bytes())
            .and_then(|_| stream.shutdown(std::net::Shutdown::Write))
            .map_err(|error| error.to_string())?;
        let mut response_bytes = Vec::new();
        stream
            .read_to_end(&mut response_bytes)
            .map_err(|error| error.to_string())?;
        let response: BridgeResponse =
            serde_json::from_slice(&response_bytes).map_err(|error| error.to_string())?;
        if !response.ok {
            return Err(response
                .error
                .unwrap_or_else(|| "bridge read failed".to_owned()));
        }
        base64::engine::general_purpose::STANDARD
            .decode(response.data_base64.unwrap_or_default())
            .map_err(|error| error.to_string())
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
            Some(attr) => reply.attr(&TTL, &attr),
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
        match self.read_from_bridge(entry, offset, size.min(1024 * 1024)) {
            Ok(bytes) => reply.data(&bytes),
            Err(error) => {
                eprintln!("PVLog bridge read failed: {error}");
                reply.error(Errno::EIO);
            }
        }
    }
}

fn main() {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if arguments.len() != 3 {
        eprintln!("usage: pvlog-head-mount-probe <snapshot-json> <socket> <mountpoint>");
        std::process::exit(2);
    }
    let snapshot_path = Path::new(&arguments[0]);
    let socket_path = PathBuf::from(&arguments[1]);
    let mountpoint = PathBuf::from(&arguments[2]);
    let snapshot: Snapshot =
        serde_json::from_reader(File::open(snapshot_path).unwrap_or_else(|error| {
            eprintln!("cannot open snapshot: {error}");
            std::process::exit(1);
        }))
        .unwrap_or_else(|error| {
            eprintln!("cannot parse snapshot: {error}");
            std::process::exit(1);
        });
    let filesystem = PvlogFs::from_snapshot(snapshot, socket_path).unwrap_or_else(|error| {
        eprintln!("invalid snapshot: {error}");
        std::process::exit(1);
    });
    let mut config = Config::default();
    config.mount_options.extend([
        MountOption::RO,
        MountOption::FSName("biunivers-pvlog-head-probe".to_owned()),
        MountOption::NoAtime,
    ]);
    if let Err(error) = fuser::mount(filesystem, mountpoint, &config) {
        eprintln!("PVLog HEAD mount failed: {error}");
        std::process::exit(1);
    }
}

unsafe extern "C" {
    #[link_name = "getuid"]
    fn libc_getuid() -> u32;
    #[link_name = "getgid"]
    fn libc_getgid() -> u32;
}
