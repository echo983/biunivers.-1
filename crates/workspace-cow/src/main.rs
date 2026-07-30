use serde::Serialize;
use std::env;
use std::ffi::{CStr, CString};
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

const OPAQUE_XATTR: &[u8] = b"user.fuseoverlayfs.opaque";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanEntry {
    path: String,
    kind: EntryKind,
    size: u64,
    mtime_ns: String,
    ctime_ns: String,
    device: String,
    inode: String,
    opaque: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum EntryKind {
    File,
    Directory,
    Whiteout,
}

#[derive(Clone, Debug)]
struct Limits {
    max_entries: usize,
    max_depth: usize,
    max_file_bytes: u64,
    max_total_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    schema_version: u8,
    entries: Vec<ScanEntry>,
    total_file_bytes: u64,
}

#[derive(Debug)]
struct ScanState<'a> {
    limits: &'a Limits,
    entries: Vec<ScanEntry>,
    total_file_bytes: u64,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("WORKSPACE_COW_SCAN_FAILED:{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    if arguments.len() != 5 {
        return Err(
            "usage: biunivers-workspace-cow-scan <upper> <max-entries> <max-depth> <max-file-bytes> <max-total-bytes>"
                .to_owned(),
        );
    }
    let upper = Path::new(&arguments[0]);
    if !upper.is_absolute() || arguments[0].contains("/../") {
        return Err("Upper path must be absolute and normalized".to_owned());
    }
    let limits = Limits {
        max_entries: positive(&arguments[1], "max entries")?,
        max_depth: positive(&arguments[2], "max depth")?,
        max_file_bytes: positive(&arguments[3], "max file bytes")? as u64,
        max_total_bytes: positive(&arguments[4], "max total bytes")? as u64,
    };
    let root = open_root(upper).map_err(|error| format!("open Upper: {error}"))?;
    let root_opaque = validate_xattrs(root.as_raw_fd(), "", true)?;
    let first = scan(root.as_raw_fd(), root_opaque, &limits)?;
    let second = scan(root.as_raw_fd(), root_opaque, &limits)?;
    if first.entries != second.entries || first.total_file_bytes != second.total_file_bytes {
        return Err("Upper changed while it was being scanned".to_owned());
    }
    println!(
        "{}",
        serde_json::to_string(&ScanResult {
            schema_version: 1,
            entries: first.entries,
            total_file_bytes: first.total_file_bytes,
        })
        .map_err(|error| format!("encode scan: {error}"))?
    );
    Ok(())
}

fn scan(root_fd: RawFd, root_opaque: bool, limits: &Limits) -> Result<ScanState<'_>, String> {
    let mut state = ScanState {
        limits,
        entries: Vec::new(),
        total_file_bytes: 0,
    };
    scan_directory(root_fd, "", 0, root_opaque, &mut state)?;
    state
        .entries
        .sort_by(|left, right| left.path.cmp(&right.path));
    Ok(state)
}

fn scan_directory(
    directory_fd: RawFd,
    parent_path: &str,
    depth: usize,
    opaque: bool,
    state: &mut ScanState<'_>,
) -> Result<(), String> {
    if depth > state.limits.max_depth {
        return Err(path_error(parent_path, "depth limit exceeded"));
    }
    let duplicated = unsafe {
        libc::openat(
            directory_fd,
            c".".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if duplicated < 0 {
        return Err(path_io(parent_path, io::Error::last_os_error()));
    }
    let directory = unsafe { libc::fdopendir(duplicated) };
    if directory.is_null() {
        unsafe { libc::close(duplicated) };
        return Err(path_io(parent_path, io::Error::last_os_error()));
    }
    loop {
        unsafe { *libc::__errno_location() = 0 };
        let item = unsafe { libc::readdir(directory) };
        if item.is_null() {
            let error = io::Error::last_os_error();
            unsafe { libc::closedir(directory) };
            return if error.raw_os_error() == Some(0) {
                Ok(())
            } else {
                Err(path_io(parent_path, error))
            };
        }
        let name_bytes = unsafe { CStr::from_ptr((*item).d_name.as_ptr()) }.to_bytes();
        if name_bytes == b"." || name_bytes == b".." {
            continue;
        }
        let name = std::str::from_utf8(name_bytes)
            .map_err(|_| path_error(parent_path, "name is not UTF-8"))?;
        if name.is_empty() || name.contains('/') {
            unsafe { libc::closedir(directory) };
            return Err(path_error(parent_path, "name is invalid"));
        }
        let path = if parent_path.is_empty() {
            name.to_owned()
        } else {
            format!("{parent_path}/{name}")
        };
        if name == ".wh..opq" || name == ".wh..wh..opq" {
            if !opaque {
                unsafe { libc::closedir(directory) };
                return Err(path_error(&path, "reserved overlay marker is invalid"));
            }
            validate_opaque_marker(directory_fd, name_bytes, &path)?;
            continue;
        }
        scan_entry(directory_fd, name_bytes, &path, depth + 1, state)?;
    }
}

fn scan_entry(
    parent_fd: RawFd,
    name: &[u8],
    path: &str,
    depth: usize,
    state: &mut ScanState<'_>,
) -> Result<(), String> {
    if state.entries.len() >= state.limits.max_entries {
        return Err(path_error(path, "entry limit exceeded"));
    }
    if depth > state.limits.max_depth {
        return Err(path_error(path, "depth limit exceeded"));
    }
    let name_c = CString::new(name).map_err(|_| path_error(path, "name contains NUL"))?;
    let mut initial: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe {
        libc::fstatat(
            parent_fd,
            name_c.as_ptr(),
            &mut initial,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(path_io(path, io::Error::last_os_error()));
    }
    let file_type = initial.st_mode & libc::S_IFMT;
    if file_type == libc::S_IFLNK {
        return Err(path_error(path, "symlink is not supported"));
    }
    if file_type == libc::S_IFCHR {
        if initial.st_rdev != 0 {
            return Err(path_error(path, "non-whiteout device is not supported"));
        }
        state.entries.push(ScanEntry {
            path: path.to_owned(),
            kind: EntryKind::Whiteout,
            size: 0,
            mtime_ns: mtime_ns(&initial).to_string(),
            ctime_ns: ctime_ns(&initial).to_string(),
            device: initial.st_dev.to_string(),
            inode: initial.st_ino.to_string(),
            opaque: false,
        });
        return Ok(());
    }
    if file_type != libc::S_IFREG && file_type != libc::S_IFDIR {
        return Err(path_error(path, "special file is not supported"));
    }
    if initial.st_nlink > 1 && file_type == libc::S_IFREG {
        return Err(path_error(path, "hardlink is not supported"));
    }
    let flags = if file_type == libc::S_IFDIR {
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC
    } else {
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC
    };
    let opened = unsafe { libc::openat(parent_fd, name_c.as_ptr(), flags) };
    if opened < 0 {
        return Err(path_io(path, io::Error::last_os_error()));
    }
    let owned = unsafe { OwnedFd::from_raw_fd(opened) };
    let mut confirmed: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(owned.as_raw_fd(), &mut confirmed) } != 0 {
        return Err(path_io(path, io::Error::last_os_error()));
    }
    if fingerprint(&initial) != fingerprint(&confirmed) {
        return Err(path_error(path, "entry changed while opening"));
    }
    let opaque = validate_xattrs(owned.as_raw_fd(), path, file_type == libc::S_IFDIR)?;
    if file_type == libc::S_IFREG {
        let size = u64::try_from(confirmed.st_size)
            .map_err(|_| path_error(path, "file size is invalid"))?;
        if size > state.limits.max_file_bytes {
            return Err(path_error(path, "file size limit exceeded"));
        }
        state.total_file_bytes = state
            .total_file_bytes
            .checked_add(size)
            .ok_or_else(|| path_error(path, "total size overflow"))?;
        if state.total_file_bytes > state.limits.max_total_bytes {
            return Err(path_error(path, "total file size limit exceeded"));
        }
        state.entries.push(ScanEntry {
            path: path.to_owned(),
            kind: EntryKind::File,
            size,
            mtime_ns: mtime_ns(&confirmed).to_string(),
            ctime_ns: ctime_ns(&confirmed).to_string(),
            device: confirmed.st_dev.to_string(),
            inode: confirmed.st_ino.to_string(),
            opaque: false,
        });
    } else {
        state.entries.push(ScanEntry {
            path: path.to_owned(),
            kind: EntryKind::Directory,
            size: 0,
            mtime_ns: mtime_ns(&confirmed).to_string(),
            ctime_ns: ctime_ns(&confirmed).to_string(),
            device: confirmed.st_dev.to_string(),
            inode: confirmed.st_ino.to_string(),
            opaque,
        });
        scan_directory(owned.as_raw_fd(), path, depth, opaque, state)?;
    }
    Ok(())
}

fn validate_opaque_marker(parent_fd: RawFd, name: &[u8], path: &str) -> Result<(), String> {
    let name_c = CString::new(name).map_err(|_| path_error(path, "marker name contains NUL"))?;
    let mut status: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe {
        libc::fstatat(
            parent_fd,
            name_c.as_ptr(),
            &mut status,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(path_io(path, io::Error::last_os_error()));
    }
    let valid = if name == b".wh..opq" {
        status.st_mode & libc::S_IFMT == libc::S_IFCHR && status.st_rdev == 0
    } else {
        status.st_mode & libc::S_IFMT == libc::S_IFREG
            && status.st_size == 0
            && status.st_nlink == 1
    };
    if !valid {
        return Err(path_error(path, "opaque marker representation is invalid"));
    }
    Ok(())
}

fn validate_xattrs(fd: RawFd, path: &str, directory: bool) -> Result<bool, String> {
    let length = unsafe { libc::flistxattr(fd, std::ptr::null_mut(), 0) };
    if length < 0 {
        return Err(path_io(path, io::Error::last_os_error()));
    }
    let mut bytes = vec![0_u8; length as usize];
    if length > 0
        && unsafe { libc::flistxattr(fd, bytes.as_mut_ptr().cast(), bytes.len()) } != length
    {
        return Err(path_io(path, io::Error::last_os_error()));
    }
    let mut opaque = false;
    for name in bytes
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
    {
        if directory && name == OPAQUE_XATTR {
            let value_length = unsafe {
                libc::fgetxattr(
                    fd,
                    name_with_nul(name).as_ptr().cast(),
                    std::ptr::null_mut(),
                    0,
                )
            };
            if value_length != 1 {
                return Err(path_error(path, "opaque xattr value is invalid"));
            }
            let mut value = [0_u8; 1];
            if unsafe {
                libc::fgetxattr(
                    fd,
                    name_with_nul(name).as_ptr().cast(),
                    value.as_mut_ptr().cast(),
                    1,
                )
            } != 1
                || value[0] != b'y'
            {
                return Err(path_error(path, "opaque xattr value is invalid"));
            }
            opaque = true;
        } else {
            return Err(path_error(
                path,
                &format!("unsupported xattr {}", String::from_utf8_lossy(name)),
            ));
        }
    }
    Ok(opaque)
}

fn name_with_nul(name: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(name.len() + 1);
    result.extend_from_slice(name);
    result.push(0);
    result
}

fn open_root(path: &Path) -> io::Result<File> {
    let path_c = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
    let fd = unsafe {
        libc::open(
            path_c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}

fn fingerprint(value: &libc::stat) -> (u64, u64, u32, i64, i128, i128) {
    (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_size,
        mtime_ns(value),
        i128::from(value.st_ctime) * 1_000_000_000 + i128::from(value.st_ctime_nsec),
    )
}

fn mtime_ns(value: &libc::stat) -> i128 {
    i128::from(value.st_mtime) * 1_000_000_000 + i128::from(value.st_mtime_nsec)
}

fn ctime_ns(value: &libc::stat) -> i128 {
    i128::from(value.st_ctime) * 1_000_000_000 + i128::from(value.st_ctime_nsec)
}

fn positive(value: &str, label: &str) -> Result<usize, String> {
    value
        .parse::<usize>()
        .ok()
        .filter(|parsed| *parsed > 0)
        .ok_or_else(|| format!("{label} is invalid"))
}

fn path_error(path: &str, message: &str) -> String {
    format!("{}: {message}", if path.is_empty() { "/" } else { path })
}

fn path_io(path: &str, error: io::Error) -> String {
    path_error(path, &error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir, hard_link, remove_dir_all, write};
    use std::os::unix::fs::symlink;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture() -> (std::path::PathBuf, File, Limits) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "biunivers-workspace-cow-{}-{nonce}",
            std::process::id()
        ));
        create_dir(&root).unwrap();
        let file = open_root(&root).unwrap();
        (
            root,
            file,
            Limits {
                max_entries: 100,
                max_depth: 10,
                max_file_bytes: 1024,
                max_total_bytes: 4096,
            },
        )
    }

    #[test]
    fn scans_files_directories_and_opaque_xattr() {
        let (root, file, limits) = fixture();
        create_dir(root.join("docs")).unwrap();
        write(root.join("docs/readme.txt"), b"hello").unwrap();
        let docs = File::open(root.join("docs")).unwrap();
        let name = CString::new(OPAQUE_XATTR).unwrap();
        assert_eq!(
            unsafe { libc::fsetxattr(docs.as_raw_fd(), name.as_ptr(), b"y".as_ptr().cast(), 1, 0) },
            0
        );

        let result = scan(file.as_raw_fd(), false, &limits).unwrap();
        assert_eq!(result.total_file_bytes, 5);
        assert_eq!(result.entries.len(), 2);
        assert_eq!(result.entries[0].path, "docs");
        assert!(result.entries[0].opaque);
        assert_eq!(result.entries[1].path, "docs/readme.txt");
        remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_symlinks_hardlinks_and_unknown_xattrs() {
        let (root, file, limits) = fixture();
        write(root.join("source"), b"x").unwrap();
        symlink("source", root.join("link")).unwrap();
        assert!(
            scan(file.as_raw_fd(), false, &limits)
                .unwrap_err()
                .contains("symlink")
        );
        std::fs::remove_file(root.join("link")).unwrap();

        hard_link(root.join("source"), root.join("hard")).unwrap();
        assert!(
            scan(file.as_raw_fd(), false, &limits)
                .unwrap_err()
                .contains("hardlink")
        );
        std::fs::remove_file(root.join("hard")).unwrap();

        let source = File::open(root.join("source")).unwrap();
        let name = CString::new("user.unexpected").unwrap();
        assert_eq!(
            unsafe {
                libc::fsetxattr(
                    source.as_raw_fd(),
                    name.as_ptr(),
                    b"x".as_ptr().cast(),
                    1,
                    0,
                )
            },
            0
        );
        assert!(
            scan(file.as_raw_fd(), false, &limits)
                .unwrap_err()
                .contains("unsupported xattr")
        );
        remove_dir_all(root).unwrap();
    }
}
