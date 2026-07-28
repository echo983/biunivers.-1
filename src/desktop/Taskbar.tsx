import { useEffect, useMemo, useState } from "react";
import { AppIcon } from "../components/AppIcon";
import { useDesktopStore } from "../store/desktopStore";

function formatTime() {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}

export function Taskbar() {
  const toggleAppMenu = useDesktopStore((state) => state.toggleAppMenu);
  const appMenuOpen = useDesktopStore((state) => state.appMenuOpen);
  const appRegistry = useDesktopStore((state) => state.apps);
  const apps = useMemo(() => Object.values(appRegistry), [appRegistry]);
  const [time, setTime] = useState(formatTime);

  useEffect(() => {
    let intervalId: number | undefined;
    const delay = 60_000 - (Date.now() % 60_000);
    const timeoutId = window.setTimeout(() => {
      setTime(formatTime());
      intervalId = window.setInterval(() => setTime(formatTime()), 60_000);
    }, delay);

    return () => {
      window.clearTimeout(timeoutId);
      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
      }
    };
  }, []);

  const pinnedApps = apps.filter((app) => app.pinned);

  return (
    <footer className="taskbar">
      <button
        className="taskbar__start"
        data-app-menu-button
        data-active={appMenuOpen}
        type="button"
        aria-label="打开 App 菜单"
        aria-expanded={appMenuOpen}
        onClick={toggleAppMenu}
      >
        <span aria-hidden="true">◆</span>
      </button>
      <div className="taskbar__apps" aria-label="固定应用">
        {pinnedApps.map((app) => (
          <button
            className="taskbar__app"
            key={app.id}
            type="button"
            title={app.name}
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent("desktop:open-placeholder", {
                  detail: `${app.name} 将在窗口阶段接入`,
                }),
              );
            }}
          >
            <AppIcon app={app} compact />
          </button>
        ))}
      </div>
      <time className="taskbar__clock">{time}</time>
    </footer>
  );
}
