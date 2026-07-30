import { describe, expect, it } from "vitest";
import type { AppDefinition } from "../types/desktop";
import { mergeAppSources } from "./registry";

const legacyApp: AppDefinition = {
  id: "legacy.files",
  name: "Files",
  kind: "iframe",
  icon: "/icons/files.svg",
  url: "/services/files/",
  defaultWidth: 800,
  defaultHeight: 600,
  desktop: true,
  pinned: false,
  trusted: true,
};

const managedApp: AppDefinition = {
  ...legacyApp,
  id: "io.github.example.hello",
  name: "Hello",
  url: "http://localhost:8081/apps/io.github.example.hello/commit/index.html",
};

describe("mergeAppSources", () => {
  it("combines built-in, legacy and managed applications", () => {
    const warnings: string[] = [];
    const apps = mergeAppSources([legacyApp], [managedApp], warnings);

    expect(apps.map((app) => app.id)).toEqual([
      "system.files",
      "system.settings",
      "system.wormhole",
      "system.workspaces",
      "system.about",
      "legacy.files",
      "io.github.example.hello",
    ]);
    expect(warnings).toEqual([]);
  });

  it("preserves earlier sources when IDs conflict", () => {
    const warnings: string[] = [];
    const apps = mergeAppSources(
      [{ ...legacyApp, id: "system.settings" }],
      [{ ...managedApp, id: "legacy.files" }],
      warnings,
    );

    expect(apps.find((app) => app.id === "system.settings")?.kind).toBe(
      "internal",
    );
    expect(apps.find((app) => app.id === "legacy.files")?.name).toBe("Hello");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("传统配置");
  });

  it("does not allow runtime sources to replace the internal file manager", () => {
    const warnings: string[] = [];
    const apps = mergeAppSources(
      [{ ...legacyApp, id: "system.files" }],
      [{ ...managedApp, id: "system.files" }],
      warnings,
    );

    expect(apps.find((app) => app.id === "system.files")).toMatchObject({
      kind: "internal",
      name: "文件",
    });
    expect(warnings).toHaveLength(2);
  });
});
