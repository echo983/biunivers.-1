import { expect, test } from "@playwright/test";

const commitSha = "0123456789abcdef0123456789abcdef01234567";
const manifest = {
  formatVersion: 1,
  protocol: "biunivers.static-app/1",
  appId: "io.github.example.hello",
  version: "1.0.0",
  name: "Biunivers Hello",
  description: "A browser acceptance fixture.",
  license: "MIT",
  icon: "icon.svg",
  window: {
    defaultWidth: 640,
    defaultHeight: 480,
    minWidth: 320,
    minHeight: 240,
    desktop: true,
    pinned: false,
  },
  configuration: [
    {
      key: "greeting",
      label: "问候语",
      description: "公开问候文本。",
      type: "string",
      required: false,
      default: "你好，Biunivers",
    },
  ],
};

test("opens management, reports a bad ref, and installs an app", async ({
  page,
}) => {
  let installed = false;
  let configuredGreeting = "";

  await page.route("**/api/v1/apps", async (route) => {
    await route.fulfill({
      json: {
        apps: installed
          ? [
              {
                id: manifest.appId,
                name: manifest.name,
                kind: "iframe",
                icon: `http://127.0.0.1:4174/apps/${manifest.appId}/${commitSha}/icon.svg`,
                description: manifest.description,
                url: `http://127.0.0.1:4174/apps/${manifest.appId}/${commitSha}/index.html`,
                defaultWidth: 640,
                defaultHeight: 480,
                minWidth: 320,
                minHeight: 240,
                desktop: true,
                pinned: false,
                trusted: true,
              },
            ]
          : [],
      },
    });
  });

  await page.route("**/api/v1/control/apps", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        json: {
          schemaVersion: 1,
          apps: [],
        },
      });
      return;
    }

    const body = route.request().postDataJSON() as {
      configuration: { greeting: string };
    };
    configuredGreeting = body.configuration.greeting;
    installed = true;
    await route.fulfill({
      status: 201,
      json: {
        appId: manifest.appId,
        repository: "https://github.com/example/hello",
        requestedRef: "main",
        commitSha,
        version: manifest.version,
        protocol: manifest.protocol,
        manifest,
        configuration: body.configuration,
        status: "active",
        installedAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z",
      },
    });
  });

  await page.route("**/api/v1/control/inspections", async (route) => {
    const body = route.request().postDataJSON() as { ref: string };
    if (body.ref === "missing") {
      await route.fulfill({
        status: 400,
        json: {
          error: {
            code: "GITHUB_REF_NOT_FOUND",
            message: "无法解析 Git ref：GitHub HTTP 404",
          },
        },
      });
      return;
    }
    await route.fulfill({
      status: 201,
      json: {
        inspectionId: "inspection-1",
        repository: "https://github.com/example/hello",
        requestedRef: body.ref,
        commitSha,
        operation: "install",
        expiresAt: "2026-07-28T01:00:00.000Z",
        manifest,
      },
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "打开 App 菜单" }).click();
  await page
    .getByRole("dialog", { name: "App 菜单" })
    .getByRole("button", { name: "设置" })
    .click();

  const settingsWindow = page.locator("#app-system\\.settings");
  await expect(
    settingsWindow.getByRole("heading", { name: "从 GitHub 安装" }),
  ).toBeVisible();

  await settingsWindow
    .getByLabel("公开仓库 URL")
    .fill("https://github.com/example/hello");
  await settingsWindow.getByLabel("Branch、tag 或 commit").fill("missing");
  await settingsWindow.getByRole("button", { name: "检查仓库" }).click();
  await expect(
    settingsWindow.getByText("无法解析 Git ref：GitHub HTTP 404"),
  ).toBeVisible();

  await settingsWindow.getByLabel("Branch、tag 或 commit").fill("main");
  await settingsWindow.getByRole("button", { name: "检查仓库" }).click();
  await expect(
    settingsWindow.getByRole("heading", { name: "确认安装" }),
  ).toBeVisible();
  await settingsWindow.getByLabel("问候语").fill("来自浏览器 E2E");
  await settingsWindow.getByRole("button", { name: "确认安装" }).click();

  await expect(
    settingsWindow.getByText("“Biunivers Hello”安装成功"),
  ).toBeVisible();
  expect(configuredGreeting).toBe("来自浏览器 E2E");
  await page.getByRole("button", { name: "打开 App 菜单" }).click();
  await expect(
    page
      .getByRole("dialog", { name: "App 菜单" })
      .getByRole("button", { name: "Biunivers Hello" }),
  ).toBeVisible();
});
