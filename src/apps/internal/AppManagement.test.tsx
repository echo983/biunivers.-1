import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDesktopStore } from "../../store/desktopStore";
import { AppManagement } from "./AppManagement";

const inspection = {
  inspectionId: "inspection-1",
  repository: "https://github.com/example/hello",
  requestedRef: "v1.0.0",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  operation: "install",
  expiresAt: "2026-07-28T23:00:00.000Z",
  manifest: {
    appId: "io.github.example.hello",
    version: "1.0.0",
    name: "Hello",
    description: "Example application",
    license: "MIT",
    icon: "icon.svg",
    window: {
      defaultWidth: 640,
      defaultHeight: 480,
      pinned: true,
    },
    configuration: [
      {
        key: "greeting",
        label: "问候语",
        type: "string",
        required: false,
        default: "你好",
      },
    ],
  },
  openResource: {
    protocol: "biunivers.open-resource/1",
    handlers: [
      {
        id: "text-editor",
        actions: ["open", "edit"],
        extensions: [".txt"],
        access: "read-write",
      },
    ],
  },
};

const installed = {
  appId: "io.github.example.hello",
  repository: inspection.repository,
  requestedRef: inspection.requestedRef,
  commitSha: inspection.commitSha,
  version: "1.0.0",
  status: "active",
  configuration: {
    greeting: "你好",
  },
  manifest: {
    name: "Hello",
    description: "Example application",
    configuration: inspection.manifest.configuration,
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AppManagement", () => {
  it("unlocks, inspects and installs an application", async () => {
    const user = userEvent.setup();
    let installedState = false;
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/v1/admin/apps" && init?.method === "POST") {
          installedState = true;
          return Response.json(installed, { status: 201 });
        }
        if (url === "/api/v1/admin/apps") {
          return Response.json({
            schemaVersion: 1,
            apps: installedState ? [installed] : [],
          });
        }
        if (url === "/api/v1/admin/inspections") {
          return Response.json(inspection, { status: 201 });
        }
        if (url === "/config/apps.json") {
          return Response.json([]);
        }
        if (url === "/api/v1/apps") {
          return Response.json({
            apps: installedState
              ? [
                  {
                    id: installed.appId,
                    name: "Hello",
                    kind: "iframe",
                    icon: "http://localhost:8081/apps/hello/icon.svg",
                    url: "http://localhost:8081/apps/hello/index.html",
                    defaultWidth: 640,
                    defaultHeight: 480,
                    desktop: true,
                    pinned: true,
                    trusted: true,
                  },
                ]
              : [],
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    useDesktopStore.setState({ pinnedAppIds: [], pinnedInitialized: true });

    render(<AppManagement />);
    await user.type(
      screen.getByLabelText("管理员 token"),
      "a-secure-token-value",
    );
    await user.click(
      screen.getByRole("button", { name: "解锁应用管理" }),
    );

    expect(
      await screen.findByRole("heading", { name: "从 GitHub 安装" }),
    ).toBeVisible();
    await user.type(
      screen.getByLabelText("公开仓库 URL"),
      inspection.repository,
    );
    await user.clear(screen.getByLabelText("Branch、tag 或 commit"));
    await user.type(
      screen.getByLabelText("Branch、tag 或 commit"),
      "v1.0.0",
    );
    await user.click(screen.getByRole("button", { name: "检查仓库" }));
    expect(
      await screen.findByRole("heading", { name: "文件处理能力" }),
    ).toBeVisible();
    expect(screen.getByText(".txt")).toBeVisible();

    expect(
      await screen.findByRole("heading", { name: "确认安装" }),
    ).toBeVisible();
    expect(screen.getByDisplayValue("你好")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "确认安装" }));

    expect(
      await screen.findByText("“Hello”安装成功"),
    ).toBeVisible();
    expect(screen.getByText("io.github.example.hello")).toBeVisible();
    expect(useDesktopStore.getState().apps[installed.appId]).toBeDefined();
    expect(useDesktopStore.getState().pinnedAppIds).toContain(installed.appId);
    expect(localStorage.getItem("admin-token")).toBeNull();
  });

  it("keeps the manager locked after an authentication failure", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "ADMIN_AUTH_REQUIRED",
              message: "需要有效的管理员凭据",
            },
          },
          { status: 401 },
        ),
      ),
    );

    render(<AppManagement />);
    await user.type(screen.getByLabelText("管理员 token"), "wrong-token");
    await user.click(
      screen.getByRole("button", { name: "解锁应用管理" }),
    );

    expect(
      await screen.findByText("需要有效的管理员凭据"),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "从 GitHub 安装" }),
    ).toBeNull();
    await waitFor(() =>
      expect(screen.getByLabelText("管理员 token")).toBeVisible(),
    );
  });

  it("disables, enables and uninstalls an installed application", async () => {
    const user = userEvent.setup();
    let current: typeof installed | null = structuredClone(installed);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (
          url === `/api/v1/admin/apps/${installed.appId}` &&
          init?.method === "PATCH"
        ) {
          const patch = JSON.parse(String(init.body)) as {
            status?: "active" | "disabled";
          };
          current = current
            ? { ...current, status: patch.status ?? current.status }
            : null;
          return Response.json(current);
        }
        if (
          url === `/api/v1/admin/apps/${installed.appId}` &&
          init?.method === "DELETE"
        ) {
          current = null;
          return new Response(null, { status: 204 });
        }
        if (url === "/api/v1/admin/apps") {
          return Response.json({
            schemaVersion: 1,
            apps: current ? [current] : [],
          });
        }
        if (url === "/config/apps.json") {
          return Response.json([]);
        }
        if (url === "/api/v1/apps") {
          return Response.json({ apps: [] });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    render(<AppManagement />);
    await user.type(
      screen.getByLabelText("管理员 token"),
      "a-secure-token-value",
    );
    await user.click(
      screen.getByRole("button", { name: "解锁应用管理" }),
    );
    expect(await screen.findByText(installed.appId)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "停用" }));
    expect(await screen.findByText("“Hello”已停用")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "启用" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "卸载" }));
    expect(await screen.findByText("“Hello”已卸载")).toBeVisible();
    expect(screen.getByText("尚未安装第三方应用。")).toBeVisible();
  });
});
