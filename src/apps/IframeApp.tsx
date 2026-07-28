import type { AppDefinition } from "../types/desktop";
import { openExternalApp } from "./openExternalApp";

interface IframeAppProps {
  app: AppDefinition;
}

export function IframeApp({ app }: IframeAppProps) {
  if (!app.url) {
    return (
      <div className="window-error" role="alert">
        应用缺少 URL，无法启动。
      </div>
    );
  }

  return (
    <div className="iframe-app">
      <div className="iframe-app__toolbar">
        <span title={app.url}>{app.name}</span>
        <button type="button" onClick={() => openExternalApp(app.url!)}>
          在新标签页打开
        </button>
      </div>
      <iframe className="app-iframe" src={app.url} title={app.name} />
    </div>
  );
}
