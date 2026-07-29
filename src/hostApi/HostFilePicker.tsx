import { useEffect, useState } from "react";
import {
  FileHostClientError,
  listFiles,
  type DirectoryListing,
  type FileEntry,
} from "./fileHostClient";

interface HostFilePickerProps {
  instanceToken: string;
  writable: boolean;
  onSelect(entryId: string | null): void;
}

export function HostFilePicker({
  instanceToken,
  writable,
  onSelect,
}: HostFilePickerProps) {
  const [directoryStack, setDirectoryStack] = useState<string[]>([]);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const parentEntryId = directoryStack.at(-1);

  useEffect(() => {
    let active = true;
    void listFiles(instanceToken, parentEntryId)
      .then((value) => {
        if (active) {
          setListing(value);
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(
            caught instanceof FileHostClientError
              ? caught.message
              : "无法读取文件目录",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [instanceToken, parentEntryId]);

  const activate = (entry: FileEntry) => {
    if (entry.kind === "directory") {
      setListing(null);
      setSelected(null);
      setError(null);
      setDirectoryStack((current) => [...current, entry.entryId]);
      return;
    }
    onSelect(entry.entryId);
  };

  return (
    <div className="host-file-picker" role="dialog" aria-modal="true">
      <div className="host-file-picker__panel">
        <header>
          <div>
            <strong>{writable ? "打开并允许保存" : "打开文件"}</strong>
            <span>{listing?.parent.name || "/"}</span>
          </div>
          <button type="button" onClick={() => onSelect(null)}>
            取消
          </button>
        </header>
        <div className="host-file-picker__toolbar">
          <button
            type="button"
            disabled={directoryStack.length === 0}
            onClick={() => {
              setListing(null);
              setSelected(null);
              setError(null);
              setDirectoryStack((current) => current.slice(0, -1));
            }}
          >
            返回上级
          </button>
        </div>
        <div className="host-file-picker__entries">
          {error ? <p role="alert">{error}</p> : null}
          {!listing && !error ? <p>正在读取…</p> : null}
          {listing?.entries.length === 0 ? <p>此目录为空</p> : null}
          {listing?.entries.map((entry) => (
            <button
              type="button"
              key={entry.entryId}
              className={
                selected?.entryId === entry.entryId ? "is-selected" : ""
              }
              onClick={() => setSelected(entry)}
              onDoubleClick={() => activate(entry)}
            >
              <span>{entry.kind === "directory" ? "📁" : "📄"}</span>
              <span>{entry.name}</span>
              <small>
                {entry.kind === "file" && entry.size !== undefined
                  ? `${entry.size} B`
                  : ""}
              </small>
            </button>
          ))}
        </div>
        <footer>
          <button
            type="button"
            disabled={!selected}
            onClick={() => selected && activate(selected)}
          >
            {selected?.kind === "directory" ? "进入" : "打开"}
          </button>
        </footer>
      </div>
    </div>
  );
}
