import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import packageJson from "../../../package.json";
import { AboutApp } from "./AboutApp";

describe("AboutApp", () => {
  it("shows the current milestone and delivered capabilities", () => {
    render(<AboutApp />);

    expect(
      screen.getByRole("heading", { name: "Biunivers 桌面" }),
    ).toBeVisible();
    expect(screen.getByText(`版本 ${packageJson.version}`)).toBeVisible();
    expect(
      screen.getByText(
        "File Service · 批量操作 · ZIP 导出 · Wormhole · Resource Session v1",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "PVLogFS · 隔离 Run · COW 提交 · Fork · Diff · 双向受控导入",
      ),
    ).toBeVisible();
    expect(
      screen.getByText("单一主人 · 桌面同源 · 应用能力隔离"),
    ).toBeVisible();
    expect(
      screen.getByText("Debian 12/13 · systemd · 固定 Release · 事务更新"),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Static App v1 · Workspace Application v1 · 默认环境与实例覆盖",
      ),
    ).toBeVisible();
  });
});
