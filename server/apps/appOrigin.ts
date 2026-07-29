import { createHash } from "node:crypto";

export function appOriginLabel(appId: string): string {
  const digest = createHash("sha256")
    .update(appId, "utf8")
    .digest("hex")
    .slice(0, 40);
  return `app-${digest}`;
}

export function appSpecificOrigin(baseOrigin: string, appId: string): string {
  const url = new URL(baseOrigin);
  url.hostname = `${appOriginLabel(appId)}.${url.hostname}`;
  return url.origin;
}

export function requestHostMatchesApp(
  requestHost: string | undefined,
  baseOrigin: string,
  appId: string,
): boolean {
  if (!requestHost) {
    return false;
  }
  return requestHost.toLowerCase() ===
    new URL(appSpecificOrigin(baseOrigin, appId)).host.toLowerCase();
}
