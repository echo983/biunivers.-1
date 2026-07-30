import { useEffect, useMemo, useState } from "react";
import {
  closeHostInstance,
  createHostInstance,
} from "../../hostApi/instanceClient";
import {
  disableWormhole,
  enableWormhole,
  getWormholeStatus,
  rotateWormhole,
  type WormholeStatus,
} from "../../api/wormholeClient";

type ViewState =
  | { mode: "loading" }
  | { mode: "unavailable" }
  | { mode: "error"; message: string }
  | { mode: "ready"; token: string; status: WormholeStatus };

export function WormholeApp() {
  const [state, setState] = useState<ViewState>({ mode: "loading" });
  const [syncDirection, setSyncDirection] = useState<"download" | "upload">(
    "download",
  );
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let token: string | undefined;
    void createHostInstance("system.wormhole", crypto.randomUUID(), controller.signal)
      .then(async (instance) => {
        if (!instance || controller.signal.aborted) {
          if (instance) void closeHostInstance(instance.instanceToken);
          if (!controller.signal.aborted) setState({ mode: "unavailable" });
          return;
        }
        token = instance.instanceToken;
        const status = await getWormholeStatus(token);
        if (!controller.signal.aborted) {
          setState({ mode: "ready", token, status });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({
            mode: "error",
            message: error instanceof Error ? error.message : "Wormhole 初始化失败",
          });
        }
      });
    return () => {
      controller.abort();
      if (token) void closeHostInstance(token);
    };
  }, []);

  const commands = useMemo(() => {
    if (state.mode !== "ready" || !state.status.enabled) return undefined;
    const url = `${location.origin}${state.status.path}`;
    const env = `RCLONE_CONFIG_WORMHOLE_TYPE=webdav RCLONE_CONFIG_WORMHOLE_URL='${url}' RCLONE_CONFIG_WORMHOLE_VENDOR=rclone RCLONE_CONFIG_WORMHOLE_USER=${state.status.username} RCLONE_CONFIG_WORMHOLE_PASS="$(rclone obscure '${state.status.password}')"`;
    const mount = `mkdir -p "$HOME/Biunivers" && ${env} rclone mount wormhole: "$HOME/Biunivers" --vfs-cache-mode writes --daemon`;
    const endpoints =
      syncDirection === "download"
        ? `wormhole: "$HOME/Biunivers-Sync"`
        : `"$HOME/Biunivers-Sync" wormhole:`;
    const sync = `mkdir -p "$HOME/Biunivers-Sync" && ${env} rclone sync --interactive --progress --create-empty-src-dirs ${endpoints}`;
    return { url, mount, sync };
  }, [state, syncDirection]);

  if (state.mode === "loading") return <div className="window-loading">正在连接 Wormhole…</div>;
  if (state.mode === "unavailable") return <div className="window-error">当前宿主尚未启用文件能力。</div>;
  if (state.mode === "error") return <div className="window-error">{state.message}</div>;

  const change = async (action: "enable" | "rotate" | "disable") => {
    setNotice("");
    try {
      const status =
        action === "enable"
          ? await enableWormhole(state.token)
          : action === "rotate"
            ? await rotateWormhole(state.token)
            : await disableWormhole(state.token);
      setState({ ...state, status });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作失败");
    }
  };
  const copy = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value);
    setNotice(`已复制${label}`);
  };

  return (
    <main className="wormhole-app">
      <header>
        <div>
          <h1>Wormhole</h1>
          <p>在其他电脑上挂载或同步 Biunivers 文件。它是按需传输通道，不会在后台实时同步。</p>
        </div>
        <button
          className={state.status.enabled ? "is-enabled" : ""}
          onClick={() => void change(state.status.enabled ? "disable" : "enable")}
        >
          {state.status.enabled ? "关闭" : "开启"}
        </button>
      </header>
      {notice && <p className="wormhole-app__notice">{notice}</p>}
      {state.status.enabled && commands ? (
        <>
          <section>
            <h2>连接信息</h2>
            <p className="wormhole-app__warning">
              公网连接必须使用 HTTPS；HTTP 只适合可信本机或隔离局域网测试。
            </p>
            <dl>
              <div><dt>地址</dt><dd>{commands.url}</dd></div>
              <div><dt>用户名</dt><dd>{state.status.username}</dd></div>
              <div><dt>密码</dt><dd><code>{state.status.password}</code></dd></div>
            </dl>
            <div className="wormhole-app__actions">
              <button onClick={() => void copy(commands.url, "地址")}>复制地址</button>
              <button onClick={() => void copy(state.status.password!, "密码")}>复制密码</button>
              <button onClick={() => void change("rotate")}>更换密码</button>
            </div>
          </section>
          <section>
            <h2>Linux / macOS · Mount</h2>
            <Command value={commands.mount} onCopy={copy} label="Mount 命令" />
          </section>
          <section>
            <h2>Linux / macOS · Sync</h2>
            <label>
              方向
              <select value={syncDirection} onChange={(event) => setSyncDirection(event.target.value as "download" | "upload")}>
                <option value="download">Biunivers → 本地</option>
                <option value="upload">本地 → Biunivers</option>
              </select>
            </label>
            <p className="wormhole-app__warning">sync 会删除目标端多余文件；执行前请确认交互式预览。</p>
            <Command value={commands.sync} onCopy={copy} label="Sync 命令" />
          </section>
          <section>
            <h2>Windows</h2>
            <p>在文件资源管理器中添加网络位置，地址填写上方地址，使用显示的用户名和密码。大文件建议使用 rclone。</p>
          </section>
        </>
      ) : (
        <section className="wormhole-app__closed">
          <p>Wormhole 已关闭。开启时将生成一个新的随机 10 位密码；宿主重启后也会自动关闭。</p>
        </section>
      )}
    </main>
  );
}

function Command({
  value,
  onCopy,
  label,
}: {
  value: string;
  onCopy(value: string, label: string): Promise<void>;
  label: string;
}) {
  return (
    <div className="wormhole-app__command">
      <code>{value}</code>
      <button onClick={() => void onCopy(value, label)}>复制</button>
    </div>
  );
}
