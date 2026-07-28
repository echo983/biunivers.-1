import type { AppDefinition } from "../types/desktop";

export const DEFAULT_WALLPAPER = "/wallpapers/default.svg";

export const defaultApps: AppDefinition[] = [
  {
    id: "system.settings",
    name: "设置",
    kind: "internal",
    icon: "/icons/settings.svg",
    description: "管理桌面设置",
    defaultWidth: 640,
    defaultHeight: 480,
    minWidth: 480,
    minHeight: 360,
    desktop: false,
    pinned: false,
  },
  {
    id: "system.about",
    name: "关于",
    kind: "internal",
    icon: "/icons/about.svg",
    description: "查看桌面版本和基本信息",
    defaultWidth: 560,
    defaultHeight: 420,
    minWidth: 420,
    minHeight: 320,
    desktop: true,
    pinned: false,
  },
];
