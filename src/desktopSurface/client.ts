import type {
  DesktopPosition,
  DesktopSurface,
  DesktopTarget,
} from "./types";

export class DesktopSurfaceClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DesktopSurfaceClientError";
  }
}

export function readDesktopSurface() {
  return request<DesktopSurface>("/api/v1/desktop-surface/resolve", {
    method: "POST",
  });
}

export function addDesktopItem(
  target: DesktopTarget,
  position: DesktopPosition,
  expectedRevision: number,
) {
  return mutate("/api/v1/desktop-surface/items", "POST", {
    target,
    position,
    expectedRevision,
  });
}

export function moveDesktopItems(
  moves: Array<{ itemId: string; position: DesktopPosition }>,
  expectedRevision: number,
) {
  return mutate("/api/v1/desktop-surface/layout", "PATCH", {
    moves,
    expectedRevision,
  });
}

export function removeDesktopItems(
  itemIds: string[],
  expectedRevision: number,
) {
  return mutate("/api/v1/desktop-surface/items", "DELETE", {
    itemIds,
    expectedRevision,
  });
}

export function resetDesktopSurface(expectedRevision: number) {
  return mutate("/api/v1/desktop-surface/reset", "POST", {
    expectedRevision,
  });
}

async function mutate(
  path: string,
  method: string,
  body: unknown,
): Promise<DesktopSurface> {
  await request(path, {
    method,
    body: JSON.stringify(body),
  });
  return readDesktopSurface();
}

async function request<T>(
  path: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...init.headers,
      "Content-Type": "application/json",
    },
  });
  const value = (await response.json()) as T & {
    error?: { code?: string; message?: string };
  };
  if (!response.ok) {
    throw new DesktopSurfaceClientError(
      value.error?.code ?? "DESKTOP_SURFACE_FAILED",
      value.error?.message ??
        `桌面项目服务请求失败：HTTP ${response.status}`,
    );
  }
  return value;
}
