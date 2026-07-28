import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(
    page
      .getByRole("group", { name: "桌面应用" })
      .getByRole("button", { name: "Transmission" }),
  ).toBeVisible();
});

test("opens, controls, closes, and restores an internal window", async ({
  page,
}) => {
  await page
    .getByRole("group", { name: "桌面应用" })
    .getByRole("button", { name: "关于" })
    .dblclick();

  const aboutWindow = page.locator("#app-system\\.about");
  await expect(aboutWindow).toBeVisible();
  await expect(aboutWindow.getByRole("heading", { name: "Biunivers 桌面" })).toBeVisible();

  const maximizeButton = aboutWindow.getByRole("button", { name: "最大化" });
  await expect(maximizeButton).toHaveAttribute("title", "最大化");
  await maximizeButton.click();
  await expect(aboutWindow).toHaveClass(/max/);
  const restoreButton = aboutWindow.getByRole("button", { name: "还原" });
  await expect(restoreButton).toHaveAttribute("title", "还原");
  await restoreButton.click();
  await expect(aboutWindow).not.toHaveClass(/max/);

  const aboutTaskbar = page
    .locator(".taskbar")
    .getByRole("button", { name: "关于" });
  await aboutTaskbar.click();
  await expect(aboutWindow).toBeHidden();
  await aboutTaskbar.click();
  await expect(aboutWindow).toBeVisible();

  await aboutWindow.getByRole("button", { name: "最小化" }).click();
  await expect(aboutWindow).toBeHidden();
  await aboutTaskbar.click();
  await expect(aboutWindow).toBeVisible();

  const taskbarTop = await page.locator(".taskbar").evaluate(
    (element) => element.getBoundingClientRect().top,
  );
  const windowBottom = await aboutWindow.evaluate(
    (element) => element.getBoundingClientRect().bottom,
  );
  expect(windowBottom).toBeLessThanOrEqual(taskbarTop);

  await page.waitForTimeout(400);
  await page.reload();
  await expect(aboutWindow).toBeVisible();

  await aboutWindow.locator(".wb-close").click();
  await expect(aboutWindow).toHaveCount(0);
  await page.waitForTimeout(400);
  await page.reload();
  await expect(aboutWindow).toHaveCount(0);
});

test("searches the App menu and opens settings", async ({ page }) => {
  await page.getByRole("button", { name: "打开 App 菜单" }).click();
  const search = page.getByRole("searchbox", { name: "搜索应用" });
  await search.fill("settings");
  await page
    .getByRole("dialog", { name: "App 菜单" })
    .getByRole("button", { name: "设置" })
    .click();

  await expect(page.locator("#app-system\\.settings")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "设置", exact: true }),
  ).toBeVisible();
});
