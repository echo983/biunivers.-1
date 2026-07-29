import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileManagerApp } from "./FileManagerApp";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FileManagerApp", () => {
  it("shows a clear unavailable state when File Service is disabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({}, { status: 503 })),
    );

    render(<FileManagerApp />);

    expect(
      await screen.findByText("当前宿主尚未启用文件能力。"),
    ).toBeInTheDocument();
  });

  it("enters the ready state after creating its internal instance", async () => {
    const token = "a".repeat(43);
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        return Response.json(
          {
            instanceToken: token,
            expiresAt: "2026-07-30T00:00:00.000Z",
          },
          { status: 201 },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<FileManagerApp />);

    expect(
      await screen.findByText(
        "文件服务已就绪。目录管理将在下一施工阶段接入。",
      ),
    ).toBeInTheDocument();

    view.unmount();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/host/instances/current",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
