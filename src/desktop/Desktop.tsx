import { useEffect } from "react";
import { bootstrapDesktop } from "../app/bootstrap";
import { useDesktopStore } from "../store/desktopStore";
import { AppMenu } from "./AppMenu";
import { DesktopIcons } from "./DesktopIcons";
import { Taskbar } from "./Taskbar";
import { clampOpenWindows } from "../windows/windowController";
import "./desktop.css";

export function Desktop() {
  const wallpaper = useDesktopStore((state) => state.wallpaper);
  const closeAppMenu = useDesktopStore((state) => state.closeAppMenu);
  const selectDesktopApp = useDesktopStore(
    (state) => state.selectDesktopApp,
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
    selectDesktopApp(null);
    closeAppMenu();
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
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            clearDesktopSelection();
          }
        }}
      >
        <DesktopIcons />
      </div>
      <div className="window-layer" id="desktop-window-layer" />
      <div className="app-menu-layer">
        <AppMenu />
      </div>
      <Taskbar />
      <div className="desktop-size-notice" role="status">
        当前版本建议使用桌面浏览器访问。
      </div>
    </main>
  );
}
