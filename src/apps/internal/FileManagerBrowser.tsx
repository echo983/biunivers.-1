import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  copyFile,
  createFile,
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
import { useDesktopSurfaceStore } from "../../desktopSurface/store";
import {
  consumeDirectoryLaunch,
  subscribeDirectoryLaunch,
} from "../../desktopSurface/directoryLaunchBroker";

interface FileManagerBrowserProps {
  instanceToken: string;
}

interface Breadcrumb {
  entryId: string;
  name: string;
}

type ToolbarIconName =
  | "new-folder"
  | "new-file"
  | "rename"
  | "move"
  | "copy"
  | "remove"
  | "upload"
  | "download"
  | "open-with"
  | "add-desktop"
  | "refresh";

type EditDialog =
  | { mode: "create-directory" }
  | { mode: "create-file" }
  | { mode: "rename"; entry: FileEntry }
  | { mode: "copy"; entry: FileEntry }
  | null;

interface OpenWithState {
  entry: FileEntry;
  resolution: ResourceHandlerResolution;
}

interface TransferState {
  kind: "upload" | "download";
  name: string;
  loaded: number;
  total: number;
  fileIndex?: number;
  fileCount?: number;
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
  const [transfer, setTransfer] = useState<TransferState>();
  const [openWith, setOpenWith] = useState<OpenWithState>();
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const directoryNavigationPendingRef = useRef(false);
  const mutationPendingRef = useRef(false);
  const transferAbortRef = useRef<AbortController | undefined>(undefined);
  const appRegistry = useDesktopStore((state) => state.apps);
  const defaultResourceHandlers = useDesktopStore(
    (state) => state.defaultResourceHandlers,
  );
  const setDefaultResourceHandler = useDesktopStore(
    (state) => state.setDefaultResourceHandler,
  );
  const desktopItems = useDesktopSurfaceStore(
    (state) => state.surface.items,
  );
  const addDesktopItem = useDesktopSurfaceStore((state) => state.add);

  useEffect(
    () => () => {
      transferAbortRef.current?.abort();
    },
    [],
  );

  const refresh = useCallback(() => {
    setLoading(true);
    setListing(undefined);
    setRefreshKey((value) => value + 1);
  }, []);

  useEffect(() => {
    const navigatePending = () => {
      const launch = consumeDirectoryLaunch();
      if (!launch) return;
      directoryNavigationPendingRef.current = true;
      setError(undefined);
      setLoading(true);
      setListing(undefined);
      setBreadcrumbs([
        { entryId: launch.entryId, name: launch.name },
      ]);
      setDirectoryId(launch.entryId);
    };
    navigatePending();
    return subscribeDirectoryLaunch(navigatePending);
  }, []);

  useEffect(() => {
    let active = true;
    void listFiles(instanceToken, directoryId)
      .then((value) => {
        if (!active) return;
        setListing(value);
        setSelected(undefined);
        if (value.breadcrumbs) {
          setBreadcrumbs(
            value.breadcrumbs.map((entry) => ({
              entryId: entry.entryId,
              name: entry.name,
            })),
          );
        } else if (directoryId) {
          setBreadcrumbs((current) =>
            current.length === 0
              ? [
                  {
                    entryId: directoryId,
                    name: value.parent.name,
                  },
                ]
              : current.map((breadcrumb, index) =>
                  index === current.length - 1 &&
                  breadcrumb.entryId === value.parent.entryId
                    ? {
                        ...breadcrumb,
                        name: value.parent.name,
                      }
                    : breadcrumb,
                ),
          );
        }
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(messageOf(reason));
      })
      .finally(() => {
        if (active) {
          directoryNavigationPendingRef.current = false;
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [directoryId, instanceToken, refreshKey]);

  const runMutation = async (
    operation: () => Promise<unknown>,
    successMessage?: string,
    afterRefresh?: () => void,
  ) => {
    if (mutationPendingRef.current) return;
    mutationPendingRef.current = true;
    setWorking(true);
    setError(undefined);
    try {
      await operation();
      await useDesktopSurfaceStore.getState().load();
      afterRefresh?.();
      setEditDialog(null);
      setMovingEntry(undefined);
      if (successMessage) setNotice(successMessage);
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
      mutationPendingRef.current = false;
      setWorking(false);
    }
  };

  const uploadFiles = async (files: FileList) => {
    if (!listing) return;
    const controller = new AbortController();
    transferAbortRef.current = controller;
    setWorking(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const selectedFiles = Array.from(files);
      for (const [index, file] of selectedFiles.entries()) {
        setTransfer({
          kind: "upload",
          name: file.name,
          loaded: 0,
          total: file.size,
          fileIndex: index + 1,
          fileCount: selectedFiles.length,
        });
        await uploadLocalFile(
          instanceToken,
          listing.parent.entryId,
          file,
          {
            signal: controller.signal,
            onProgress: ({ loaded, total }) =>
              setTransfer({
                kind: "upload",
                name: file.name,
                loaded,
                total,
                fileIndex: index + 1,
                fileCount: selectedFiles.length,
              }),
          },
        );
      }
      setNotice(`已上传 ${files.length} 个文件。`);
      refresh();
    } catch (reason) {
      setNotice(undefined);
      if (isAbortError(reason)) {
        setNotice("上传已取消。");
      } else {
        setError(messageOf(reason));
      }
      refresh();
    } finally {
      transferAbortRef.current = undefined;
      setTransfer(undefined);
      setWorking(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  };

  const downloadSelected = async () => {
    if (!selected || selected.kind !== "file") return;
    const controller = new AbortController();
    transferAbortRef.current = controller;
    setWorking(true);
    setError(undefined);
    setNotice(undefined);
    setTransfer({
      kind: "download",
      name: selected.name,
      loaded: 0,
      total: selected.size ?? 0,
    });
    try {
      await downloadFile(instanceToken, selected, {
        signal: controller.signal,
        onProgress: ({ loaded, total }) =>
          setTransfer({
            kind: "download",
            name: selected.name,
            loaded,
            total,
          }),
      });
      setNotice(`已下载“${selected.name}”。`);
    } catch (reason) {
      setNotice(undefined);
      if (isAbortError(reason)) {
        setNotice("下载已取消。");
      } else {
        setError(messageOf(reason));
      }
    } finally {
      transferAbortRef.current = undefined;
      setTransfer(undefined);
      setWorking(false);
    }
  };

  const enterDirectory = (entry: FileEntry) => {
    if (
      entry.kind !== "directory" ||
      directoryNavigationPendingRef.current ||
      directoryId === entry.entryId
    ) {
      return;
    }
    directoryNavigationPendingRef.current = true;
    setError(undefined);
    setLoading(true);
    setListing(undefined);
    setBreadcrumbs((current) =>
      current.at(-1)?.entryId === entry.entryId
        ? current
        : [...current, { entryId: entry.entryId, name: entry.name }],
    );
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
    const next = index < 0 ? [] : breadcrumbs.slice(0, index + 1);
    const targetDirectoryId = next.at(-1)?.entryId;
    if (
      directoryNavigationPendingRef.current ||
      targetDirectoryId === directoryId
    ) {
      return;
    }
    directoryNavigationPendingRef.current = true;
    setError(undefined);
    setLoading(true);
    setListing(undefined);
    setBreadcrumbs(next);
    setDirectoryId(targetDirectoryId);
  };

  return (
    <article className="file-manager-app">
      <header className="file-manager-app__toolbar">
        <div className="file-manager-app__actions">
          <div role="group" aria-label="新建">
            <button
              type="button"
              aria-label="新建文件夹"
              title="新建文件夹"
              disabled={!listing || working}
              onClick={() =>
                setEditDialog({ mode: "create-directory" })
              }
            >
              <ToolbarIcon kind="new-folder" />
            </button>
            <button
              type="button"
              aria-label="新建文件"
              title="新建文件"
              disabled={!listing || working}
              onClick={() => setEditDialog({ mode: "create-file" })}
            >
              <ToolbarIcon kind="new-file" />
            </button>
          </div>
          <div role="group" aria-label="整理">
            <button
              type="button"
              aria-label="重命名"
              title="重命名"
              disabled={!selected || working}
              onClick={() =>
                selected &&
                setEditDialog({ mode: "rename", entry: selected })
              }
            >
              <ToolbarIcon kind="rename" />
            </button>
            <button
              type="button"
              aria-label="移动"
              title="移动"
              disabled={!selected || working}
              onClick={() => setMovingEntry(selected)}
            >
              <ToolbarIcon kind="move" />
            </button>
            <button
              type="button"
              aria-label="复制"
              title="复制"
              disabled={
                !selected || selected.kind !== "file" || working
              }
              onClick={() =>
                selected &&
                setEditDialog({ mode: "copy", entry: selected })
              }
            >
              <ToolbarIcon kind="copy" />
            </button>
            <button
              type="button"
              aria-label="移除"
              title="移除"
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
                    undefined,
                    () =>
                      useDesktopSurfaceStore
                        .getState()
                        .patchResolvedTarget(
                          {
                            type: selected.kind,
                            handle: selected.entryId,
                          },
                          {
                            available: false,
                            reason: "文件或目录不存在",
                          },
                        ),
                  );
                }
              }}
            >
              <ToolbarIcon kind="remove" />
            </button>
          </div>
          <div role="group" aria-label="传输">
            <button
              type="button"
              aria-label="上传"
              title="上传"
              disabled={!listing || working}
              onClick={() => uploadInputRef.current?.click()}
            >
              <ToolbarIcon kind="upload" />
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
              aria-label="下载"
              title="下载"
              disabled={!selected || selected.kind !== "file" || working}
              onClick={() => void downloadSelected()}
            >
              <ToolbarIcon kind="download" />
            </button>
          </div>
          <div role="group" aria-label="打开与刷新">
            <button
              type="button"
              aria-label="添加到桌面"
              title="添加到桌面"
              disabled={
                !selected ||
                working ||
                desktopItems.some(
                  (item) =>
                    item.target.type === selected.kind &&
                    item.target.handle === selected.entryId,
                )
              }
              onClick={() => {
                if (!selected) return;
                setError(undefined);
                void addDesktopItem({
                  type: selected.kind,
                  handle: selected.entryId,
                })
                  .then(() =>
                    setNotice(`已将“${selected.name}”添加到桌面。`),
                  )
                  .catch((reason: unknown) =>
                    setError(messageOf(reason)),
                  );
              }}
            >
              <ToolbarIcon kind="add-desktop" />
            </button>
            <button
              type="button"
              aria-label="打开方式"
              title="打开方式"
              disabled={!selected || selected.kind !== "file" || working}
              onClick={() => selected && void openFile(selected, true)}
            >
              <ToolbarIcon kind="open-with" />
            </button>
            <button
              type="button"
              aria-label="刷新"
              title="刷新"
              disabled={loading || working}
              onClick={() => {
                setError(undefined);
                refresh();
              }}
            >
              <ToolbarIcon kind="refresh" />
            </button>
          </div>
        </div>
        <nav aria-label="当前位置" className="file-manager-app__breadcrumbs">
          <button type="button" onClick={() => navigateTo(-1)}>
            /
          </button>
          {breadcrumbs.map((breadcrumb, index) => (
            <span key={breadcrumb.entryId}>
              <span aria-hidden="true">›</span>
              <button type="button" onClick={() => navigateTo(index)}>
                {breadcrumb.name}
              </button>
            </span>
          ))}
        </nav>
      </header>

      {error && (
        <div className="file-manager-app__error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="file-manager-app__notice" role="status">
          {notice}
          <button
            type="button"
            aria-label="关闭提示"
            title="关闭提示"
            onClick={() => setNotice(undefined)}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}
      {transfer && (
        <TransferProgress
          transfer={transfer}
          onCancel={() => transferAbortRef.current?.abort()}
        />
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
            editDialog.mode === "rename"
              ? editDialog.entry.name
              : editDialog.mode === "copy"
                ? copyName(editDialog.entry.name)
                : editDialog.mode === "create-file"
                  ? "未命名.txt"
                  : ""
          }
          working={working}
          onCancel={() => setEditDialog(null)}
          onSubmit={(name) => {
            const mode = editDialog.mode;
            void runMutation(() => {
              if (mode === "create-directory") {
                return createDirectory(
                  instanceToken,
                  listing.parent.entryId,
                  name,
                  listing.revision,
                );
              }
              if (mode === "create-file") {
                return createFile(
                  instanceToken,
                  listing.parent.entryId,
                  name,
                  listing.revision,
                );
              }
              if (mode === "copy") {
                return copyFile(
                  instanceToken,
                  editDialog.entry.entryId,
                  listing.parent.entryId,
                  name,
                  listing.revision,
                );
              }
              return moveEntry(
                instanceToken,
                editDialog.entry.entryId,
                listing.parent.entryId,
                name,
                listing.revision,
              );
            }, mode === "create-file"
              ? `已新建“${name}”。`
              : mode === "copy"
                ? `已创建副本“${name}”。`
                : undefined,
            mode === "rename"
              ? () =>
                  useDesktopSurfaceStore
                    .getState()
                    .patchResolvedTarget(
                      {
                        type: editDialog.entry.kind,
                        handle: editDialog.entry.entryId,
                      },
                      {
                        available: true,
                        name,
                        reason: undefined,
                      },
                    )
              : undefined);
          }}
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
  mode: "create-directory" | "create-file" | "rename" | "copy";
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
          {mode === "create-directory"
            ? "新建文件夹"
            : mode === "create-file"
              ? "新建文件"
              : mode === "copy"
                ? "复制文件"
                : "重命名"}
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
  const [loading, setLoading] = useState(true);
  const navigationPendingRef = useRef(false);

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
      })
      .finally(() => {
        if (active) {
          navigationPendingRef.current = false;
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [directoryId, instanceToken]);

  const navigate = (index: number) => {
    const next = index < 0 ? [] : stack.slice(0, index + 1);
    const targetDirectoryId = next.at(-1)?.entryId;
    if (
      navigationPendingRef.current ||
      targetDirectoryId === directoryId
    ) {
      return;
    }
    navigationPendingRef.current = true;
    setLoading(true);
    setListing(undefined);
    setStack(next);
    setDirectoryId(targetDirectoryId);
  };

  const enterDirectory = (item: FileEntry) => {
    if (
      item.kind !== "directory" ||
      navigationPendingRef.current ||
      item.entryId === directoryId
    ) {
      return;
    }
    navigationPendingRef.current = true;
    setLoading(true);
    setListing(undefined);
    setStack((current) =>
      current.at(-1)?.entryId === item.entryId
        ? current
        : [...current, { entryId: item.entryId, name: item.name }],
    );
    setDirectoryId(item.entryId);
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
        {loading && <p role="status">正在读取目标文件夹…</p>}
        <ul className="file-manager-dialog__directories">
          {listing?.entries
            .filter((item) => item.kind === "directory")
            .map((item) => (
              <li key={item.entryId}>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => enterDirectory(item)}
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
              loading ||
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

function TransferProgress({
  transfer,
  onCancel,
}: {
  transfer: TransferState;
  onCancel: () => void;
}) {
  const percentage =
    transfer.total > 0
      ? Math.min(100, Math.round((transfer.loaded / transfer.total) * 100))
      : 0;
  const action = transfer.kind === "upload" ? "上传" : "下载";
  const sequence =
    transfer.fileIndex && transfer.fileCount
      ? ` ${transfer.fileIndex}/${transfer.fileCount}`
      : "";
  return (
    <div className="file-manager-app__transfer" role="status">
      <div>
        <span>
          正在{action}{sequence}：“{transfer.name}”
        </span>
        <span>
          {formatSize(transfer.loaded)} / {formatSize(transfer.total)}
          {transfer.total > 0 ? ` · ${percentage}%` : ""}
        </span>
      </div>
      <progress
        aria-label={`${action}进度`}
        max={transfer.total > 0 ? transfer.total : undefined}
        value={transfer.total > 0 ? transfer.loaded : undefined}
      />
      <button type="button" onClick={onCancel}>
        取消
      </button>
    </div>
  );
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "AbortError";
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function copyName(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name} - 副本`;
  return `${name.slice(0, dot)} - 副本${name.slice(dot)}`;
}

function ToolbarIcon({ kind }: { kind: ToolbarIconName }) {
  const paths: Record<ToolbarIconName, string[]> = {
    "new-folder": [
      "M3 6h6l2 2h10v11H3z",
      "M15 11v6",
      "M12 14h6",
    ],
    "new-file": [
      "M6 2h8l4 4v16H6z",
      "M14 2v6h4",
      "M12 11v6",
      "M9 14h6",
    ],
    rename: [
      "M4 20h4l11-11-4-4L4 16z",
      "M13.5 6.5l4 4",
    ],
    move: [
      "M3 6h6l2 2h10v11H3z",
      "M8 13h8",
      "M13 10l3 3-3 3",
    ],
    copy: ["M8 8h12v12H8z", "M4 16V4h12"],
    remove: [
      "M4 7h16",
      "M9 7V4h6v3",
      "M6 7l1 14h10l1-14",
      "M10 11v6",
      "M14 11v6",
    ],
    upload: ["M12 19V5", "M7 10l5-5 5 5", "M5 21h14"],
    download: ["M12 5v14", "M7 14l5 5 5-5", "M5 3h14"],
    "open-with": [
      "M14 3h7v7",
      "M10 14L21 3",
      "M21 14v7H3V3h7",
    ],
    "add-desktop": [
      "M4 5h16v12H4z",
      "M8 21h8",
      "M12 17v4",
      "M12 8v6",
      "M9 11h6",
    ],
    refresh: [
      "M20 7v5h-5",
      "M4 17v-5h5",
      "M6.1 8a7 7 0 0 1 11.7-2L20 9",
      "M17.9 16a7 7 0 0 1-11.7 2L4 15",
    ],
  };
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[kind].map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}
