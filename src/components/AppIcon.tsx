import { useState } from "react";
import type { AppDefinition } from "../types/desktop";
import { DefaultAppIcon } from "./DefaultAppIcon";

interface AppIconProps {
  app: AppDefinition;
  compact?: boolean;
}

export function AppIcon({ app, compact = false }: AppIconProps) {
  const [failed, setFailed] = useState(false);

  if (failed || !app.icon) {
    return <DefaultAppIcon label={app.name} />;
  }

  return (
    <img
      className={compact ? "app-icon app-icon--compact" : "app-icon"}
      src={app.icon}
      alt=""
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}
