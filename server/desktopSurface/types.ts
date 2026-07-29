export type DesktopTargetType = "app" | "file" | "directory";

export interface DesktopTarget {
  type: DesktopTargetType;
  handle: string;
}

export interface DesktopPosition {
  column: number;
  row: number;
}

export interface DesktopItem {
  id: string;
  target: DesktopTarget;
  position: DesktopPosition;
  createdAtMs: number;
}

export interface DesktopSurface {
  schemaVersion: 1;
  revision: number;
  items: DesktopItem[];
}

export interface ResolvedDesktopItem extends DesktopItem {
  resolved: {
    available: boolean;
    name: string;
    kind: DesktopTargetType;
    icon?: string;
    reason?: string;
    fileRevision?: number;
  };
}
