import { useDesktopStore } from "../../store/desktopStore";

export function SettingsApp() {
  const configStatus = useDesktopStore((state) => state.configStatus);
  const configError = useDesktopStore((state) => state.configError);
  const configWarnings = useDesktopStore((state) => state.configWarnings);
  const appCount = useDesktopStore(
    (state) => Object.keys(state.apps).length,
  );

  const statusLabel = {
    loading: "正在加载",
    ready: "已就绪",
    error: "加载失败，正在使用内建应用",
  }[configStatus];

  return (
    <article className="settings-app">
      <header>
        <h1>设置</h1>
        <p>桌面设置功能将在后续阶段逐步启用。</p>
      </header>
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
            <dd>{appCount}</dd>
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
      </section>
    </article>
  );
}
