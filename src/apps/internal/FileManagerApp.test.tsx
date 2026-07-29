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
      async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        if (String(input).startsWith("/api/v1/host/files")) {
          return Response.json({
            revision: 3,
            rootEntryId: "1".repeat(32),
            parent: {
              entryId: "1".repeat(32),
              name: "",
              kind: "directory",
              mtimeMs: 0,
            },
            entries: [],
          });
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
      await screen.findByText("此文件夹为空。"),
    ).toBeInTheDocument();

    view.unmount();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/host/instances/current",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
