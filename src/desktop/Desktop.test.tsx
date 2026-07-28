import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultApps } from "../store/defaults";
import { useDesktopStore } from "../store/desktopStore";
import { Desktop } from "./Desktop";

describe("Desktop", () => {
  beforeEach(() => {
    useDesktopStore.setState({
      apps: Object.fromEntries(defaultApps.map((app) => [app.id, app])),
      appMenuOpen: false,
      selectedDesktopAppId: null,
    });
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

  it("selects and clears a desktop icon", async () => {
    const user = userEvent.setup();
    const { container } = render(<Desktop />);
    const desktopApps = screen.getByRole("group", { name: "桌面应用" });
    const about = within(desktopApps).getByRole("button", { name: "关于" });

    await user.click(about);
    expect(about).toHaveAttribute("data-selected", "true");

    const iconLayer = container.querySelector(".desktop-icon-layer");
    expect(iconLayer).not.toBeNull();
    await user.click(iconLayer as Element);
    expect(about).toHaveAttribute("data-selected", "false");
  });
});
