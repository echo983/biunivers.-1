import { useEffect, useState } from "react";
import {
  FileHostClientError,
  listFiles,
  type DirectoryListing,
  type FileEntry,
} from "./fileHostClient";
import { EntryIdenticon } from "../components/EntryIdenticon";
import {
  updateFileSelection,
  type FileSelection,
} from "../apps/internal/fileSelection";

interface CommonPickerProps {
  instanceToken: string;
  writable: boolean;
}

type HostFilePickerProps =
  | (CommonPickerProps & {
      multiple?: false;
      onSelect(entryId: string | null): void;
    })
  | (CommonPickerProps & {
      multiple: true;
      maximum: number;
      onSelect(entryIds: string[] | null): void;
    });

const EMPTY_SELECTION: FileSelection = { entryIds: new Set() };

export function HostFilePicker(props: HostFilePickerProps) {
  const { instanceToken, writable, multiple } = props;
  const maximum = multiple ? props.maximum : 1;
  const [directoryStack, setDirectoryStack] = useState<string[]>([]);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [multiSelection, setMultiSelection] =
    useState<FileSelection>(EMPTY_SELECTION);
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
      setMultiSelection(EMPTY_SELECTION);
      setError(null);
      setDirectoryStack((current) => [...current, entry.entryId]);
      return;
    }
    if (multiple) {
      const selectedIds = listing?.entries
        .filter(
          (candidate) =>
            candidate.kind === "file" &&
            multiSelection.entryIds.has(candidate.entryId),
        )
        .map((candidate) => candidate.entryId);
      if (selectedIds && selectedIds.length >= 2) {
        props.onSelect(selectedIds);
      }
      return;
    }
    props.onSelect(entry.entryId);
  };

  const cancel = () => {
    if (multiple) props.onSelect(null);
    else props.onSelect(null);
  };

  return (
    <div className="host-file-picker" role="dialog" aria-modal="true">
      <div className="host-file-picker__panel">
        <header>
          <div>
            <strong>
              {multiple
                ? "打开多个文件"
                : writable
                  ? "打开并允许保存"
                  : "打开文件"}
            </strong>
            <span>{listing?.parent.name || "/"}</span>
          </div>
          <button type="button" onClick={cancel}>
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
              setMultiSelection(EMPTY_SELECTION);
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
                (multiple
                  ? multiSelection.entryIds.has(entry.entryId)
                  : selected?.entryId === entry.entryId)
                  ? "is-selected"
                  : ""
              }
              onMouseDown={(event) => {
                if (event.shiftKey) event.preventDefault();
              }}
              onClick={(event) => {
                if (!multiple || entry.kind === "directory") {
                  setSelected(entry);
                  return;
                }
                setMultiSelection((current) => {
                  const next = updateFileSelection(
                    listing.entries
                      .filter((candidate) => candidate.kind === "file")
                      .map((candidate) => candidate.entryId),
                    current,
                    entry.entryId,
                    {
                      toggle: event.ctrlKey || event.metaKey,
                      range: event.shiftKey,
                    },
                  );
                  if (
                    next.entryIds.size > maximum &&
                    !current.entryIds.has(entry.entryId)
                  ) {
                    setError(`最多选择 ${maximum} 个文件`);
                    return current;
                  }
                  setError(null);
                  return next;
                });
              }}
              onDoubleClick={() => activate(entry)}
            >
              <span>
                {entry.kind === "directory" ? (
                  "📁"
                ) : (
                  <EntryIdenticon entryId={entry.entryId} size={24} />
                )}
              </span>
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
            disabled={
              multiple ? multiSelection.entryIds.size < 2 : !selected
            }
            onClick={() => {
              if (multiple) {
                const firstSelected = listing?.entries.find(
                  (entry) =>
                    entry.kind === "file" &&
                    multiSelection.entryIds.has(entry.entryId),
                );
                if (firstSelected) activate(firstSelected);
              } else if (selected) {
                activate(selected);
              }
            }}
          >
            {multiple
              ? `打开 ${multiSelection.entryIds.size} 个文件`
              : selected?.kind === "directory"
                ? "进入"
                : "打开"}
          </button>
        </footer>
      </div>
    </div>
  );
}
