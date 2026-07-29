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
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
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
        if (url === "/api/v1/files/transfers/upload") {
          expect(init).toMatchObject({
            method: "PUT",
            body: file,
          });
          return Response.json({ revision: 4 });
        }
        if (url.includes("/api/v1/host/handles/")) {
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await uploadLocalFile(instanceToken, "1".repeat(32), file);

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

    await downloadFile(instanceToken, {
      entryId: "2".repeat(32),
      name: "hello.txt",
      kind: "file",
      size: 5,
      mtimeMs: 0,
    });

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
  });
});
