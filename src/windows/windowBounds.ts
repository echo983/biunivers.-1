import type { AppDefinition } from "../types/desktop";
import type { WindowBounds } from "./windowTypes";

export const TASKBAR_HEIGHT = 48;
const MIN_VISIBLE_TITLE_WIDTH = 120;
const WINDOW_HEADER_HEIGHT = 35;

interface ViewportSize {
  width: number;
  height: number;
}

export function getAvailableViewport(): ViewportSize {
  return {
    width: document.documentElement.clientWidth,
    height: Math.max(
      WINDOW_HEADER_HEIGHT,
      document.documentElement.clientHeight - TASKBAR_HEIGHT,
    ),
  };
}

export function getInitialWindowBounds(
  app: AppDefinition,
  viewport = getAvailableViewport(),
): WindowBounds {
  const minWidth = Math.min(app.minWidth ?? 150, viewport.width);
  const minHeight = Math.min(
    app.minHeight ?? WINDOW_HEADER_HEIGHT,
    viewport.height,
  );
  const width = Math.max(
    minWidth,
    Math.min(app.defaultWidth, viewport.width),
  );
  const height = Math.max(
    minHeight,
    Math.min(app.defaultHeight, viewport.height),
  );

  return {
    x: Math.max(0, Math.round((viewport.width - width) / 2)),
    y: Math.max(0, Math.round((viewport.height - height) / 2)),
    width,
    height,
  };
}

export function clampWindowBounds(
  bounds: WindowBounds,
  viewport = getAvailableViewport(),
): WindowBounds {
  const width = Math.min(Math.max(bounds.width, MIN_VISIBLE_TITLE_WIDTH), viewport.width);
  const height = Math.min(
    Math.max(bounds.height, WINDOW_HEADER_HEIGHT),
    viewport.height,
  );
  const maxX = Math.max(0, viewport.width - MIN_VISIBLE_TITLE_WIDTH);
  const maxY = Math.max(0, viewport.height - WINDOW_HEADER_HEIGHT);

  return {
    x: Math.min(Math.max(bounds.x, 0), maxX),
    y: Math.min(Math.max(bounds.y, 0), maxY),
    width,
    height,
  };
}
