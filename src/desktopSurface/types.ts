export type DesktopTargetType = "app" | "file" | "directory";

export interface DesktopTarget {
  type: DesktopTargetType;
  handle: string;
}

export interface DesktopPosition {
  x: number;
  y: number;
}

export interface DesktopItem {
  id: string;
  target: DesktopTarget;
  position: DesktopPosition;
  createdAtMs: number;
  resolved: {
    available: boolean;
    name: string;
    kind: DesktopTargetType;
    icon?: string;
    reason?: string;
    fileRevision?: number;
  };
}

export interface DesktopSurface {
  schemaVersion: 1;
  revision: number;
  items: DesktopItem[];
}
