import { useEffect, useMemo, useRef, useState } from "react";
import { AppIcon } from "../components/AppIcon";
import { useDesktopStore } from "../store/desktopStore";
import { openApp } from "../windows/windowController";
import { useDesktopSurfaceStore } from "../desktopSurface/store";

export function AppMenu() {
  const appMenuOpen = useDesktopStore((state) => state.appMenuOpen);
  const closeAppMenu = useDesktopStore((state) => state.closeAppMenu);
  const appRegistry = useDesktopStore((state) => state.apps);
  const apps = useMemo(() => Object.values(appRegistry), [appRegistry]);
  const desktopItems = useDesktopSurfaceStore(
    (state) => state.surface.items,
  );
  const addDesktopItem = useDesktopSurfaceStore((state) => state.add);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!appMenuOpen) {
      return;
    }

    inputRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeAppMenu();
      }
    };

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !menuRef.current?.contains(target)) {
        const startButton = document.querySelector("[data-app-menu-button]");
        if (!startButton?.contains(target)) {
          closeAppMenu();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [appMenuOpen, closeAppMenu]);

  const visibleApps = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();

    return apps
      .filter((app) => {
        if (!normalizedQuery) {
          return true;
        }

        return (
          app.name.toLocaleLowerCase().includes(normalizedQuery) ||
          app.id.toLocaleLowerCase().includes(normalizedQuery)
        );
      })
      .sort((left, right) => {
        if (left.pinned !== right.pinned) {
          return left.pinned ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });
  }, [apps, query]);

  if (!appMenuOpen) {
    return null;
  }

  return (
    <div className="app-menu" ref={menuRef} role="dialog" aria-label="App 菜单">
      <label className="app-menu__search">
        <span className="sr-only">搜索应用</span>
        <input
          ref={inputRef}
          value={query}
          type="search"
          placeholder="搜索应用"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="app-menu__list" role="list">
        {visibleApps.map((app) => (
          <div className="app-menu__row" role="listitem" key={app.id}>
            <button
              className="app-menu__item"
              type="button"
              onClick={() => {
                closeAppMenu();
                openApp(app.id);
              }}
            >
              <AppIcon app={app} compact />
              <span>{app.name}</span>
            </button>
            <button
              className="app-menu__desktop-action"
              type="button"
              aria-label={`将“${app.name}”添加到桌面`}
              title={
                desktopItems.some(
                  (item) =>
                    item.target.type === "app" &&
                    item.target.handle === app.id,
                )
                  ? "已在桌面"
                  : "添加到桌面"
              }
              disabled={desktopItems.some(
                (item) =>
                  item.target.type === "app" &&
                  item.target.handle === app.id,
              )}
              onClick={() =>
                void addDesktopItem({
                  type: "app",
                  handle: app.id,
                }).catch(() => undefined)
              }
            >
              ＋
            </button>
          </div>
        ))}
        {visibleApps.length === 0 && (
          <p className="app-menu__empty">没有匹配的应用</p>
        )}
      </div>
    </div>
  );
}
