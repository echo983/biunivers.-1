import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadFile, uploadLocalFile } from "./fileManagerTransfers";

const instanceToken = "a".repeat(43);
const handleId = "b".repeat(43);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("file manager transfers", () => {
  it("uploads through a pending handle and one-shot PUT", async () => {
    const file = new File(["hello"], "hello.txt", {
      type: "text/plain",
    });
    const upload = new EventTarget();
    const request = Object.assign(new EventTarget(), {
      upload,
      status: 0,
      responseText: "",
      open: vi.fn(),
      setRequestHeader: vi.fn(),
      send: vi.fn((body: File) => {
        expect(body).toBe(file);
        upload.dispatchEvent(
          new ProgressEvent("progress", {
            lengthComputable: true,
            loaded: 5,
            total: 5,
          }),
        );
        request.status = 201;
        request.dispatchEvent(new Event("load"));
      }),
      abort: vi.fn(),
    });
    class MockXMLHttpRequest {
      constructor() {
        return request;
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
    const fetchMock = vi.fn(
      async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "/api/v1/host/save-handles") {
          return Response.json(
            {
              handleId,
              writable: true,
              expiresAt: "2026-07-30T00:00:00.000Z",
              metadata: {
                name: file.name,
                kind: "file",
                size: 0,
                mtimeMs: 0,
                revision: 3,
              },
            },
            { status: 201 },
          );
        }
        if (url === "/api/v1/host/transfers") {
          return Response.json(
            {
              transferId: "c".repeat(43),
              url: "/api/v1/files/transfers/upload",
              method: "PUT",
              authorization: "Biunivers-Instance",
              instanceToken,
              expiresAt: "2026-07-30T00:00:00.000Z",
              maxBytes: 1024,
            },
            { status: 201 },
          );
        }
        if (url.includes("/api/v1/host/handles/")) {
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const onProgress = vi.fn();
    await uploadLocalFile(instanceToken, "1".repeat(32), file, { onProgress });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/host/save-handles",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          parentEntryId: "1".repeat(32),
          name: "hello.txt",
        }),
      }),
    );
    expect(request.open).toHaveBeenCalledWith(
      "PUT",
      "/api/v1/files/transfers/upload",
    );
    expect(request.setRequestHeader).toHaveBeenCalledWith(
      "Authorization",
      `Biunivers-Instance ${instanceToken}`,
    );
    expect(request.send).toHaveBeenCalledWith(file);
    expect(onProgress).toHaveBeenLastCalledWith({ loaded: 5, total: 5 });
  });

  it("downloads through a read handle and revokes the object URL", async () => {
    const createObjectURL = vi.fn(() => "blob:test");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "/api/v1/host/handles") {
          return Response.json(
            {
              handleId,
              writable: false,
              expiresAt: "2026-07-30T00:00:00.000Z",
              metadata: {
                entryId: "2".repeat(32),
                name: "hello.txt",
                kind: "file",
                size: 5,
                mtimeMs: 0,
                revision: 3,
              },
            },
            { status: 201 },
          );
        }
        if (url === "/api/v1/host/transfers") {
          return Response.json(
            {
              transferId: "c".repeat(43),
              url: "/api/v1/files/transfers/download",
              method: "GET",
              authorization: "Biunivers-Instance",
              instanceToken,
              expiresAt: "2026-07-30T00:00:00.000Z",
              maxBytes: 0,
            },
            { status: 201 },
          );
        }
        if (url === "/api/v1/files/transfers/download") {
          return new Response("hello");
        }
        if (url.includes("/api/v1/host/handles/")) {
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const onProgress = vi.fn();
    await downloadFile(
      instanceToken,
      {
        entryId: "2".repeat(32),
        name: "hello.txt",
        kind: "file",
        size: 5,
        mtimeMs: 0,
      },
      { onProgress },
    );

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
    expect(onProgress).toHaveBeenLastCalledWith({ loaded: 5, total: 5 });
  });
});
