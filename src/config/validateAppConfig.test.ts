import { describe, expect, it } from "vitest";
import { validateAppConfig } from "./validateAppConfig";

const validIframe = {
  id: "files",
  name: "文件",
  kind: "iframe",
  icon: "/icons/files.svg",
  url: "/services/files/",
  defaultWidth: 1000,
  defaultHeight: 700,
  minWidth: 600,
  minHeight: 400,
  desktop: true,
  pinned: true,
  trusted: true,
};

describe("validateAppConfig", () => {
  it("accepts valid entries and keeps the first duplicate ID", () => {
    const result = validateAppConfig([validIframe, validIframe]);

    expect(result.apps).toHaveLength(1);
    expect(result.apps[0].id).toBe("files");
    expect(result.warnings[0]).toContain("重复");
  });

  it("keeps valid entries when another entry is invalid", () => {
    const result = validateAppConfig([
      validIframe,
      { ...validIframe, id: "Bad ID", trusted: false },
    ]);

    expect(result.apps).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("id");
    expect(result.warnings[0]).toContain("trusted");
  });

  it("rejects an invalid top-level value", () => {
    const result = validateAppConfig({ apps: [] });

    expect(result.fatalError).toContain("顶层必须是数组");
    expect(result.apps).toEqual([]);
  });

  it("validates kind-specific required fields", () => {
    const result = validateAppConfig([
      { ...validIframe, url: "javascript:alert(1)" },
      {
        ...validIframe,
        id: "system.unknown",
        kind: "internal",
      },
      {
        ...validIframe,
        id: "website",
        kind: "external",
        url: "https://example.com",
        trusted: undefined,
      },
    ]);

    expect(result.apps.map((app) => app.id)).toEqual(["website"]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[1]).toContain("internal 仅允许编译期注册");
  });

  it("accepts resource handlers only from the managed source", () => {
    const resourceHandlers = [
      {
        id: "text-editor",
        actions: ["open", "edit"],
        extensions: [".txt"],
        access: "read-write",
      },
    ];

    expect(
      validateAppConfig([{ ...validIframe, resourceHandlers }]).apps[0]
        .resourceHandlers,
    ).toBeUndefined();
    expect(
      validateAppConfig(
        [{ ...validIframe, resourceHandlers }],
        { allowResourceHandlers: true },
      ).apps[0].resourceHandlers,
    ).toEqual(resourceHandlers);
  });
});
