import { useDesktopStore } from "../store/desktopStore";
import type { AppDefinition } from "../types/desktop";

export function BwaInstanceApp({ app }: { app: AppDefinition }) {
  const active = useDesktopStore((state) => state.activeAppId === app.id);
  return (
    <div className="iframe-app">
      <div className="iframe-app__toolbar">
        <span>{app.name}</span>
        <span>Workspace Application</span>
      </div>
      <iframe
        className="app-iframe"
        src={app.url}
        title={app.name}
        allow="fullscreen"
        allowFullScreen
      />
      {!active && (
        <div
          className="iframe-app__activation-shield"
          aria-hidden="true"
        />
      )}
    </div>
  );
}
