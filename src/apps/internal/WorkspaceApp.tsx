import { useCallback, useEffect, useState } from "react";
import {
  closeHostInstance,
  createHostInstance,
} from "../../hostApi/instanceClient";
import type { DirectoryListing, FileEntry } from "../../hostApi/fileHostClient";
import {
  deleteWorkspace,
  getWorkspaceDiff,
  getWorkspaceTextDiff,
  listWorkspaceFiles,
  listWorkspaces,
  setWorkspaceRetention,
  type WorkspaceDiff,
  type WorkspaceSummary,
  type WorkspaceTextDiff,
} from "../../api/workspaceClient";
import { EntryIdenticon } from "../../components/EntryIdenticon";

type ViewState =
  | { mode: "loading" }
  | { mode: "unavailable" }
  | { mode: "error"; message: string }
  | { mode: "ready"; token: string };

export function WorkspaceApp() {
  const [state, setState] = useState<ViewState>({ mode: "loading" });
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [listing, setListing] = useState<DirectoryListing>();
  const [directoryId, setDirectoryId] = useState<string>();
  const [viewMode, setViewMode] = useState<"files" | "changes">("files");
  const [diff, setDiff] = useState<WorkspaceDiff>();
  const [textDiffs, setTextDiffs] = useState<
    Record<string, WorkspaceTextDiff>
  >({});
  const [loadingTextPath, setLoadingTextPath] = useState<string>();
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async (token: string) => {
    const values = await listWorkspaces(token);
    setWorkspaces(values);
    setSelectedId((current) =>
      current && values.some((workspace) => workspace.workspaceIdHex === current)
        ? current
        : values[0]?.workspaceIdHex,
    );
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let token: string | undefined;
    void createHostInstance(
      "system.workspaces",
      crypto.randomUUID(),
      controller.signal,
    )
      .then(async (instance) => {
        if (!instance || controller.signal.aborted) {
          if (instance) void closeHostInstance(instance.instanceToken);
          if (!controller.signal.aborted) setState({ mode: "unavailable" });
          return;
        }
        token = instance.instanceToken;
        await refresh(token);
        if (!controller.signal.aborted) {
          setState({ mode: "ready", token });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({
            mode: "error",
            message:
              error instanceof Error ? error.message : "工作空间初始化失败",
          });
        }
      });
    return () => {
      controller.abort();
      if (token) void closeHostInstance(token);
    };
  }, [refresh]);

  useEffect(() => {
    if (state.mode !== "ready" || !selectedId) {
      return;
    }
    let active = true;
    void listWorkspaceFiles(state.token, selectedId, directoryId)
      .then((value) => {
        if (active) setListing(value);
      })
      .catch((error: unknown) => {
        if (active) {
          setNotice(
            error instanceof Error ? error.message : "读取工作空间失败",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [directoryId, selectedId, state]);

  const selectedRevision = workspaces.find(
    (workspace) => workspace.workspaceIdHex === selectedId,
  )?.revision;
  useEffect(() => {
    if (
      state.mode !== "ready" ||
      !selectedId ||
      viewMode !== "changes"
    ) {
      return;
    }
    let active = true;
    void getWorkspaceDiff(state.token, selectedId)
      .then((value) => {
        if (active) setDiff(value);
      })
      .catch((error: unknown) => {
        if (active) {
          setNotice(
            error instanceof Error ? error.message : "读取变更失败",
          );
        }
      })
    return () => {
      active = false;
    };
  }, [selectedId, selectedRevision, state, viewMode]);

  if (state.mode === "loading") {
    return <div className="window-loading">正在连接工作空间服务…</div>;
  }
  if (state.mode === "unavailable") {
    return <div className="window-error">当前宿主尚未启用 Workspace 能力。</div>;
  }
  if (state.mode === "error") {
    return <div className="window-error">{state.message}</div>;
  }

  const selected = workspaces.find(
    (workspace) => workspace.workspaceIdHex === selectedId,
  );
  const changeRetention = async () => {
    if (!selected) return;
    setWorking(true);
    setNotice("");
    try {
      await setWorkspaceRetention(
        state.token,
        selected.workspaceIdHex,
        selected.retention === "KEPT" ? "TEMPORARY" : "KEPT",
      );
      await refresh(state.token);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作失败");
    } finally {
      setWorking(false);
    }
  };
  const remove = async () => {
    if (
      !selected ||
      !window.confirm(`删除工作空间“${selected.name}”？主文件树不会受到影响。`)
    ) {
      return;
    }
    setWorking(true);
    setNotice("");
    try {
      await deleteWorkspace(state.token, selected.workspaceIdHex);
      setDirectoryId(undefined);
      setListing(undefined);
      setDiff(undefined);
      setTextDiffs({});
      await refresh(state.token);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "删除失败");
    } finally {
      setWorking(false);
    }
  };

  return (
    <article className="workspace-app">
      <aside>
        <header>
          <h1>工作空间</h1>
          <button
            type="button"
            disabled={working}
            onClick={() => void refresh(state.token)}
          >
            刷新
          </button>
        </header>
        {workspaces.length === 0 ? (
          <p>尚无工作空间。请在文件管理器中选择项目后创建。</p>
        ) : (
          <ul>
            {workspaces.map((workspace) => (
              <li key={workspace.workspaceIdHex}>
                <button
                  type="button"
                  className={
                    workspace.workspaceIdHex === selectedId
                      ? "is-selected"
                      : ""
                  }
                  onClick={() => {
                    setDirectoryId(undefined);
                    setListing(undefined);
                    setDiff(undefined);
                    setTextDiffs({});
                    setViewMode("files");
                    setSelectedId(workspace.workspaceIdHex);
                  }}
                >
                  <strong>{workspace.name}</strong>
                  <span>
                    revision {workspace.revision} ·{" "}
                    {workspace.retention === "KEPT" ? "保留" : "临时"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <main>
        {selected ? (
          <>
            <header>
              <div>
                <h2>{selected.name}</h2>
                <p>来源 main · 创建于 {formatDate(selected.createdAtMs)}</p>
              </div>
              <div>
                <div className="workspace-app__view-switch" role="group">
                  <button
                    type="button"
                    className={viewMode === "files" ? "is-active" : ""}
                    onClick={() => setViewMode("files")}
                  >
                    文件
                  </button>
                  <button
                    type="button"
                    className={viewMode === "changes" ? "is-active" : ""}
                    onClick={() => setViewMode("changes")}
                  >
                    变更
                  </button>
                </div>
                <button
                  type="button"
                  disabled={working}
                  onClick={() => void changeRetention()}
                >
                  {selected.retention === "KEPT" ? "改为临时" : "保留"}
                </button>
                <button
                  type="button"
                  disabled={working || selected.activeWriteRunIdHex !== null}
                  onClick={() => void remove()}
                >
                  删除
                </button>
              </div>
            </header>
            {notice && <p className="workspace-app__notice">{notice}</p>}
            {viewMode === "files" ? (
              <>
                <nav aria-label="工作空间路径">
                  <button type="button" onClick={() => setDirectoryId(undefined)}>
                    /
                  </button>
                  {listing?.breadcrumbs?.map((entry, index) => (
                    <span key={entry.entryId}>
                      {index === 0 ? "" : " / "}
                      <button
                        type="button"
                        onClick={() => setDirectoryId(entry.entryId)}
                      >
                        {entry.name}
                      </button>
                    </span>
                  ))}
                </nav>
                <div className="workspace-app__files">
                  {listing?.entries.length === 0 && <p>此目录为空。</p>}
                  {listing?.entries.map((entry) => (
                    <WorkspaceEntry
                      key={entry.entryId}
                      entry={entry}
                      onActivate={() => {
                        if (entry.kind === "directory") {
                          setDirectoryId(entry.entryId);
                          return;
                        }
                        setNotice(
                          `“${entry.name}”属于隔离 Workspace；当前阶段仅支持只读目录浏览。`,
                        );
                      }}
                    />
                  ))}
                </div>
              </>
            ) : (
              <WorkspaceChanges
                diff={diff}
                expectedRevision={selected.revision}
                textDiffs={textDiffs}
                loadingTextPath={loadingTextPath}
                onLoadTextDiff={(path) => {
                  setLoadingTextPath(path);
                  void getWorkspaceTextDiff(
                    state.token,
                    selected.workspaceIdHex,
                    path,
                  )
                    .then((value) => {
                      setTextDiffs((current) => ({
                        ...current,
                        [path]: value,
                      }));
                    })
                    .catch((error: unknown) => {
                      setNotice(
                        error instanceof Error
                          ? error.message
                          : "读取文本差异失败",
                      );
                    })
                    .finally(() => setLoadingTextPath(undefined));
                }}
              />
            )}
          </>
        ) : (
          <p className="workspace-app__empty">选择一个工作空间查看内容。</p>
        )}
      </main>
    </article>
  );
}

function WorkspaceChanges({
  diff,
  expectedRevision,
  textDiffs,
  loadingTextPath,
  onLoadTextDiff,
}: {
  diff?: WorkspaceDiff;
  expectedRevision: number;
  textDiffs: Record<string, WorkspaceTextDiff>;
  loadingTextPath?: string;
  onLoadTextDiff: (path: string) => void;
}) {
  if (!diff || diff.currentRevision !== expectedRevision) {
    return <p>正在比较固定 Head…</p>;
  }
  return (
    <section className="workspace-app__changes">
      <p>
        revision {diff.baselineRevision} → {diff.currentRevision} · 新增{" "}
        {diff.summary.added} · 修改 {diff.summary.modified} · 删除{" "}
        {diff.summary.deleted}
      </p>
      {diff.changes.length === 0 ? (
        <p className="workspace-app__empty">相对初始版本没有变化。</p>
      ) : (
        <ul>
          {diff.changes.map((entry) => (
            <li key={entry.path}>
              <div className="workspace-app__change-row">
                <span className={`workspace-app__change-kind is-${entry.change}`}>
                  {changeLabel(entry.change)}
                </span>
                <strong>{entry.path}</strong>
                <small>{changeDetails(entry)}</small>
                {canShowTextDiff(entry) && (
                  <button
                    type="button"
                    disabled={loadingTextPath === entry.path}
                    onClick={() => onLoadTextDiff(entry.path)}
                  >
                    {loadingTextPath === entry.path
                      ? "读取中…"
                      : textDiffs[entry.path]
                        ? "重新读取"
                        : "文本差异"}
                  </button>
                )}
              </div>
              {textDiffs[entry.path] && (
                <TextDiffResult result={textDiffs[entry.path]} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TextDiffResult({ result }: { result: WorkspaceTextDiff }) {
  if (result.available) {
    return <pre className="workspace-app__text-diff">{result.unifiedDiff}</pre>;
  }
  return (
    <p className="workspace-app__text-unavailable">
      {result.reason === "TOO_LARGE"
        ? "文件超过文本差异限制。"
        : result.reason === "NOT_TEXT"
          ? "文件不是有效的纯文本。"
          : "该路径没有可比较的文本修改。"}
    </p>
  );
}

function WorkspaceEntry({
  entry,
  onActivate,
}: {
  entry: FileEntry;
  onActivate: () => void;
}) {
  const content = (
    <>
      {entry.kind === "directory" ? (
        <span aria-hidden="true">📁</span>
      ) : (
        <EntryIdenticon entryId={entry.entryId} size={28} />
      )}
      <span>{entry.name}</span>
      <small>
        {entry.kind === "directory" ? "目录" : formatSize(entry.size ?? 0)}
      </small>
    </>
  );
  return (
    <button
      type="button"
      className={entry.kind === "file" ? "workspace-app__file" : undefined}
      onDoubleClick={onActivate}
    >
      {content}
    </button>
  );
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function changeLabel(change: "added" | "modified" | "deleted"): string {
  if (change === "added") return "新增";
  if (change === "modified") return "修改";
  return "删除";
}

function changeDetails(
  entry: WorkspaceDiff["changes"][number],
): string {
  const before = entry.before;
  const after = entry.after;
  if (!before && after) {
    return after.kind === "directory" ? "目录" : formatSize(after.size);
  }
  if (before && !after) {
    return before.kind === "directory" ? "目录" : formatSize(before.size);
  }
  if (!before || !after) return "";
  if (before.kind !== after.kind) {
    return `${before.kind === "directory" ? "目录" : "文件"} → ${
      after.kind === "directory" ? "目录" : "文件"
    }`;
  }
  if (after.kind === "directory") return "目录元数据变化";
  return `${formatSize(before.size)} → ${formatSize(after.size)}`;
}

function canShowTextDiff(
  entry: WorkspaceDiff["changes"][number],
): boolean {
  return (
    entry.change === "modified" &&
    entry.before?.kind === "file" &&
    entry.after?.kind === "file"
  );
}
