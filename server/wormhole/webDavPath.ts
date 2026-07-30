import { validateEntryName } from "../files/entryName.js";

export const WORMHOLE_PATH = "/wormhole/webdav/";

export interface WebDavPath {
  segments: string[];
  collectionHint: boolean;
}

export function parseWebDavPath(rawUrl: string): WebDavPath {
  const rawPath = rawUrl.split("?", 1)[0];
  const acceptedRoot = WORMHOLE_PATH.slice(0, -1);
  if (rawPath !== acceptedRoot && !rawPath.startsWith(WORMHOLE_PATH)) {
    throw new WebDavPathError("Path is outside the Wormhole root.");
  }
  const relative =
    rawPath === acceptedRoot ? "" : rawPath.slice(WORMHOLE_PATH.length);
  if (/%2f|%5c/i.test(relative) || relative.includes("\\")) {
    throw new WebDavPathError("Encoded path separators are not allowed.");
  }
  const collectionHint = relative === "" || relative.endsWith("/");
  const encodedSegments = relative.split("/");
  if (collectionHint) encodedSegments.pop();
  const segments = encodedSegments.map((encoded) => {
    if (!encoded) throw new WebDavPathError("Empty path segment.");
    let value: string;
    try {
      value = decodeURIComponent(encoded);
    } catch {
      throw new WebDavPathError("Path contains invalid percent encoding.");
    }
    if (
      value === "." ||
      value === ".." ||
      value.includes("/") ||
      value.includes("\\") ||
      value.normalize("NFC") !== value
    ) {
      throw new WebDavPathError("Path segment is invalid.");
    }
    try {
      validateEntryName(value);
    } catch {
      throw new WebDavPathError("Path segment is invalid.");
    }
    return value;
  });
  return { segments, collectionHint };
}

export function webDavHref(segments: readonly string[], directory: boolean) {
  const suffix = segments.map((segment) => encodeURIComponent(segment)).join("/");
  return `${WORMHOLE_PATH}${suffix}${directory && suffix ? "/" : ""}`;
}

export class WebDavPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebDavPathError";
  }
}
