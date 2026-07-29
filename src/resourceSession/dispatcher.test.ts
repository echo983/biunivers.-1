import { describe, expect, it, vi } from "vitest";
import { dispatchResourceSessionRequest } from "./dispatcher";
import {
  RESOURCE_SESSION_PROTOCOL,
  type ResourceSessionRequest,
} from "./protocol";

function request(method: string, params: unknown): ResourceSessionRequest {
  return {
    protocol: RESOURCE_SESSION_PROTOCOL,
    requestId: "request-1",
    method,
    params,
  };
}

describe("Resource Session dispatcher", () => {
  it("reports the stable v1 capabilities without a server call", async () => {
    await expect(
      dispatchResourceSessionRequest(
        request("resource.getCapabilities", {}),
        "instance-token",
        {
          selectFile: vi.fn(),
          selectSaveTarget: vi.fn(),
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        renewAfterSeconds: 60,
        expiresAfterSeconds: 300,
        singleRangeRead: true,
      },
    });
  });

  it("opens a selected file with the requested access", async () => {
    const selectFile = vi.fn().mockResolvedValue("11".repeat(16));
    const open = vi.fn().mockResolvedValue({ sessionId: "session" });
    await expect(
      dispatchResourceSessionRequest(
        request("resource.open", { access: "edit" }),
        "instance-token",
        {
          selectFile,
          selectSaveTarget: vi.fn(),
          open,
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { sessionId: "session" },
    });
    expect(selectFile).toHaveBeenCalledWith(true);
    expect(open).toHaveBeenCalledWith(
      "instance-token",
      "11".repeat(16),
      "edit",
    );
  });

  it("creates pending save targets and handles cancellation", async () => {
    const createSaveTarget = vi
      .fn()
      .mockResolvedValue({ sessionId: "session" });
    await dispatchResourceSessionRequest(
      request("resource.saveAs", { suggestedName: "movie.mkv" }),
      "instance-token",
      {
        selectFile: vi.fn(),
        selectSaveTarget: vi.fn().mockResolvedValue({
          parentEntryId: "22".repeat(16),
          name: "movie.mkv",
        }),
        createSaveTarget,
      },
    );
    expect(createSaveTarget).toHaveBeenCalledWith(
      "instance-token",
      "22".repeat(16),
      "movie.mkv",
    );
    await expect(
      dispatchResourceSessionRequest(
        request("resource.open", {}),
        "instance-token",
        {
          selectFile: vi.fn().mockResolvedValue(null),
          selectSaveTarget: vi.fn(),
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "USER_CANCELLED" },
    });
  });

  it("batches renewal and rejects invalid session identifiers", async () => {
    const sessionId = "a".repeat(43);
    const renew = vi.fn().mockResolvedValue({ renewed: [], rejected: [] });
    await dispatchResourceSessionRequest(
      request("resource.renew", { sessionIds: [sessionId, sessionId] }),
      "instance-token",
      {
        selectFile: vi.fn(),
        selectSaveTarget: vi.fn(),
        renew,
      },
    );
    expect(renew).toHaveBeenCalledWith("instance-token", [
      sessionId,
      sessionId,
    ]);
    await expect(
      dispatchResourceSessionRequest(
        request("resource.release", { sessionIds: ["guessable"] }),
        "instance-token",
        {
          selectFile: vi.fn(),
          selectSaveTarget: vi.fn(),
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "REQUEST_INVALID" },
    });
  });
});
