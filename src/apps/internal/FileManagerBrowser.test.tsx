import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileManagerBrowser } from "./FileManagerBrowser";

const rootId = "1".repeat(32);
const directoryId = "2".repeat(32);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FileManagerBrowser", () => {
  it("browses directories and creates a folder at the listed revision", async () => {
    const user = userEvent.setup();
    let revision = 3;
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/v1/host/files")) {
          const nested = url.includes(directoryId);
          return Response.json({
            revision,
            rootEntryId: rootId,
            parent: {
              entryId: nested ? directoryId : rootId,
              name: nested ? "Documents" : "",
              kind: "directory",
              mtimeMs: 0,
            },
            entries: nested
              ? []
              : [
                  {
                    entryId: directoryId,
                    name: "Documents",
                    kind: "directory",
                    mtimeMs: 100,
                  },
                ],
          });
        }
        if (
          url === "/api/v1/internal/files/directories" &&
          init?.method === "POST"
        ) {
          revision += 1;
          return Response.json(
            { entryId: "3".repeat(32), revision },
            { status: 201 },
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<FileManagerBrowser instanceToken={"a".repeat(43)} />);

    const directory = await screen.findByText("Documents");
    await user.dblClick(directory);
    expect(await screen.findByText("此文件夹为空。")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Documents" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "新建文件夹" }));
    await user.type(screen.getByLabelText("名称"), "Drafts");
    await user.click(screen.getByRole("button", { name: "确定" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/internal/files/directories",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            parentEntryId: directoryId,
            name: "Drafts",
            expectedRevision: 3,
          }),
        }),
      );
    });
  });

  it("refreshes and explains a stale revision conflict", async () => {
    const user = userEvent.setup();
    let listingReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.startsWith("/api/v1/host/files")) {
          listingReads += 1;
          return Response.json({
            revision: listingReads === 1 ? 3 : 4,
            rootEntryId: rootId,
            parent: {
              entryId: rootId,
              name: "",
              kind: "directory",
              mtimeMs: 0,
            },
            entries: [],
          });
        }
        return Response.json(
          {
            error: {
              code: "FILE_VERSION_CONFLICT",
              message: "conflict",
            },
          },
          { status: 409 },
        );
      }),
    );

    render(<FileManagerBrowser instanceToken={"a".repeat(43)} />);
    await screen.findByText("此文件夹为空。");
    await user.click(screen.getByRole("button", { name: "新建文件夹" }));
    await user.type(screen.getByLabelText("名称"), "Conflict");
    await user.click(screen.getByRole("button", { name: "确定" }));

    expect(
      await screen.findByText(
        "文件系统已发生变化，目录已刷新，请重新操作。",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(listingReads).toBe(2));
  });

  it("renames, moves and removes a selected entry", async () => {
    const user = userEvent.setup();
    const fileId = "4".repeat(32);
    const mutationRequests: Array<{
      url: string;
      method: string | undefined;
      body: string | undefined;
    }> = [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/v1/host/files")) {
          const nested = url.includes(directoryId);
          return Response.json({
            revision: 3,
            rootEntryId: rootId,
            parent: {
              entryId: nested ? directoryId : rootId,
              name: nested ? "Documents" : "",
              kind: "directory",
              mtimeMs: 0,
            },
            entries: nested
              ? []
              : [
                  {
                    entryId: directoryId,
                    name: "Documents",
                    kind: "directory",
                    mtimeMs: 100,
                  },
                  {
                    entryId: fileId,
                    name: "note.txt",
                    kind: "file",
                    size: 12,
                    mtimeMs: 100,
                  },
                ],
          });
        }
        mutationRequests.push({
          url,
          method: init?.method,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        return Response.json({ entryId: fileId, revision: 4 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<FileManagerBrowser instanceToken={"a".repeat(43)} />);
    await screen.findByText("note.txt");

    await user.click(screen.getByText("note.txt"));
    await user.click(screen.getByRole("button", { name: "重命名" }));
    const nameInput = screen.getByLabelText("名称");
    await user.clear(nameInput);
    await user.type(nameInput, "renamed.txt");
    await user.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() => expect(mutationRequests).toHaveLength(1));
    expect(JSON.parse(mutationRequests[0].body!)).toEqual({
      newParentEntryId: rootId,
      newName: "renamed.txt",
      expectedRevision: 3,
    });

    await user.click(await screen.findByText("note.txt"));
    await user.click(screen.getByRole("button", { name: "移动" }));
    const moveDialog = screen.getByRole("dialog", {
      name: "移动“note.txt”",
    });
    await user.click(
      within(moveDialog).getByRole("button", { name: "📁 Documents" }),
    );
    const moveHere = within(moveDialog).getByRole("button", {
      name: "移动到这里",
    });
    await waitFor(() => expect(moveHere).toBeEnabled());
    await user.click(moveHere);
    await waitFor(() => expect(mutationRequests).toHaveLength(2));
    expect(JSON.parse(mutationRequests[1].body!)).toEqual({
      newParentEntryId: directoryId,
      newName: "note.txt",
      expectedRevision: 3,
    });

    await user.click(await screen.findByText("note.txt"));
    await user.click(screen.getByRole("button", { name: "移除" }));
    await waitFor(() => expect(mutationRequests).toHaveLength(3));
    expect(mutationRequests[2]).toMatchObject({
      url: `/api/v1/internal/files/entries/${fileId}`,
      method: "DELETE",
    });
    expect(JSON.parse(mutationRequests[2].body!)).toEqual({
      recursive: false,
      expectedRevision: 3,
    });
  });
});
