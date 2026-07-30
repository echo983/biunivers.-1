import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  copyEntries,
  copyFile,
  createFile,
  createMultiResourceLaunch,
  createResourceLaunch,
  createDirectory,
  moveEntries,
  moveEntry,
  removeEntries,
  removeEntry,
  resolveResourceHandlers,
  resolveMultiResourceHandlers,
  type MultiResourceHandlerResolution,
  type ResourceHandlerCandidate,
  type ResourceHandlerResolution,
} from "../../api/internalFileManagerClient";
import {
  downloadFile,
  downloadZip,
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
import {
  updateFileSelection,
  type FileSelection,
} from "./fileSelection";
import { EntryIdenticon } from "../../components/EntryIdenticon";
import { createWorkspace } from "../../api/workspaceClient";

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
  | "workspace"
  | "refresh"
  | "list-view"
  | "icon-view";

type FileManagerViewMode = "list" | "icons";

const VIEW_MODE_STORAGE_KEY = "biunivers.file-manager.view-mode";

type EditDialog =
  | { mode: "create-directory" }
  | { mode: "create-file" }
  | { mode: "rename"; entry: FileEntry }
  | { mode: "copy"; entry: FileEntry }
  | null;

type OpenWithState =
  | {
      kind: "single";
      entry: FileEntry;
      resolution: ResourceHandlerResolution;
    }
  | {
      kind: "multiple";
      entries: FileEntry[];
      resolution: MultiResourceHandlerResolution;
    };

interface TransferState {
  kind: "upload" | "download";
  name: string;
  loaded: number;
  total: number;
  fileIndex?: number;
  fileCount?: number;
}

interface IconSelectionBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface IconSelectionDrag {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  additiveEntryIds: Set<string>;
  moved: boolean;
}

export function FileManagerBrowser({
  instanceToken,
}: FileManagerBrowserProps) {
  const [directoryId, setDirectoryId] = useState<string>();
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [listing, setListing] = useState<DirectoryListing>();
  const [selection, setSelection] = useState<FileSelection>({
    entryIds: new Set(),
  });
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [editDialog, setEditDialog] = useState<EditDialog>(null);
  const [destinationDialog, setDestinationDialog] = useState<{
    mode: "move" | "copy";
    entries: FileEntry[];
  }>();
  const [notice, setNotice] = useState<string>();
  const [transfer, setTransfer] = useState<TransferState>();
  const [openWith, setOpenWith] = useState<OpenWithState>();
  const [viewMode, setViewMode] = useState<FileManagerViewMode>(() => {
    try {
      return localStorage.getItem(VIEW_MODE_STORAGE_KEY) === "icons"
        ? "icons"
        : "list";
    } catch {
      return "list";
    }
  });
  const [iconSelectionBox, setIconSelectionBox] =
    useState<IconSelectionBox>();
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const directoryNavigationPendingRef = useRef(false);
  const mutationPendingRef = useRef(false);
  const transferAbortRef = useRef<AbortController | undefined>(undefined);
  const iconSelectionDragRef = useRef<IconSelectionDrag | undefined>(
    undefined,
  );
  const suppressIconGridClickRef = useRef(false);
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
  const changeViewMode = (next: FileManagerViewMode) => {
    setViewMode(next);
    try {
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, next);
    } catch {
      // A blocked storage backend must not make the view switch unusable.
    }
  };
  const selectedEntries =
    listing?.entries.filter((entry) => selection.entryIds.has(entry.entryId)) ??
    [];
  const selected =
    selectedEntries.length === 1 ? selectedEntries[0] : undefined;

  const createSelectedWorkspace = async () => {
    if (selectedEntries.length === 0 || working) return;
    const suggested =
      selectedEntries.length === 1
        ? selectedEntries[0].name
        : `${listing?.parent.name || "文件"}工作空间`;
    const name = window.prompt("工作空间名称", suggested)?.trim();
    if (!name) return;
    setWorking(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await createWorkspace(instanceToken, {
        name,
        selectedEntryIds: selectedEntries.map((entry) => entry.entryId),
      });
      setNotice(
        `已创建工作空间“${result.workspace.name}”，包含 ${result.entryCount} 个项目。`,
      );
      openApp("system.workspaces");
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setWorking(false);
    }
  };

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
        setSelection({ entryIds: new Set() });
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
      setDestinationDialog(undefined);
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
    if (!listing || selectedEntries.length === 0) return;
    const directFile =
      selectedEntries.length === 1 && selectedEntries[0].kind === "file"
        ? selectedEntries[0]
        : undefined;
    const downloadName = directFile
      ? directFile.name
      : selectedEntries.length === 1
        ? `${selectedEntries[0].name}.zip`
        : "biunivers-download.zip";
    const controller = new AbortController();
    transferAbortRef.current = controller;
    setWorking(true);
    setError(undefined);
    setNotice(undefined);
    setTransfer({
      kind: "download",
      name: downloadName,
      loaded: 0,
      total: directFile?.size ?? 0,
    });
    try {
      const options = {
        signal: controller.signal,
        onProgress: ({ loaded, total }: { loaded: number; total: number }) =>
          setTransfer({
            kind: "download" as const,
            name: downloadName,
            loaded,
            total,
          }),
      };
      if (directFile) {
        await downloadFile(instanceToken, directFile, options);
      } else {
        await downloadZip(
          instanceToken,
          selectedEntries,
          listing.revision,
          options,
        );
      }
      setNotice(`已下载“${downloadName}”。`);
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
    setNotice(
      state.kind === "single"
        ? `正在用“${candidate.appName}”打开“${state.entry.name}”…`
        : `正在用“${candidate.appName}”打开 ${state.entries.length} 个文件…`,
    );
    try {
      if (!appRegistry[candidate.appId]) {
        throw new Error("目标应用尚未加载，请刷新桌面后重试。");
      }
      const launch =
        state.kind === "single"
          ? await createResourceLaunch(instanceToken, {
              entryId: state.entry.entryId,
              expectedRevision: state.resolution.revision,
              targetAppId: candidate.appId,
              handlerId: candidate.handler.id,
              action: state.resolution.effectiveAction,
            })
          : await createMultiResourceLaunch(instanceToken, {
              entryIds: state.entries.map((entry) => entry.entryId),
              expectedRevision: state.resolution.revision,
              targetAppId: candidate.appId,
              handlerId: candidate.handler.id,
              action: "open",
            });
      openApp(candidate.appId, { launchId: launch.launchId });
      if (
        state.kind === "single" &&
        remember &&
        state.resolution.extension
      ) {
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
        state.kind === "single" &&
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
      const state: OpenWithState = { kind: "single", entry, resolution };
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

  const openFiles = async (entries: FileEntry[]) => {
    if (entries.length > 100) {
      setError("一次最多用同一应用打开 100 个文件。");
      return;
    }
    if (
      entries.length < 2 ||
      entries.some((entry) => entry.kind !== "file") ||
      !listing ||
      working
    ) {
      return;
    }
    setWorking(true);
    setError(undefined);
    setNotice(`正在查找 ${entries.length} 个文件的共同打开方式…`);
    try {
      const resolution = await resolveMultiResourceHandlers(
        instanceToken,
        entries.map((entry) => entry.entryId),
        listing.revision,
      );
      if (resolution.candidates.length === 0) {
        setNotice(undefined);
        setError("没有能够同时打开这些文件的应用。");
        return;
      }
      setNotice(undefined);
      setOpenWith({ kind: "multiple", entries, resolution });
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
              disabled={selectedEntries.length === 0 || working}
              onClick={() =>
                setDestinationDialog({
                  mode: "move",
                  entries: selectedEntries,
                })
              }
            >
              <ToolbarIcon kind="move" />
            </button>
            <button
              type="button"
              aria-label="复制"
              title="复制"
              disabled={
                selectedEntries.length === 0 || working
              }
              onClick={() => {
                if (selected?.kind === "file") {
                  setEditDialog({ mode: "copy", entry: selected });
                } else {
                  setDestinationDialog({
                    mode: "copy",
                    entries: selectedEntries,
                  });
                }
              }}
            >
              <ToolbarIcon kind="copy" />
            </button>
            <button
              type="button"
              aria-label="移除"
              title="移除"
              disabled={selectedEntries.length === 0 || working}
              onClick={() => {
                if (
                  listing &&
                  window.confirm(
                    selectedEntries.length === 1
                      ? selectedEntries[0].kind === "directory"
                        ? `从当前文件树移除文件夹“${selectedEntries[0].name}”及其内容？`
                        : `从当前文件树移除文件“${selectedEntries[0].name}”？`
                      : `从当前文件树移除选中的 ${selectedEntries.length} 项及其中的目录内容？`,
                  )
                ) {
                  void runMutation(() =>
                    selectedEntries.length === 1
                      ? removeEntry(
                      instanceToken,
                      selectedEntries[0].entryId,
                      selectedEntries[0].kind === "directory",
                      listing.revision,
                        )
                      : removeEntries(
                          instanceToken,
                          selectedEntries.map((entry) => entry.entryId),
                          listing.revision,
                        ),
                    undefined,
                    () => {
                      for (const entry of selectedEntries) {
                      useDesktopSurfaceStore
                        .getState()
                        .patchResolvedTarget(
                          {
                              type: entry.kind,
                              handle: entry.entryId,
                          },
                          {
                            available: false,
                            reason: "文件或目录不存在",
                          },
                          );
                      }
                    },
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
              aria-label={downloadActionLabel(selectedEntries)}
              title={downloadActionLabel(selectedEntries)}
              disabled={selectedEntries.length === 0 || working}
              onClick={() => void downloadSelected()}
            >
              <ToolbarIcon kind="download" />
            </button>
          </div>
          <div role="group" aria-label="打开与刷新">
            <button
              type="button"
              aria-label="创建工作空间"
              title="从选中项目创建工作空间"
              disabled={selectedEntries.length === 0 || working}
              onClick={() => void createSelectedWorkspace()}
            >
              <ToolbarIcon kind="workspace" />
            </button>
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
              disabled={
                selectedEntries.length === 0 ||
                selectedEntries.some((entry) => entry.kind !== "file") ||
                working
              }
              onClick={() => {
                if (selectedEntries.length === 1) {
                  void openFile(selectedEntries[0], true);
                } else {
                  void openFiles(selectedEntries);
                }
              }}
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
          {selectedEntries.length > 0 && (
            <span className="file-manager-app__selection-count" role="status">
              已选择 {selectedEntries.length} 项
            </span>
          )}
          <div
            className="file-manager-app__view-switch"
            role="group"
            aria-label="视图"
          >
            <button
              type="button"
              aria-label="列表视图"
              title="列表视图"
              aria-pressed={viewMode === "list"}
              onClick={() => changeViewMode("list")}
            >
              <ToolbarIcon kind="list-view" />
            </button>
            <button
              type="button"
              aria-label="图标视图"
              title="图标视图"
              aria-pressed={viewMode === "icons"}
              onClick={() => changeViewMode("icons")}
            >
              <ToolbarIcon kind="icon-view" />
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

      <div
        className="file-manager-app__content"
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            setSelection({ entryIds: new Set() });
          }
        }}
      >
        {loading ? (
          <p className="file-manager-app__empty">正在读取目录…</p>
        ) : listing && listing.entries.length > 0 && viewMode === "list" ? (
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
                    selection.entryIds.has(entry.entryId)
                      ? "is-selected"
                      : undefined
                  }
                  tabIndex={0}
                  aria-selected={selection.entryIds.has(entry.entryId)}
                  onMouseDown={(event) => {
                    if (event.shiftKey) event.preventDefault();
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelection((current) =>
                      updateFileSelection(
                        listing.entries.map((item) => item.entryId),
                        current,
                        entry.entryId,
                        {
                          toggle: event.ctrlKey || event.metaKey,
                          range: event.shiftKey,
                        },
                      ),
                    );
                  }}
                  onDoubleClick={() => activateEntry(entry)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") activateEntry(entry);
                  }}
                >
                  <td>
                    {entry.kind === "directory" ? (
                      <span aria-hidden="true">📁</span>
                    ) : (
                      <EntryIdenticon
                        entryId={entry.entryId}
                        size={18}
                        className="file-manager-app__list-identicon"
                      />
                    )}{" "}
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
        ) : listing && listing.entries.length > 0 ? (
          <div
            className="file-manager-app__icon-grid"
            role="grid"
            aria-label="文件"
            onClick={(event) => {
              if (suppressIconGridClickRef.current) {
                suppressIconGridClickRef.current = false;
                return;
              }
              if (event.target === event.currentTarget) {
                setSelection({ entryIds: new Set() });
              }
            }}
            onPointerDown={(event) => {
              if (
                event.button !== 0 ||
                event.target !== event.currentTarget
              ) {
                return;
              }
              event.preventDefault();
              const additiveEntryIds =
                event.ctrlKey || event.metaKey
                  ? new Set(selection.entryIds)
                  : new Set<string>();
              iconSelectionDragRef.current = {
                pointerId: event.pointerId,
                startClientX: event.clientX,
                startClientY: event.clientY,
                additiveEntryIds,
                moved: false,
              };
              event.currentTarget.setPointerCapture?.(event.pointerId);
              setSelection({ entryIds: additiveEntryIds });
              setIconSelectionBox(
                iconSelectionRectangle(
                  event.currentTarget,
                  event.clientX,
                  event.clientY,
                  event.clientX,
                  event.clientY,
                ),
              );
            }}
            onPointerMove={(event) => {
              const drag = iconSelectionDragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              event.preventDefault();
              if (
                Math.abs(event.clientX - drag.startClientX) > 3 ||
                Math.abs(event.clientY - drag.startClientY) > 3
              ) {
                drag.moved = true;
              }
              const bounds = event.currentTarget.getBoundingClientRect();
              const endClientX = clamp(
                event.clientX,
                bounds.left,
                bounds.right,
              );
              const endClientY = clamp(
                event.clientY,
                bounds.top,
                bounds.bottom,
              );
              const clientRectangle = normalizedRectangle(
                drag.startClientX,
                drag.startClientY,
                endClientX,
                endClientY,
              );
              const selectedEntryIds = new Set(drag.additiveEntryIds);
              for (const item of event.currentTarget.querySelectorAll<HTMLElement>(
                "[data-entry-id]",
              )) {
                if (rectanglesIntersect(clientRectangle, item.getBoundingClientRect())) {
                  selectedEntryIds.add(item.dataset.entryId!);
                }
              }
              setSelection({ entryIds: selectedEntryIds });
              setIconSelectionBox(
                iconSelectionRectangle(
                  event.currentTarget,
                  drag.startClientX,
                  drag.startClientY,
                  endClientX,
                  endClientY,
                ),
              );
            }}
            onPointerUp={(event) => {
              const drag = iconSelectionDragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              suppressIconGridClickRef.current = drag.moved;
              iconSelectionDragRef.current = undefined;
              setIconSelectionBox(undefined);
              event.currentTarget.releasePointerCapture?.(event.pointerId);
            }}
            onPointerCancel={() => {
              iconSelectionDragRef.current = undefined;
              setIconSelectionBox(undefined);
            }}
          >
            {listing.entries.map((entry) => (
              <button
                key={entry.entryId}
                type="button"
                role="gridcell"
                data-entry-id={entry.entryId}
                className={
                  selection.entryIds.has(entry.entryId)
                    ? "is-selected"
                    : undefined
                }
                aria-selected={selection.entryIds.has(entry.entryId)}
                onMouseDown={(event) => {
                  if (event.shiftKey) event.preventDefault();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  setSelection((current) =>
                    updateFileSelection(
                      listing.entries.map((item) => item.entryId),
                      current,
                      entry.entryId,
                      {
                        toggle: event.ctrlKey || event.metaKey,
                        range: event.shiftKey,
                      },
                    ),
                  );
                }}
                onDoubleClick={() => activateEntry(entry)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") activateEntry(entry);
                }}
              >
                <span
                  className="file-manager-app__entry-icon"
                  aria-hidden="true"
                >
                  {entry.kind === "directory" ? (
                    "📁"
                  ) : (
                    <EntryIdenticon
                      entryId={entry.entryId}
                      size={42}
                      className="file-manager-app__identicon"
                    />
                  )}
                </span>
                <span className="file-manager-app__entry-name">
                  {entry.name}
                </span>
              </button>
            ))}
            {iconSelectionBox && (
              <div
                className="file-manager-app__selection-box"
                aria-hidden="true"
                style={iconSelectionBox}
              />
            )}
          </div>
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

      {listing && destinationDialog && (
        <DestinationDialog
          instanceToken={instanceToken}
          mode={destinationDialog.mode}
          entries={destinationDialog.entries}
          originalParentEntryId={listing.parent.entryId}
          expectedRevision={listing.revision}
          working={working}
          onCancel={() => setDestinationDialog(undefined)}
          onConfirm={(parentEntryId) =>
            void runMutation(
              () =>
                destinationDialog.mode === "move"
                  ? destinationDialog.entries.length === 1
                    ? moveEntry(
                        instanceToken,
                        destinationDialog.entries[0].entryId,
                        parentEntryId,
                        destinationDialog.entries[0].name,
                        listing.revision,
                      )
                    : moveEntries(
                        instanceToken,
                        destinationDialog.entries.map(
                          (entry) => entry.entryId,
                        ),
                        parentEntryId,
                        listing.revision,
                      )
                  : copyEntries(
                      instanceToken,
                      destinationDialog.entries.map(
                        (entry) => entry.entryId,
                      ),
                      parentEntryId,
                      listing.revision,
                    ),
              destinationDialog.mode === "move"
                ? `已移动 ${destinationDialog.entries.length} 项。`
                : `已复制 ${destinationDialog.entries.length} 项。`,
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
          {state.kind === "single"
            ? `打开“${state.entry.name}”`
            : `打开 ${state.entries.length} 个文件`}
        </h2>
        {state.kind === "single" &&
          state.resolution.effectiveAction === "open" &&
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
        {state.kind === "single" && state.resolution.extension && (
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

function DestinationDialog({
  instanceToken,
  mode,
  entries,
  originalParentEntryId,
  expectedRevision,
  working,
  onCancel,
  onConfirm,
}: {
  instanceToken: string;
  mode: "move" | "copy";
  entries: FileEntry[];
  originalParentEntryId: string;
  expectedRevision: number;
  working: boolean;
  onCancel: () => void;
  onConfirm: (parentEntryId: string) => void;
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
        <h2 id="file-manager-move-dialog-title">
          {entries.length === 1
            ? `${mode === "move" ? "移动" : "复制"}“${entries[0].name}”`
            : `${mode === "move" ? "移动" : "复制"} ${entries.length} 项`}
        </h2>
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
            onClick={() => listing && onConfirm(listing.parent.entryId)}
          >
            {mode === "move" ? "移动到这里" : "复制到这里"}
          </button>
        </div>
      </section>
    </div>
  );
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : "文件操作失败";
}

function downloadActionLabel(entries: readonly FileEntry[]): string {
  if (entries.length === 0) return "下载";
  if (entries.length === 1) {
    return entries[0].kind === "file"
      ? "下载文件"
      : "将目录导出为 ZIP";
  }
  return `将 ${entries.length} 个项目导出为 ZIP`;
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

function normalizedRectangle(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
) {
  return {
    left: Math.min(startX, endX),
    top: Math.min(startY, endY),
    right: Math.max(startX, endX),
    bottom: Math.max(startY, endY),
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function iconSelectionRectangle(
  container: HTMLElement,
  startClientX: number,
  startClientY: number,
  endClientX: number,
  endClientY: number,
): IconSelectionBox {
  const bounds = container.getBoundingClientRect();
  const rectangle = normalizedRectangle(
    startClientX,
    startClientY,
    endClientX,
    endClientY,
  );
  return {
    left: rectangle.left - bounds.left + container.scrollLeft,
    top: rectangle.top - bounds.top + container.scrollTop,
    width: rectangle.right - rectangle.left,
    height: rectangle.bottom - rectangle.top,
  };
}

function rectanglesIntersect(
  left: { left: number; top: number; right: number; bottom: number },
  right: { left: number; top: number; right: number; bottom: number },
) {
  return (
    left.left < right.right &&
    left.right > right.left &&
    left.top < right.bottom &&
    left.bottom > right.top
  );
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
    workspace: [
      "M3 7h7l2 2h9v11H3z",
      "M7 4h10v3",
      "M12 12v5",
      "M9.5 14.5h5",
    ],
    refresh: [
      "M20 7v5h-5",
      "M4 17v-5h5",
      "M6.1 8a7 7 0 0 1 11.7-2L20 9",
      "M17.9 16a7 7 0 0 1-11.7 2L4 15",
    ],
    "list-view": [
      "M4 6h2",
      "M9 6h11",
      "M4 12h2",
      "M9 12h11",
      "M4 18h2",
      "M9 18h11",
    ],
    "icon-view": [
      "M4 4h6v6H4z",
      "M14 4h6v6h-6z",
      "M4 14h6v6H4z",
      "M14 14h6v6h-6z",
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
