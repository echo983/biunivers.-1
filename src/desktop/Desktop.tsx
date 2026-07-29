import { useEffect } from "react";
import { bootstrapDesktop } from "../app/bootstrap";
import { useDesktopStore } from "../store/desktopStore";
import { AppMenu } from "./AppMenu";
import { DesktopIcons } from "./DesktopIcons";
import { Taskbar } from "./Taskbar";
import {
  clampOpenWindows,
  openApp,
} from "../windows/windowController";
import "./desktop.css";
import { useDesktopSurfaceStore } from "../desktopSurface/store";
import { ContextMenu } from "../components/ContextMenu";
import { useState } from "react";

export function Desktop() {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  }>();
  const wallpaper = useDesktopStore((state) => state.wallpaper);
  const configStatus = useDesktopStore((state) => state.configStatus);
  const configError = useDesktopStore((state) => state.configError);
  const closeAppMenu = useDesktopStore((state) => state.closeAppMenu);
  const clearSurfaceSelection = useDesktopSurfaceStore(
    (state) => state.clearSelection,
  );

  useEffect(() => {
    bootstrapDesktop();
  }, []);

  useEffect(() => {
    let timeoutId: number | undefined;
    const handleResize = () => {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(clampOpenWindows, 100);
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.clearTimeout(timeoutId);
    };
  }, []);

  const clearDesktopSelection = () => {
    clearSurfaceSelection();
    closeAppMenu();
    setContextMenu(undefined);
  };

  return (
    <main className="desktop" aria-label="个人桌面">
      <div
        className="wallpaper-layer"
        style={{ backgroundImage: `url("${wallpaper}")` }}
        aria-hidden="true"
      />
      <div
        className="desktop-icon-layer"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) {
            clearDesktopSelection();
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          closeAppMenu();
          setContextMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <DesktopIcons />
        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={() => setContextMenu(undefined)}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => setContextMenu(undefined)}
            >
              刷新
            </button>
          </ContextMenu>
        )}
      </div>
      <div className="window-layer" id="desktop-window-layer" />
      <div className="app-menu-layer">
        <AppMenu />
      </div>
      <Taskbar />
      {configStatus === "error" && (
        <button
          className="config-error-banner"
          type="button"
          onClick={() => {
            closeAppMenu();
            openApp("system.settings");
          }}
        >
          {configError ?? "应用配置加载失败"}。点击查看设置。
        </button>
      )}
      <div className="desktop-size-notice" role="status">
        当前版本建议使用桌面浏览器访问。
      </div>
    </main>
  );
}
