import { useMemo } from "react";
import { useDesktopStore } from "../store/desktopStore";
import { AppIcon } from "../components/AppIcon";

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

  const openPlaceholder = (appName: string) => {
    closeAppMenu();
    window.dispatchEvent(
      new CustomEvent("desktop:open-placeholder", {
        detail: `${appName} 将在窗口阶段接入`,
      }),
    );
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
          onDoubleClick={() => openPlaceholder(app.name)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              openPlaceholder(app.name);
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
