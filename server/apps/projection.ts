import type { InstalledAppRecord } from "./appStore.js";

function appUrl(
  appOrigin: string,
  installed: InstalledAppRecord,
  path: string,
) {
  const base = `${appOrigin}/apps/${encodeURIComponent(installed.appId)}/${encodeURIComponent(installed.commitSha)}/`;
  return new URL(path, base).toString();
}

export function projectInstalledApp(
  installed: InstalledAppRecord,
  appOrigin: string,
) {
  const { manifest } = installed;
  return {
    id: installed.appId,
    name: manifest.name,
    kind: "iframe" as const,
    icon: appUrl(appOrigin, installed, manifest.icon),
    description: manifest.description,
    url: appUrl(appOrigin, installed, "index.html"),
    defaultWidth: manifest.window.defaultWidth,
    defaultHeight: manifest.window.defaultHeight,
    minWidth: manifest.window.minWidth,
    minHeight: manifest.window.minHeight,
    desktop: manifest.window.desktop ?? true,
    pinned: manifest.window.pinned ?? false,
    trusted: true as const,
  };
}
