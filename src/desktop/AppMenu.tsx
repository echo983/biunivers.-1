import { useEffect, useMemo, useRef, useState } from "react";
import { AppIcon } from "../components/AppIcon";
import { ContextMenu } from "../components/ContextMenu";
import { useDesktopStore } from "../store/desktopStore";
import { openApp } from "../windows/windowController";
import { useDesktopSurfaceStore } from "../desktopSurface/store";

interface AppContextMenu {
  appId: string;
  x: number;
  y: number;
}

export function AppMenu() {
  const appMenuOpen = useDesktopStore((state) => state.appMenuOpen);
  const closeAppMenu = useDesktopStore((state) => state.closeAppMenu);
  const appRegistry = useDesktopStore((state) => state.apps);
  const pinnedAppIds = useDesktopStore((state) => state.pinnedAppIds);
  const pinApp = useDesktopStore((state) => state.pinApp);
  const unpinApp = useDesktopStore((state) => state.unpinApp);
  const apps = useMemo(() => Object.values(appRegistry), [appRegistry]);
  const desktopItems = useDesktopSurfaceStore(
    (state) => state.surface.items,
  );
  const addDesktopItem = useDesktopSurfaceStore((state) => state.add);
  const removeDesktopItems = useDesktopSurfaceStore(
    (state) => state.remove,
  );
  const [query, setQuery] = useState("");
  const [contextMenu, setContextMenu] = useState<AppContextMenu>();
  const [contextError, setContextError] = useState<string>();
  const [contextWorking, setContextWorking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!appMenuOpen) return;
    inputRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (contextMenu) {
          setContextMenu(undefined);
          setContextError(undefined);
        } else {
          closeAppMenu();
        }
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !menuRef.current?.contains(target)) {
        const startButton = document.querySelector("[data-app-menu-button]");
        if (!startButton?.contains(target)) closeAppMenu();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [appMenuOpen, closeAppMenu, contextMenu]);

  const visibleApps = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return apps
      .filter(
        (app) =>
          !normalizedQuery ||
          app.name.toLocaleLowerCase().includes(normalizedQuery) ||
          app.id.toLocaleLowerCase().includes(normalizedQuery),
      )
      .sort((left, right) => {
        const leftPinned = pinnedAppIds.includes(left.id);
        const rightPinned = pinnedAppIds.includes(right.id);
        if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
  }, [apps, pinnedAppIds, query]);

  const openContextMenu = (
    appId: string,
    x: number,
    y: number,
  ) => {
    setContextError(undefined);
    setContextMenu({ appId, x, y });
  };

  const runDesktopAction = async (
    operation: () => Promise<void>,
  ) => {
    if (contextWorking) return;
    setContextWorking(true);
    setContextError(undefined);
    try {
      await operation();
      setContextMenu(undefined);
    } catch (error) {
      setContextError(
        error instanceof Error ? error.message : "应用管理操作失败",
      );
    } finally {
      setContextWorking(false);
    }
  };

  if (!appMenuOpen) return null;

  const contextApp = contextMenu
    ? appRegistry[contextMenu.appId]
    : undefined;
  const desktopItem = contextApp
    ? desktopItems.find(
        (item) =>
          item.target.type === "app" &&
          item.target.handle === contextApp.id,
      )
    : undefined;
  const pinned = contextApp
    ? pinnedAppIds.includes(contextApp.id)
    : false;

  return (
    <div
      className="app-menu"
      ref={menuRef}
      role="dialog"
      aria-label="App 菜单"
    >
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
          <div role="listitem" key={app.id}>
            <button
              className="app-menu__item"
              type="button"
              onClick={() => {
                closeAppMenu();
                openApp(app.id);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                openContextMenu(app.id, event.clientX, event.clientY);
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "ContextMenu" ||
                  (event.shiftKey && event.key === "F10")
                ) {
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  openContextMenu(app.id, rect.left + 20, rect.top + 20);
                }
              }}
            >
              <AppIcon app={app} compact />
              <span>{app.name}</span>
            </button>
          </div>
        ))}
        {visibleApps.length === 0 && (
          <p className="app-menu__empty">没有匹配的应用</p>
        )}
      </div>
      {contextMenu && contextApp && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => {
            setContextMenu(undefined);
            setContextError(undefined);
          }}
        >
          <button
            type="button"
            role="menuitem"
            disabled={contextWorking}
            onClick={() =>
              void runDesktopAction(() =>
                desktopItem
                  ? removeDesktopItems([desktopItem.id])
                  : addDesktopItem({
                      type: "app",
                      handle: contextApp.id,
                    }),
              )
            }
          >
            {desktopItem ? "从桌面移除" : "添加到桌面"}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={contextWorking}
            onClick={() => {
              if (pinned) unpinApp(contextApp.id);
              else pinApp(contextApp.id);
              setContextMenu(undefined);
              setContextError(undefined);
            }}
          >
            {pinned ? "从任务栏移除" : "添加到任务栏"}
          </button>
          {contextError && (
            <p className="context-menu__error" role="alert">
              {contextError}
            </p>
          )}
        </ContextMenu>
      )}
    </div>
  );
}
