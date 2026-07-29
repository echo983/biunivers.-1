import {
  act,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileManagerBrowser } from "./FileManagerBrowser";
import { useDesktopStore } from "../../store/desktopStore";

const transferMocks = vi.hoisted(() => ({
  uploadLocalFile: vi.fn(async () => {}),
  downloadFile: vi.fn(async () => {}),
}));
const windowMocks = vi.hoisted(() => ({
  openApp: vi.fn(),
}));

vi.mock("../../api/fileManagerTransfers", () => transferMocks);
vi.mock("../../windows/windowController", () => windowMocks);

const rootId = "1".repeat(32);
const directoryId = "2".repeat(32);

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useDesktopStore.setState({
    defaultResourceHandlers: {},
  });
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
    act(() => {
      directory.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true }),
      );
      directory.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true }),
      );
    });
    expect(await screen.findByText("此文件夹为空。")).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Documents" }),
    ).toHaveLength(1);

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

  it("uploads local files and downloads the selected file", async () => {
    const user = userEvent.setup();
    const fileId = "4".repeat(32);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          revision: 3,
          rootEntryId: rootId,
          parent: {
            entryId: rootId,
            name: "",
            kind: "directory",
            mtimeMs: 0,
          },
          entries: [
            {
              entryId: fileId,
              name: "note.txt",
              kind: "file",
              size: 12,
              mtimeMs: 100,
            },
          ],
        }),
      ),
    );

    render(<FileManagerBrowser instanceToken={"a".repeat(43)} />);
    await screen.findByText("note.txt");

    const localFile = new File(["upload"], "upload.txt");
    await user.upload(
      screen.getByLabelText("选择要上传的文件"),
      localFile,
    );
    await waitFor(() =>
      expect(transferMocks.uploadLocalFile).toHaveBeenCalledWith(
        "a".repeat(43),
        rootId,
        localFile,
      ),
    );
    expect(
      await screen.findByText("已上传 1 个文件。"),
    ).toBeInTheDocument();

    await user.click(screen.getByText("note.txt"));
    await user.click(screen.getByRole("button", { name: "下载" }));
    await waitFor(() =>
      expect(transferMocks.downloadFile).toHaveBeenCalledWith(
        "a".repeat(43),
        expect.objectContaining({
          entryId: fileId,
          name: "note.txt",
        }),
      ),
    );
    expect(
      await screen.findByText("已开始下载“note.txt”。"),
    ).toBeInTheDocument();
  });

  it("double-clicks a file into its unique handler", async () => {
    const user = userEvent.setup();
    const fileId = "4".repeat(32);
    useDesktopStore.setState({
      apps: {
        "io.github.example.notes": {
          id: "io.github.example.notes",
          name: "Notes",
          kind: "iframe",
          icon: "http://notes.localhost/icon.svg",
          url: "http://notes.localhost/index.html",
          defaultWidth: 640,
          defaultHeight: 480,
          desktop: true,
          pinned: false,
          trusted: true,
        },
      },
      defaultResourceHandlers: {},
    });
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/v1/host/files")) {
          return Response.json({
            revision: 3,
            rootEntryId: rootId,
            parent: {
              entryId: rootId,
              name: "",
              kind: "directory",
              mtimeMs: 0,
            },
            entries: [
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
        if (url.endsWith("/resolve")) {
          return Response.json({
            entryId: fileId,
            name: "note.txt",
            extension: ".txt",
            revision: 3,
            requestedAction: "edit",
            effectiveAction: "edit",
            candidates: [
              {
                appId: "io.github.example.notes",
                appName: "Notes",
                handler: {
                  id: "text",
                  actions: ["open", "edit"],
                  extensions: [".txt"],
                  access: "read-write",
                },
              },
            ],
          });
        }
        if (
          url === "/api/v1/internal/open-resources" &&
          init?.method === "POST"
        ) {
          return Response.json(
            {
              targetAppId: "io.github.example.notes",
              launchId: "l".repeat(43),
              expiresAt: "2026-07-29T12:05:00.000Z",
            },
            { status: 201 },
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<FileManagerBrowser instanceToken={"a".repeat(43)} />);
    await user.dblClick(await screen.findByText("note.txt"));
    await waitFor(() =>
      expect(windowMocks.openApp).toHaveBeenCalledWith(
        "io.github.example.notes",
        { launchId: "l".repeat(43) },
      ),
    );
    expect(await screen.findByText("已用“Notes”打开。")).toBeVisible();
  });

  it("chooses and remembers one of multiple handlers", async () => {
    const user = userEvent.setup();
    const fileId = "4".repeat(32);
    const apps = Object.fromEntries(
      ["notes", "editor"].map((name) => [
        `io.github.example.${name}`,
        {
          id: `io.github.example.${name}`,
          name,
          kind: "iframe" as const,
          icon: `http://${name}.localhost/icon.svg`,
          url: `http://${name}.localhost/index.html`,
          defaultWidth: 640,
          defaultHeight: 480,
          desktop: true,
          pinned: false,
          trusted: true,
        },
      ]),
    );
    useDesktopStore.setState({
      apps,
      defaultResourceHandlers: {},
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.startsWith("/api/v1/host/files")) {
          return Response.json({
            revision: 3,
            rootEntryId: rootId,
            parent: {
              entryId: rootId,
              name: "",
              kind: "directory",
              mtimeMs: 0,
            },
            entries: [
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
        if (url.endsWith("/resolve")) {
          return Response.json({
            entryId: fileId,
            name: "note.txt",
            extension: ".txt",
            revision: 3,
            requestedAction: "edit",
            effectiveAction: "edit",
            candidates: [
              {
                appId: "io.github.example.notes",
                appName: "Notes",
                handler: {
                  id: "text",
                  actions: ["edit"],
                  extensions: [".txt"],
                  access: "read-write",
                },
              },
              {
                appId: "io.github.example.editor",
                appName: "Editor",
                handler: {
                  id: "plain",
                  actions: ["edit"],
                  extensions: [".txt"],
                  access: "read-write",
                },
              },
            ],
          });
        }
        return Response.json(
          {
            targetAppId: "io.github.example.editor",
            launchId: "l".repeat(43),
            expiresAt: "2026-07-29T12:05:00.000Z",
          },
          { status: 201 },
        );
      }),
    );

    render(<FileManagerBrowser instanceToken={"a".repeat(43)} />);
    await user.dblClick(await screen.findByText("note.txt"));
    const dialog = await screen.findByRole("dialog", {
      name: "打开“note.txt”",
    });
    await user.click(within(dialog).getByText("Editor"));
    await user.click(
      within(dialog).getByRole("checkbox", {
        name: /始终使用所选应用编辑/,
      }),
    );
    await user.click(within(dialog).getByRole("button", { name: "打开" }));

    await waitFor(() =>
      expect(
        useDesktopStore.getState().defaultResourceHandlers[
          "extension:.txt:edit"
        ],
      ).toEqual({
        appId: "io.github.example.editor",
        handlerId: "plain",
      }),
    );
  });

  it("reports missing handlers and a busy target without changing files", async () => {
    const user = userEvent.setup();
    const fileId = "4".repeat(32);
    useDesktopStore.setState({
      apps: {
        "io.github.example.viewer": {
          id: "io.github.example.viewer",
          name: "Viewer",
          kind: "iframe",
          icon: "http://viewer.localhost/icon.svg",
          url: "http://viewer.localhost/index.html",
          defaultWidth: 640,
          defaultHeight: 480,
          desktop: true,
          pinned: false,
          trusted: true,
        },
      },
      defaultResourceHandlers: {},
    });
    let hasCandidate = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.startsWith("/api/v1/host/files")) {
          return Response.json({
            revision: 3,
            rootEntryId: rootId,
            parent: {
              entryId: rootId,
              name: "",
              kind: "directory",
              mtimeMs: 0,
            },
            entries: [
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
        if (url.endsWith("/resolve")) {
          return Response.json({
            entryId: fileId,
            name: "note.txt",
            extension: ".txt",
            revision: 3,
            requestedAction: "edit",
            effectiveAction: hasCandidate ? "open" : "edit",
            candidates: hasCandidate
              ? [
                  {
                    appId: "io.github.example.viewer",
                    appName: "Viewer",
                    handler: {
                      id: "text",
                      actions: ["open"],
                      extensions: [".txt"],
                      access: "read",
                    },
                  },
                ]
              : [],
          });
        }
        return Response.json(
          {
            error: {
              code: "RESOURCE_OPEN_BUSY",
              message: "busy",
            },
          },
          { status: 409 },
        );
      }),
    );

    render(<FileManagerBrowser instanceToken={"a".repeat(43)} />);
    await user.dblClick(await screen.findByText("note.txt"));
    expect(
      await screen.findByText("没有能够打开“note.txt”的应用。"),
    ).toBeVisible();

    hasCandidate = true;
    await user.dblClick(screen.getByText("note.txt"));
    expect(
      await screen.findByText(
        "目标应用仍有一个未处理的打开请求，请稍后重试。",
      ),
    ).toBeVisible();
    expect(windowMocks.openApp).not.toHaveBeenCalled();
  });
});
