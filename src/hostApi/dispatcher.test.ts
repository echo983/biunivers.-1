import { describe, expect, it, vi } from "vitest";
import { dispatchHostRequest } from "./dispatcher";
import { HOST_API_PROTOCOL, type HostRequest } from "./protocol";

function request(method: string, params: unknown): HostRequest {
  return {
    protocol: HOST_API_PROTOCOL,
    requestId: "request-1",
    method,
    params,
  };
}

describe("Host API dispatcher", () => {
  it("opens a user-selected file with the requested permission", async () => {
    const selectFile = vi.fn().mockResolvedValue("11".repeat(16));
    const openHandle = vi.fn().mockResolvedValue({ handleId: "handle" });
    await expect(
      dispatchHostRequest(
        request("file.open", { writable: true }),
        "instance-token",
        { selectFile, openHandle },
      ),
    ).resolves.toEqual({
      protocol: HOST_API_PROTOCOL,
      requestId: "request-1",
      ok: true,
      result: { handleId: "handle" },
    });
    expect(selectFile).toHaveBeenCalledWith(true);
    expect(openHandle).toHaveBeenCalledWith(
      "instance-token",
      "11".repeat(16),
      true,
    );
  });

  it("returns a usable read transfer and keeps saveAs disabled", async () => {
    const createTransfer = vi.fn().mockResolvedValue({
      method: "GET",
      url: "https://desktop.example/api/v1/files/transfers/id",
    });
    await expect(
      dispatchHostRequest(
        request("file.readTransfer", { handleId: "handle-1" }),
        "instance-token",
        { selectFile: vi.fn(), createTransfer },
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { method: "GET" },
    });
    expect(createTransfer).toHaveBeenCalledWith(
      "instance-token",
      "handle-1",
      "GET",
    );
    await expect(
      dispatchHostRequest(
        request("file.saveAs", {}),
        "instance-token",
        { selectFile: vi.fn() },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "HOST_API_UNSUPPORTED" },
    });
  });

  it("correlates cancellation and invalid params without throwing", async () => {
    await expect(
      dispatchHostRequest(
        request("file.open", {}),
        "instance-token",
        { selectFile: vi.fn().mockResolvedValue(null) },
      ),
    ).resolves.toMatchObject({
      requestId: "request-1",
      ok: false,
      error: { code: "USER_CANCELLED" },
    });
    await expect(
      dispatchHostRequest(
        request("file.release", { handleId: 1 }),
        "instance-token",
        { selectFile: vi.fn() },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "REQUEST_INVALID" },
    });
  });
});
