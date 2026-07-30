import { useCallback, useEffect, useState } from "react";
import {
  closeHostInstance,
  createHostInstance,
} from "../../hostApi/instanceClient";
import type { DirectoryListing, FileEntry } from "../../hostApi/fileHostClient";
import {
  deleteWorkspace,
  listWorkspaceFiles,
  listWorkspaces,
  setWorkspaceRetention,
  type WorkspaceSummary,
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
            <nav aria-label="工作空间路径">
              <button type="button" onClick={() => setDirectoryId(undefined)}>
                /
              </button>
              {listing?.breadcrumbs?.map((entry) => (
                <span key={entry.entryId}>
                  {" / "}
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
                  onOpen={() =>
                    entry.kind === "directory" &&
                    setDirectoryId(entry.entryId)
                  }
                />
              ))}
            </div>
          </>
        ) : (
          <p className="workspace-app__empty">选择一个工作空间查看内容。</p>
        )}
      </main>
    </article>
  );
}

function WorkspaceEntry({
  entry,
  onOpen,
}: {
  entry: FileEntry;
  onOpen: () => void;
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
  if (entry.kind === "file") {
    return <div className="workspace-app__file">{content}</div>;
  }
  return (
    <button
      type="button"
      onDoubleClick={onOpen}
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
