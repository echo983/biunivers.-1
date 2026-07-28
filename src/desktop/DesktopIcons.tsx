import { useMemo } from "react";
import { useDesktopStore } from "../store/desktopStore";
import { AppIcon } from "../components/AppIcon";
import { openApp } from "../windows/windowController";

export function DesktopIcons() {
  const appRegistry = useDesktopStore((state) => state.apps);
  const apps = useMemo(() => Object.values(appRegistry), [appRegistry]);
  const selectedAppId = useDesktopStore(
    (state) => state.selectedDesktopAppId,
  );
  const selectDesktopApp = useDesktopStore(
    (state) => state.selectDesktopApp,
  );
  const closeAppMenu = useDesktopStore((state) => state.closeAppMenu);

  const desktopApps = apps.filter((app) => app.desktop);

  const launchApp = (appId: string) => {
    closeAppMenu();
    openApp(appId);
  };

  return (
    <div className="desktop-icons" role="group" aria-label="桌面应用">
      {desktopApps.map((app) => (
        <button
          className="desktop-icon"
          data-selected={selectedAppId === app.id}
          key={app.id}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            selectDesktopApp(app.id);
          }}
          onDoubleClick={() => launchApp(app.id)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              launchApp(app.id);
            }
          }}
        >
          <AppIcon app={app} />
          <span className="desktop-icon__label">{app.name}</span>
        </button>
      ))}
    </div>
  );
}
