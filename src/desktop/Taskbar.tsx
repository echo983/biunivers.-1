import { useEffect, useMemo, useState } from "react";
import { useDesktopStore } from "../store/desktopStore";
import { TaskbarItem } from "./TaskbarItem";

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
  const windows = useDesktopStore((state) => state.windows);
  const pinnedAppIds = useDesktopStore((state) => state.pinnedAppIds);
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

  const taskbarApps = useMemo(() => {
    const ids = [
      ...pinnedAppIds,
      ...Object.keys(windows).filter((id) => !pinnedAppIds.includes(id)),
    ];
    return ids
      .map((id) => appRegistry[id])
      .filter((app): app is NonNullable<typeof app> => Boolean(app));
  }, [appRegistry, pinnedAppIds, windows]);

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
        {taskbarApps.map((app) => (
          <TaskbarItem
            key={app.id}
            app={app}
            windowState={windows[app.id]}
            pinned={pinnedAppIds.includes(app.id)}
          />
        ))}
      </div>
      <time className="taskbar__clock">{time}</time>
    </footer>
  );
}
