import { useState } from "react";
import type { AppDefinition, WindowState } from "../types/desktop";
import { AppIcon } from "../components/AppIcon";
import { ContextMenu } from "../components/ContextMenu";
import {
  activateTaskbarApp,
  closeApp,
} from "../windows/windowController";
import { useDesktopStore } from "../store/desktopStore";

interface TaskbarItemProps {
  app: AppDefinition;
  windowState?: WindowState;
  pinned: boolean;
}

interface MenuPosition {
  x: number;
  y: number;
}

export function TaskbarItem({
  app,
  windowState,
  pinned,
}: TaskbarItemProps) {
  const pinApp = useDesktopStore((state) => state.pinApp);
  const unpinApp = useDesktopStore((state) => state.unpinApp);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);

  return (
    <>
      <button
        className="taskbar__app"
        data-running={Boolean(windowState)}
        data-active={Boolean(windowState?.active)}
        data-hidden={Boolean(windowState?.hidden)}
        type="button"
        title={app.name}
        aria-label={app.name}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => activateTaskbarApp(app.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenuPosition({ x: event.clientX, y: event.clientY });
        }}
      >
        <AppIcon app={app} compact />
      </button>
      {menuPosition && (
        <ContextMenu
          x={menuPosition.x}
          y={menuPosition.y}
          onClose={() => setMenuPosition(null)}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              if (pinned) {
                unpinApp(app.id);
              } else {
                pinApp(app.id);
              }
              setMenuPosition(null);
            }}
          >
            {pinned ? "从任务栏移除" : "添加到任务栏"}
          </button>
          {windowState && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeApp(app.id);
                setMenuPosition(null);
              }}
            >
              关闭应用
            </button>
          )}
        </ContextMenu>
      )}
    </>
  );
}
