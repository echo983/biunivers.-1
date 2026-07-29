import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  createResourceLaunch,
  createDirectory,
  moveEntry,
  removeEntry,
  resolveResourceHandlers,
  type ResourceHandlerCandidate,
  type ResourceHandlerResolution,
} from "../../api/internalFileManagerClient";
import {
  downloadFile,
  uploadLocalFile,
} from "../../api/fileManagerTransfers";
import {
  FileHostClientError,
  listFiles,
  type DirectoryListing,
  type FileEntry,
} from "../../hostApi/fileHostClient";
import {
  resourceHandlerKey,
  selectResourceHandler,
} from "../../openResource/defaultResourceHandlers";
import { useDesktopStore } from "../../store/desktopStore";
import { openApp } from "../../windows/windowController";

interface FileManagerBrowserProps {
  instanceToken: string;
}

interface Breadcrumb {
  entryId: string;
  name: string;
}

type EditDialog =
  | { mode: "create" }
  | { mode: "rename"; entry: FileEntry }
  | null;

interface OpenWithState {
  entry: FileEntry;
  resolution: ResourceHandlerResolution;
}

export function FileManagerBrowser({
  instanceToken,
}: FileManagerBrowserProps) {
  const [directoryId, setDirectoryId] = useState<string>();
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [listing, setListing] = useState<DirectoryListing>();
  const [selected, setSelected] = useState<FileEntry>();
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [editDialog, setEditDialog] = useState<EditDialog>(null);
  const [movingEntry, setMovingEntry] = useState<FileEntry>();
  const [notice, setNotice] = useState<string>();
  const [openWith, setOpenWith] = useState<OpenWithState>();
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const appRegistry = useDesktopStore((state) => state.apps);
  const defaultResourceHandlers = useDesktopStore(
    (state) => state.defaultResourceHandlers,
  );
  const setDefaultResourceHandler = useDesktopStore(
    (state) => state.setDefaultResourceHandler,
  );

  const refresh = useCallback(() => {
    setLoading(true);
    setRefreshKey((value) => value + 1);
  }, []);

  useEffect(() => {
    let active = true;
    void listFiles(instanceToken, directoryId)
      .then((value) => {
        if (!active) return;
        setListing(value);
        setSelected(undefined);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(messageOf(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [directoryId, instanceToken, refreshKey]);

  const runMutation = async (operation: () => Promise<unknown>) => {
    setWorking(true);
    setError(undefined);
    try {
      await operation();
      setEditDialog(null);
      setMovingEntry(undefined);
      refresh();
    } catch (reason) {
      if (
        reason instanceof FileHostClientError &&
        reason.code === "FILE_VERSION_CONFLICT"
      ) {
        setError("文件系统已发生变化，目录已刷新，请重新操作。");
        refresh();
      } else {
        setError(messageOf(reason));
      }
    } finally {
      setWorking(false);
    }
  };

  const uploadFiles = async (files: FileList) => {
    if (!listing) return;
    setWorking(true);
    setError(undefined);
    setNotice(undefined);
    try {
      for (const file of Array.from(files)) {
        setNotice(`正在上传“${file.name}”…`);
        await uploadLocalFile(
          instanceToken,
          listing.parent.entryId,
          file,
        );
      }
      setNotice(`已上传 ${files.length} 个文件。`);
      refresh();
    } catch (reason) {
      setNotice(undefined);
      setError(messageOf(reason));
      refresh();
    } finally {
      setWorking(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  };

  const downloadSelected = async () => {
    if (!selected || selected.kind !== "file") return;
    setWorking(true);
    setError(undefined);
    setNotice(`正在下载“${selected.name}”…`);
    try {
      await downloadFile(instanceToken, selected);
      setNotice(`已开始下载“${selected.name}”。`);
    } catch (reason) {
      setNotice(undefined);
      setError(messageOf(reason));
    } finally {
      setWorking(false);
    }
  };

  const enterDirectory = (entry: FileEntry) => {
    if (entry.kind !== "directory") return;
    setError(undefined);
    setLoading(true);
    setBreadcrumbs((current) => [
      ...current,
      { entryId: entry.entryId, name: entry.name },
    ]);
    setDirectoryId(entry.entryId);
  };

  const launchWith = async (
    state: OpenWithState,
    candidate: ResourceHandlerCandidate,
    remember: boolean,
  ) => {
    setWorking(true);
    setError(undefined);
    setNotice(`正在用“${candidate.appName}”打开“${state.entry.name}”…`);
    try {
      if (!appRegistry[candidate.appId]) {
        throw new Error("目标应用尚未加载，请刷新桌面后重试。");
      }
      const launch = await createResourceLaunch(instanceToken, {
        entryId: state.entry.entryId,
        expectedRevision: state.resolution.revision,
        targetAppId: candidate.appId,
        handlerId: candidate.handler.id,
        action: state.resolution.effectiveAction,
      });
      openApp(candidate.appId, { launchId: launch.launchId });
      if (remember && state.resolution.extension) {
        setDefaultResourceHandler(
          resourceHandlerKey(
            state.resolution.extension,
            state.resolution.effectiveAction,
          ),
          {
            appId: candidate.appId,
            handlerId: candidate.handler.id,
          },
        );
      }
      setOpenWith(undefined);
      setNotice(
        state.resolution.effectiveAction === "open" &&
          state.resolution.requestedAction === "edit"
          ? `已用“${candidate.appName}”以只读方式打开。`
          : `已用“${candidate.appName}”打开。`,
      );
    } catch (reason) {
      setNotice(undefined);
      if (
        reason instanceof FileHostClientError &&
        reason.code === "RESOURCE_OPEN_BUSY"
      ) {
        setError("目标应用仍有一个未处理的打开请求，请稍后重试。");
      } else if (
        reason instanceof FileHostClientError &&
        reason.code === "FILE_VERSION_CONFLICT"
      ) {
        setError("文件系统已发生变化，目录已刷新，请重新操作。");
        setOpenWith(undefined);
        refresh();
      } else {
        setError(messageOf(reason));
      }
    } finally {
      setWorking(false);
    }
  };

  const openFile = async (entry: FileEntry, forceChooser = false) => {
    if (entry.kind !== "file" || !listing || working) return;
    setWorking(true);
    setError(undefined);
    setNotice(`正在查找“${entry.name}”的打开方式…`);
    try {
      const resolution = await resolveResourceHandlers(
        instanceToken,
        entry.entryId,
        listing.revision,
        "edit",
      );
      const state = { entry, resolution };
      if (resolution.candidates.length === 0) {
        setNotice(undefined);
        setError(`没有能够打开“${entry.name}”的应用。`);
        return;
      }
      const selectedHandler = forceChooser
        ? undefined
        : selectResourceHandler(
            resolution.candidates,
            defaultResourceHandlers,
            resolution.extension ?? "",
            resolution.effectiveAction,
          );
      if (selectedHandler) {
        setWorking(false);
        await launchWith(state, selectedHandler, false);
        return;
      }
      setNotice(undefined);
      setOpenWith(state);
    } catch (reason) {
      setNotice(undefined);
      if (
        reason instanceof FileHostClientError &&
        reason.code === "FILE_VERSION_CONFLICT"
      ) {
        setError("文件系统已发生变化，目录已刷新，请重新操作。");
        refresh();
      } else {
        setError(messageOf(reason));
      }
    } finally {
      setWorking(false);
    }
  };

  const activateEntry = (entry: FileEntry) => {
    if (entry.kind === "directory") {
      enterDirectory(entry);
    } else {
      void openFile(entry);
    }
  };

  const navigateTo = (index: number) => {
    setError(undefined);
    setLoading(true);
    if (index < 0) {
      setBreadcrumbs([]);
      setDirectoryId(undefined);
      return;
    }
    const next = breadcrumbs.slice(0, index + 1);
    setBreadcrumbs(next);
    setDirectoryId(next.at(-1)?.entryId);
  };

  return (
    <article className="file-manager-app">
      <header className="file-manager-app__toolbar">
        <nav aria-label="当前位置" className="file-manager-app__breadcrumbs">
          <button type="button" onClick={() => navigateTo(-1)}>
            文件
          </button>
          {breadcrumbs.map((breadcrumb, index) => (
            <span key={breadcrumb.entryId}>
              <span aria-hidden="true">/</span>
              <button type="button" onClick={() => navigateTo(index)}>
                {breadcrumb.name}
              </button>
            </span>
          ))}
        </nav>
        <div className="file-manager-app__actions">
          <button
            type="button"
            disabled={!listing || working}
            onClick={() => setEditDialog({ mode: "create" })}
          >
            新建文件夹
          </button>
          <button
            type="button"
            disabled={!selected || working}
            onClick={() =>
              selected &&
              setEditDialog({ mode: "rename", entry: selected })
            }
          >
            重命名
          </button>
          <button
            type="button"
            disabled={!selected || working}
            onClick={() => setMovingEntry(selected)}
          >
            移动
          </button>
          <button
            type="button"
            disabled={!selected || working}
            onClick={() => {
              if (
                selected &&
                listing &&
                window.confirm(
                  selected.kind === "directory"
                    ? `从当前文件树移除文件夹“${selected.name}”及其内容？`
                    : `从当前文件树移除文件“${selected.name}”？`,
                )
              ) {
                void runMutation(() =>
                  removeEntry(
                    instanceToken,
                    selected.entryId,
                    selected.kind === "directory",
                    listing.revision,
                  ),
                );
              }
            }}
          >
            移除
          </button>
          <button
            type="button"
            disabled={!listing || working}
            onClick={() => uploadInputRef.current?.click()}
          >
            上传
          </button>
          <input
            ref={uploadInputRef}
            className="sr-only"
            type="file"
            multiple
            aria-label="选择要上传的文件"
            onChange={(event) => {
              if (event.target.files?.length) {
                void uploadFiles(event.target.files);
              }
            }}
          />
          <button
            type="button"
            disabled={!selected || selected.kind !== "file" || working}
            onClick={() => void downloadSelected()}
          >
            下载
          </button>
          <button
            type="button"
            disabled={!selected || selected.kind !== "file" || working}
            onClick={() => selected && void openFile(selected, true)}
          >
            打开方式
          </button>
          <button
            type="button"
            disabled={loading || working}
            onClick={() => {
              setError(undefined);
              refresh();
            }}
          >
            刷新
          </button>
        </div>
      </header>

      {error && (
        <div className="file-manager-app__error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="file-manager-app__notice" role="status">
          {notice}
        </div>
      )}

      <div className="file-manager-app__content">
        {loading ? (
          <p className="file-manager-app__empty">正在读取目录…</p>
        ) : listing && listing.entries.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th scope="col">名称</th>
                <th scope="col">大小</th>
                <th scope="col">修改时间</th>
              </tr>
            </thead>
            <tbody>
              {listing.entries.map((entry) => (
                <tr
                  key={entry.entryId}
                  className={
                    selected?.entryId === entry.entryId
                      ? "is-selected"
                      : undefined
                  }
                  tabIndex={0}
                  aria-selected={selected?.entryId === entry.entryId}
                  onClick={() => setSelected(entry)}
                  onDoubleClick={() => activateEntry(entry)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") activateEntry(entry);
                  }}
                >
                  <td>
                    <span aria-hidden="true">
                      {entry.kind === "directory" ? "📁" : "📄"}
                    </span>{" "}
                    {entry.name}
                  </td>
                  <td>
                    {entry.kind === "directory"
                      ? "—"
                      : formatSize(entry.size ?? 0)}
                  </td>
                  <td>{formatDate(entry.mtimeMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="file-manager-app__empty">此文件夹为空。</p>
        )}
      </div>

      {listing && editDialog && (
        <NameDialog
          mode={editDialog.mode}
          initialName={
            editDialog.mode === "rename" ? editDialog.entry.name : ""
          }
          working={working}
          onCancel={() => setEditDialog(null)}
          onSubmit={(name) =>
            void runMutation(() =>
              editDialog.mode === "create"
                ? createDirectory(
                    instanceToken,
                    listing.parent.entryId,
                    name,
                    listing.revision,
                  )
                : moveEntry(
                    instanceToken,
                    editDialog.entry.entryId,
                    listing.parent.entryId,
                    name,
                    listing.revision,
                  ),
            )
          }
        />
      )}

      {listing && movingEntry && (
        <MoveDialog
          instanceToken={instanceToken}
          entry={movingEntry}
          originalParentEntryId={listing.parent.entryId}
          expectedRevision={listing.revision}
          working={working}
          onCancel={() => setMovingEntry(undefined)}
          onMove={(parentEntryId) =>
            void runMutation(() =>
              moveEntry(
                instanceToken,
                movingEntry.entryId,
                parentEntryId,
                movingEntry.name,
                listing.revision,
              ),
            )
          }
        />
      )}

      {openWith && (
        <OpenWithDialog
          state={openWith}
          working={working}
          onCancel={() => setOpenWith(undefined)}
          onOpen={(candidate, remember) =>
            void launchWith(openWith, candidate, remember)
          }
        />
      )}
    </article>
  );
}

function OpenWithDialog({
  state,
  working,
  onCancel,
  onOpen,
}: {
  state: OpenWithState;
  working: boolean;
  onCancel: () => void;
  onOpen: (candidate: ResourceHandlerCandidate, remember: boolean) => void;
}) {
  const [selectedKey, setSelectedKey] = useState(
    `${state.resolution.candidates[0].appId}:${state.resolution.candidates[0].handler.id}`,
  );
  const [remember, setRemember] = useState(false);
  const selected = state.resolution.candidates.find(
    (candidate) =>
      `${candidate.appId}:${candidate.handler.id}` === selectedKey,
  );
  return (
    <div
      className="file-manager-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="file-manager-open-with-title"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (selected) onOpen(selected, remember);
        }}
      >
        <h2 id="file-manager-open-with-title">
          打开“{state.entry.name}”
        </h2>
        {state.resolution.effectiveAction === "open" &&
          state.resolution.requestedAction === "edit" && (
            <p>没有可编辑此文件的应用，以下应用将以只读方式打开。</p>
          )}
        <fieldset className="file-manager-dialog__handlers">
          <legend>选择应用</legend>
          {state.resolution.candidates.map((candidate) => {
            const key = `${candidate.appId}:${candidate.handler.id}`;
            return (
              <label key={key}>
                <input
                  type="radio"
                  name="resource-handler"
                  value={key}
                  checked={selectedKey === key}
                  onChange={() => setSelectedKey(key)}
                />
                <span>
                  <strong>{candidate.appName}</strong>
                  {" · "}
                  {candidate.handler.access === "read-write"
                    ? "最大读写"
                    : "只读"}
                </span>
              </label>
            );
          })}
        </fieldset>
        {state.resolution.extension && (
          <label>
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            始终使用所选应用
            {state.resolution.effectiveAction === "edit" ? "编辑" : "打开"}
            {" "}
            {state.resolution.extension} 文件
          </label>
        )}
        <div>
          <button type="button" disabled={working} onClick={onCancel}>
            取消
          </button>
          <button type="submit" disabled={working || !selected}>
            打开
          </button>
        </div>
      </form>
    </div>
  );
}

function NameDialog({
  mode,
  initialName,
  working,
  onCancel,
  onSubmit,
}: {
  mode: "create" | "rename";
  initialName: string;
  working: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) onSubmit(name.trim());
  };
  return (
    <div
      className="file-manager-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="file-manager-name-dialog-title"
    >
      <form onSubmit={submit}>
        <h2 id="file-manager-name-dialog-title">
          {mode === "create" ? "新建文件夹" : "重命名"}
        </h2>
        <label>
          名称
          <input
            autoFocus
            value={name}
            maxLength={255}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div>
          <button type="button" disabled={working} onClick={onCancel}>
            取消
          </button>
          <button type="submit" disabled={working || !name.trim()}>
            确定
          </button>
        </div>
      </form>
    </div>
  );
}

function MoveDialog({
  instanceToken,
  entry,
  originalParentEntryId,
  expectedRevision,
  working,
  onCancel,
  onMove,
}: {
  instanceToken: string;
  entry: FileEntry;
  originalParentEntryId: string;
  expectedRevision: number;
  working: boolean;
  onCancel: () => void;
  onMove: (parentEntryId: string) => void;
}) {
  const [directoryId, setDirectoryId] = useState<string>();
  const [stack, setStack] = useState<Breadcrumb[]>([]);
  const [listing, setListing] = useState<DirectoryListing>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void listFiles(instanceToken, directoryId)
      .then((value) => {
        if (active) {
          setListing(value);
          setError(undefined);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(messageOf(reason));
      });
    return () => {
      active = false;
    };
  }, [directoryId, instanceToken]);

  const navigate = (index: number) => {
    if (index < 0) {
      setStack([]);
      setDirectoryId(undefined);
      return;
    }
    const next = stack.slice(0, index + 1);
    setStack(next);
    setDirectoryId(next.at(-1)?.entryId);
  };

  return (
    <div
      className="file-manager-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="file-manager-move-dialog-title"
    >
      <section>
        <h2 id="file-manager-move-dialog-title">移动“{entry.name}”</h2>
        <nav aria-label="目标文件夹">
          <button type="button" onClick={() => navigate(-1)}>
            文件
          </button>
          {stack.map((item, index) => (
            <span key={item.entryId}>
              {" / "}
              <button type="button" onClick={() => navigate(index)}>
                {item.name}
              </button>
            </span>
          ))}
        </nav>
        {error && <p role="alert">{error}</p>}
        <ul className="file-manager-dialog__directories">
          {listing?.entries
            .filter((item) => item.kind === "directory")
            .map((item) => (
              <li key={item.entryId}>
                <button
                  type="button"
                  onClick={() => {
                    setStack((current) => [
                      ...current,
                      { entryId: item.entryId, name: item.name },
                    ]);
                    setDirectoryId(item.entryId);
                  }}
                >
                  📁 {item.name}
                </button>
              </li>
            ))}
        </ul>
        <p>目标 revision：{expectedRevision}</p>
        <div>
          <button type="button" disabled={working} onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            disabled={
              working ||
              !listing ||
              listing.parent.entryId === originalParentEntryId
            }
            onClick={() => listing && onMove(listing.parent.entryId)}
          >
            移动到这里
          </button>
        </div>
      </section>
    </div>
  );
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : "文件操作失败";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}
