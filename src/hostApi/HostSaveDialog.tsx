import { useEffect, useState } from "react";
import {
  FileHostClientError,
  listFiles,
  type DirectoryListing,
  type FileEntry,
} from "./fileHostClient";

interface HostSaveDialogProps {
  instanceToken: string;
  suggestedName: string;
  onFinish(target: { parentEntryId: string; name: string } | null): void;
}

export function HostSaveDialog({
  instanceToken,
  suggestedName,
  onFinish,
}: HostSaveDialogProps) {
  const [directoryStack, setDirectoryStack] = useState<string[]>([]);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [name, setName] = useState(suggestedName);
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

  const navigate = (entry: FileEntry) => {
    if (entry.kind !== "directory") {
      return;
    }
    setListing(null);
    setError(null);
    setDirectoryStack((current) => [...current, entry.entryId]);
  };

  const save = () => {
    const normalized = name.normalize("NFC");
    if (!listing || !normalized) {
      setError("请输入文件名");
      return;
    }
    if (listing.entries.some((entry) => entry.name === normalized)) {
      setError("同名文件已经存在");
      return;
    }
    onFinish({
      parentEntryId: listing.parent.entryId,
      name: normalized,
    });
  };

  return (
    <div className="host-file-picker" role="dialog" aria-modal="true">
      <div className="host-file-picker__panel">
        <header>
          <div>
            <strong>另存为</strong>
            <span>{listing?.parent.name || "/"}</span>
          </div>
          <button type="button" onClick={() => onFinish(null)}>
            取消
          </button>
        </header>
        <div className="host-file-picker__toolbar">
          <button
            type="button"
            disabled={directoryStack.length === 0}
            onClick={() => {
              setListing(null);
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
          {listing?.entries
            .filter((entry) => entry.kind === "directory")
            .map((entry) => (
              <button
                type="button"
                key={entry.entryId}
                onDoubleClick={() => navigate(entry)}
                onClick={() => navigate(entry)}
              >
                <span>📁</span>
                <span>{entry.name}</span>
                <small />
              </button>
            ))}
        </div>
        <footer className="host-save-dialog__footer">
          <input
            aria-label="文件名"
            value={name}
            maxLength={255}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                save();
              }
            }}
          />
          <button type="button" disabled={!listing} onClick={save}>
            保存
          </button>
        </footer>
      </div>
    </div>
  );
}
