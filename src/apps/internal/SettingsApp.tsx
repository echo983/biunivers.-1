import { useMemo, useState, type FormEvent } from "react";
import { useDesktopStore } from "../../store/desktopStore";
import { DEFAULT_WALLPAPER } from "../../store/defaults";
import { clearLocalDesktopData } from "../../store/persistedState";
import { resetDesktopWindows } from "../../windows/windowController";
import { AppManagement } from "./AppManagement";
import { useDesktopSurfaceStore } from "../../desktopSurface/store";

function isWallpaperUrl(value: string) {
  if (value.startsWith("/") && !value.startsWith("//")) {
    return true;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function SettingsApp() {
  const configStatus = useDesktopStore((state) => state.configStatus);
  const configError = useDesktopStore((state) => state.configError);
  const configWarnings = useDesktopStore((state) => state.configWarnings);
  const appRegistry = useDesktopStore((state) => state.apps);
  const wallpaper = useDesktopStore((state) => state.wallpaper);
  const pinnedAppIds = useDesktopStore((state) => state.pinnedAppIds);
  const defaultResourceHandlers = useDesktopStore(
    (state) => state.defaultResourceHandlers,
  );
  const setWallpaper = useDesktopStore((state) => state.setWallpaper);
  const unpinApp = useDesktopStore((state) => state.unpinApp);
  const clearDefaultResourceHandler = useDesktopStore(
    (state) => state.clearDefaultResourceHandler,
  );
  const resetPinnedApps = useDesktopStore(
    (state) => state.resetPinnedApps,
  );
  const apps = useMemo(() => Object.values(appRegistry), [appRegistry]);
  const [wallpaperInput, setWallpaperInput] = useState(wallpaper);
  const [wallpaperError, setWallpaperError] = useState<string | null>(null);
  const desktopSurface = useDesktopSurfaceStore((state) => state.surface);
  const desktopSurfaceError = useDesktopSurfaceStore(
    (state) => state.error,
  );
  const removeDesktopItems = useDesktopSurfaceStore(
    (state) => state.remove,
  );
  const resetDesktopSurface = useDesktopSurfaceStore(
    (state) => state.reset,
  );

  const statusLabel = {
    loading: "正在加载",
    ready: "已就绪",
    error: "部分或全部应用来源加载失败",
  }[configStatus];

  const applyWallpaper = (event: FormEvent) => {
    event.preventDefault();
    const value = wallpaperInput.trim();
    if (!isWallpaperUrl(value)) {
      setWallpaperError("请输入同源路径或 HTTP(S) 图片地址");
      return;
    }
    setWallpaperError(null);
    setWallpaper(value);
  };

  return (
    <article className="settings-app">
      <header>
        <h1>设置</h1>
        <p>管理此浏览器中的个人桌面状态。</p>
      </header>

      <section>
        <h2>外观</h2>
        <form className="settings-app__wallpaper" onSubmit={applyWallpaper}>
          <label htmlFor="wallpaper-url">壁纸 URL</label>
          <div>
            <input
              id="wallpaper-url"
              value={wallpaperInput}
              onChange={(event) => setWallpaperInput(event.target.value)}
            />
            <button type="submit">应用</button>
          </div>
          {wallpaperError && <p role="alert">{wallpaperError}</p>}
        </form>
        <button
          type="button"
          onClick={() => {
            setWallpaperInput(DEFAULT_WALLPAPER);
            setWallpaperError(null);
            setWallpaper(DEFAULT_WALLPAPER);
          }}
        >
          恢复默认壁纸
        </button>
      </section>

      <section>
        <h2>任务栏</h2>
        {pinnedAppIds.length > 0 ? (
          <ul className="settings-app__app-list">
            {pinnedAppIds.map((appId) => (
              <li key={appId}>
                <span>{appRegistry[appId]?.name ?? appId}</span>
                <button type="button" onClick={() => unpinApp(appId)}>
                  取消固定
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p>当前没有固定应用。</p>
        )}
        <button
          type="button"
          onClick={() =>
            resetPinnedApps(
              apps.filter((app) => app.pinned).map((app) => app.id),
            )
          }
        >
          恢复配置默认固定状态
        </button>
      </section>

      <section>
        <h2>桌面</h2>
        {desktopSurface.items.length > 0 ? (
          <ul className="settings-app__app-list">
            {desktopSurface.items.map((item) => (
              <li key={item.id}>
                <span>
                  {item.resolved.name}
                  {!item.resolved.available && "（失效）"}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    void removeDesktopItems([item.id]).catch(
                      () => undefined,
                    )
                  }
                >
                  从桌面移除
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p>当前桌面没有项目。</p>
        )}
        {desktopSurfaceError && (
          <p className="settings-app__error" role="alert">
            {desktopSurfaceError}
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            if (window.confirm("恢复默认桌面项目和窗口状态？")) {
              void resetDesktopSurface().catch(() => undefined);
              queueMicrotask(resetDesktopWindows);
            }
          }}
        >
          恢复默认桌面状态
        </button>
      </section>

      <section>
        <h2>默认打开方式</h2>
        {Object.entries(defaultResourceHandlers).length > 0 ? (
          <ul className="settings-app__app-list">
            {Object.entries(defaultResourceHandlers).map(
              ([key, handler]) => {
                const [, extension, action] = key.split(":");
                return (
                  <li key={key}>
                    <span>
                      {extension} · {action === "edit" ? "编辑" : "打开"}
                      {" → "}
                      {appRegistry[handler.appId]?.name ?? handler.appId}
                    </span>
                    <button
                      type="button"
                      onClick={() => clearDefaultResourceHandler(key)}
                    >
                      清除默认
                    </button>
                  </li>
                );
              },
            )}
          </ul>
        ) : (
          <p>尚未设置默认打开方式。</p>
        )}
      </section>

      <AppManagement />

      <section>
        <h2>系统</h2>
        <dl>
          <div>
            <dt>版本</dt>
            <dd>0.1.0</dd>
          </div>
          <div>
            <dt>配置状态</dt>
            <dd>{statusLabel}</dd>
          </div>
          <div>
            <dt>应用数量</dt>
            <dd>{apps.length}</dd>
          </div>
        </dl>
        {configError && (
          <p className="settings-app__error" role="alert">
            {configError}
          </p>
        )}
        {configWarnings.length > 0 && (
          <div className="settings-app__warnings">
            <h3>配置警告</h3>
            <ul>
              {configWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}
        <button
          className="settings-app__danger"
          type="button"
          onClick={() => {
            if (window.confirm("确定清除所有本地桌面数据吗？")) {
              clearLocalDesktopData();
            }
          }}
        >
          清除所有本地桌面数据
        </button>
      </section>
    </article>
  );
}
