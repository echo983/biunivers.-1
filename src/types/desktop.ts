export type AppKind = "internal" | "iframe" | "external";

export interface AppDefinition {
  id: string;
  name: string;
  kind: AppKind;
  icon: string;
  description?: string;
  url?: string;
  internalComponent?: string;
  defaultWidth: number;
  defaultHeight: number;
  minWidth?: number;
  minHeight?: number;
  desktop: boolean;
  pinned: boolean;
  trusted?: boolean;
}
