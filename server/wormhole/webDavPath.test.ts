import { describe, expect, it } from "vitest";
import { parseWebDavPath, webDavHref } from "./webDavPath.js";

describe("WebDAV paths", () => {
  it("round-trips Unicode names and collection hints", () => {
    const path = parseWebDavPath("/wormhole/webdav/%E8%B5%84%E6%96%99/a%20b/");
    expect(path).toEqual({
      segments: ["资料", "a b"],
      collectionHint: true,
    });
    expect(webDavHref(path.segments, true)).toBe(
      "/wormhole/webdav/%E8%B5%84%E6%96%99/a%20b/",
    );
  });

  it.each([
    "/elsewhere",
    "/wormhole/webdav/a%2Fb",
    "/wormhole/webdav/a%5Cb",
    "/wormhole/webdav/a//b",
    "/wormhole/webdav/%2E%2E",
    "/wormhole/webdav/e%CC%81",
  ])("rejects unsafe path %s", (value) => {
    expect(() => parseWebDavPath(value)).toThrow();
  });
});
