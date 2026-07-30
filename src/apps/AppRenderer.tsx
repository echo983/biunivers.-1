import type { AppDefinition } from "../types/desktop";
import { AboutApp } from "./internal/AboutApp";
import { SettingsApp } from "./internal/SettingsApp";
import { FileManagerApp } from "./internal/FileManagerApp";
import { IframeApp } from "./IframeApp";
import { WormholeApp } from "./internal/WormholeApp";

interface AppRendererProps {
  app: AppDefinition;
}

export function AppRenderer({ app }: AppRendererProps) {
  if (app.kind === "internal" && app.id === "system.about") {
    return <AboutApp />;
  }

  if (app.kind === "internal" && app.id === "system.settings") {
    return <SettingsApp />;
  }

  if (app.kind === "internal" && app.id === "system.files") {
    return <FileManagerApp />;
  }

  if (app.kind === "internal" && app.id === "system.wormhole") {
    return <WormholeApp />;
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
