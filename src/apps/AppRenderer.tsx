import type { AppDefinition } from "../types/desktop";
import { AboutApp } from "./internal/AboutApp";
import { SettingsApp } from "./internal/SettingsApp";
import { IframeApp } from "./IframeApp";

interface AppRendererProps {
  app: AppDefinition;
}

export function AppRenderer({ app }: AppRendererProps) {
  if (app.kind === "internal" && app.internalComponent === "about") {
    return <AboutApp />;
  }

  if (app.kind === "internal" && app.internalComponent === "settings") {
    return <SettingsApp />;
  }

  if (app.kind === "iframe") {
    return <IframeApp app={app} />;
  }

  return (
    <div className="window-error" role="alert">
      应用“{app.name}”尚未在当前阶段接入。
    </div>
  );
}
