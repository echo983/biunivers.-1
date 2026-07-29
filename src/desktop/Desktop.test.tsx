import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultApps } from "../store/defaults";
import { useDesktopStore } from "../store/desktopStore";
import { useDesktopSurfaceStore } from "../desktopSurface/store";
import { Desktop } from "./Desktop";

describe("Desktop", () => {
  beforeEach(() => {
    useDesktopStore.setState({
      apps: Object.fromEntries(defaultApps.map((app) => [app.id, app])),
      appMenuOpen: false,
      selectedDesktopAppId: null,
      pinnedAppIds: defaultApps
        .filter((app) => app.pinned)
        .map((app) => app.id),
    });
    useDesktopSurfaceStore.setState({
      status: "ready",
      surface: {
        schemaVersion: 1,
        revision: 1,
        items: [
          {
            id: "11".repeat(16),
            target: { type: "app", handle: "system.about" },
            position: { x: 0, y: 0 },
            createdAtMs: 1,
            resolved: {
              available: true,
              kind: "app",
              name: "关于",
              icon: "/icons/about.svg",
            },
          },
        ],
      },
      selectedItemIds: new Set(),
      error: undefined,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/v1/desktop-surface/resolve")) {
          return new Response(
            JSON.stringify(useDesktopSurfaceStore.getState().surface),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("Not found", { status: 404 });
      }),
    );
  });

  it("opens, searches, and closes the app menu", async () => {
    const user = userEvent.setup();
    render(<Desktop />);

    await user.click(screen.getByRole("button", { name: "打开 App 菜单" }));
    const search = screen.getByRole("searchbox", { name: "搜索应用" });
    expect(search).toHaveFocus();

    await user.type(search, "set");
    const menu = screen.getByRole("dialog", { name: "App 菜单" });
    expect(
      within(menu).getByRole("button", { name: "设置" }),
    ).toBeVisible();
    expect(within(menu).queryByRole("button", { name: "关于" })).toBeNull();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "App 菜单" })).toBeNull();
  });

  it("manages desktop and taskbar state from an app context menu", async () => {
    const user = userEvent.setup();
    render(<Desktop />);

    await user.click(screen.getByRole("button", { name: "打开 App 菜单" }));
    const menu = screen.getByRole("dialog", { name: "App 菜单" });
    const settings = within(menu).getByRole("button", { name: "设置" });
    expect(
      within(menu).queryByRole("button", {
        name: /添加到桌面/,
      }),
    ).toBeNull();

    await user.pointer({ target: settings, keys: "[MouseRight]" });
    expect(
      screen.getByRole("menuitem", { name: "添加到桌面" }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("menuitem", { name: "添加到任务栏" }),
    );
    expect(useDesktopStore.getState().pinnedAppIds).toContain(
      "system.settings",
    );

    settings.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(
      screen.getByRole("menuitem", { name: "从任务栏移除" }),
    ).toBeVisible();
  });

  it("selects and clears a desktop icon", async () => {
    const user = userEvent.setup();
    const { container } = render(<Desktop />);
    const desktopApps = screen.getByRole("group", { name: "桌面项目" });
    const about = within(desktopApps).getByRole("button", { name: "关于" });

    await user.click(about);
    expect(about).toHaveAttribute("data-selected", "true");

    const iconLayer = container.querySelector(".desktop-icon-layer");
    expect(iconLayer).not.toBeNull();
    await user.click(iconLayer as Element);
    expect(about).toHaveAttribute("data-selected", "false");
  });

  it("shows the desktop-only no-op refresh menu", async () => {
    const user = userEvent.setup();
    const { container } = render(<Desktop />);
    const iconLayer = container.querySelector(".desktop-icon-layer");
    expect(iconLayer).not.toBeNull();

    await user.pointer({
      target: iconLayer as Element,
      keys: "[MouseRight]",
    });
    const refresh = screen.getByRole("menuitem", { name: "刷新" });
    await user.click(refresh);
    expect(screen.queryByRole("menuitem", { name: "刷新" })).toBeNull();
    expect(useDesktopSurfaceStore.getState().surface.revision).toBe(1);
  });

  it("shows a recoverable notice after a tab layout conflict", () => {
    useDesktopSurfaceStore.setState({
      status: "ready",
      error: "桌面已在其他页面中发生变化，请重新操作。",
    });
    render(<Desktop />);
    expect(
      screen.getByRole("button", {
        name: /桌面已在其他页面中发生变化/,
      }),
    ).toBeVisible();
  });
});
