import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeHostInstance,
  createHostInstance,
} from "./instanceClient";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Host instance client", () => {
  it("creates and validates an opaque host instance", async () => {
    const instanceToken =
      "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          instanceToken,
          expiresAt: "2026-07-30T00:00:00.000Z",
        }),
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createHostInstance("io.example.notes", "window-1"),
    ).resolves.toEqual({
      instanceToken,
      expiresAt: "2026-07-30T00:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/host/instances",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          appId: "io.example.notes",
          windowInstanceId: "window-1",
        }),
      }),
    );
  });

  it("treats a disabled file service as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );
    await expect(
      createHostInstance("io.example.notes", "window-1"),
    ).resolves.toBeNull();
  });

  it("revokes valid instances with a keepalive request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const instanceToken =
      "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
    await closeHostInstance(instanceToken);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/host/instances/current",
      {
        method: "DELETE",
        headers: {
          Authorization: `Biunivers-Instance ${instanceToken}`,
        },
        keepalive: true,
      },
    );
  });
});
