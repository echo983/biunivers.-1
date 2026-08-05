import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileManagerBrowser } from "./FileManagerBrowser";
import { useDesktopStore } from "../../store/desktopStore";
import {
  queueDirectoryLaunch,
  resetDirectoryLaunchBrokerForTests,
} from "../../desktopSurface/directoryLaunchBroker";
import { useDesktopSurfaceStore } from "../../desktopSurface/store";
import type { FileTransferOptions } from "../../api/fileManagerTransfers";

type UploadLocalFile = (
  token: string,
  parentEntryId: string,
  file: File,
  options?: FileTransferOptions,
) => Promise<void>;

const transferMocks = vi.hoisted(() => ({
  uploadLocalFile: vi.fn<UploadLocalFile>(async () => {}),
  downloadFile: vi.fn(async () => {}),
  downloadZip: vi.fn(async () => "biunivers-download.zip"),
}));
const windowMocks = vi.hoisted(() => ({
  openApp: vi.fn(),
}));

vi.mock("../../api/fileManagerTransfers", () => transferMocks);
vi.mock("../../windows/windowController", () => windowMocks);

const rootId = "1".repeat(32);
const directoryId = "2".repeat(32);
const deepDirectoryId = "3".repeat(32);

beforeEach(() => {
  useDesktopSurfaceStore.setState({
    load: vi.fn(async () => {}),
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useDesktopStore.setState({
    defaultResourceHandlers: {},
  });
  resetDirectoryLaunchBrokerForTests();
  localStorage.clear();
});

describe("FileManagerBrowser", () => {
  it("adds a selected main file to an existing Workspace", async () => {
    const user = userEvent.setup();
    const fileId = "4".repeat(32);
    const workspaceId = "5".repeat(32);
    const workspaceRootId = "6".repeat(32);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/v1/host/files")) {
        return Response.json({
          revision: 7,
          rootEntryId: rootId,
          parent: { entryId: rootId, name: "", kind: "directory", mtimeMs: 0 },
          entries: [{ entryId: fileId, name: "brief.md", kind: "file", size: 12, mtimeMs: 0 }],
        });
      }
      if (url === "/api/v1/internal/workspaces") {
        return Response.json({ workspaces: [{ workspaceIdHex: workspaceId, name: "Agent project", revision: 3 }] });
      }
      if (url === `/api/v1/internal/workspaces/${workspaceId}/files`) {
        return Response.json({
          revision: 3,
          rootEntryId: workspaceRootId,
          parent: { entryId: workspaceRootId, name: "", kind: "directory", mtimeMs: 0 },
          breadcrumbs: [{ entryId: workspaceRootId, name: "", kind: "directory", mtimeMs: 0 }],
          entries: [],
        });
      }
      if (url === `/api/v1/internal/workspaces/${workspaceId}/add-from-main` && init?.method === "POST") {
        return Response.json({ revision: 4, roots: [{ sourceEntryIdHex: fileId, newEntryIdHex: "7".repeat(32), name: "brief.md" }] }, { status: 201 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<FileManagerBrowser instanceToken={"a".repeat(43)} />);

    await user.click(await screen.findByText("brief.md"));
    await user.click(screen.getByRole("button", { name: "添加到工作空间" }));
    const dialog = await screen.findByRole("dialog", { name: "添加 1 项到工作空间" });
    expect(within(dialog).getByRole("combobox")).toHaveValue(workspaceId);
    await user.click(await within(dialog).findByRole("button", { name: "添加到这里" }));
    expect(await screen.findByText("已向工作空间“Agent project”添加 1 个项目。")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/internal/workspaces/${workspaceId}/add-from-main`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          selectedEntryIds: [fileId], destinationEntryId: workspaceRootId,
          mainRevision: 7, workspaceRevision: 3,
        }),
      }),
    );
  });

  it("switches between list and icon views and persists the preference", async () => {
    const user = userEvent.setup();
    const fileId = "4".repeat(32);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          revision: 1,
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
              name: "photo.png",
              kind: "file",
              size: 12,
              mtimeMs: 0,
            },
          ],
        }),
      ),
    );

    const rendered = render(
      <FileManagerBrowser instanceToken={"a".repeat(43)} />,
    );
    expect(await screen.findByRole("cell", { name: /photo\.png/ })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "列表视图" }),
    ).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "图标视图" }));
    const icon = screen.getByRole("gridcell", { name: /photo\.png/ });
    expect(icon).toBeVisible();
    await user.click(icon);
    expect(screen.getByRole("status")).toHaveTextContent("已选择 1 项");
    expect(localStorage.getItem("biunivers.file-manager.view-mode")).toBe(
      "icons",
    );

    const grid = screen.getByRole("grid", { name: "文件" });
    vi.spyOn(grid, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 400, 300),
    );
    vi.spyOn(icon, "getBoundingClientRect").mockReturnValue(
      new DOMRect(20, 20, 80, 80),
    );
    fireEvent.pointerDown(grid, {
      button: 0,
      pointerId: 7,
      clientX: 5,
      clientY: 5,
    });
    fireEvent.pointerMove(grid, {
      pointerId: 7,
      clientX: 500,
      clientY: 600,
    });
    expect(icon).toHaveClass("is-selected");
    expect(
      document.querySelector(".file-manager-app__selection-box"),
    ).not.toBeNull();
    expect(
      document.querySelector<HTMLElement>(
        ".file-manager-app__selection-box",
      )?.style,
    ).toMatchObject({
      width: "395px",
      height: "295px",
    });
    fireEvent.pointerUp(grid, {
      pointerId: 7,
      clientX: 500,
      clientY: 600,
    });
    expect(
      document.querySelector(".file-manager-app__selection-box"),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: "列表视图" }));
    expect(screen.getByText("photo.png").closest("tr")).toHaveClass(
      "is-selected",
    );
    await user.click(screen.getByRole("button", { name: "图标视图" }));

    rendered.unmount();
    render(<FileManagerBrowser instanceToken={"a".repeat(43)} />);
    expect(
      await screen.findByRole("button", { name: "图标视图" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("Shift-selects a range without browser text selection and submits one batch move", async () => {
    const user = userEvent.setup();
    const firstId = "4".repeat(32);
    const secondId = "5".repeat(32);
    const mutations: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/v1/host/files")) {
          const nested = url.includes(`parent=${directoryId}`);
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
                    mtimeMs: 0,
                  },
                  {
                    entryId: firstId,
                    name: "first.txt",
                    kind: "file",
                    size: 1,
                    mtimeMs: 0,
                  },
                  {
                    entryId: secondId,
                    name: "second.txt",
                    kind: "file",
                    size: 1,
                    mtimeMs: 0,
                  },
                ],
          });
        }
        mutations.push({
          url,
          body: typeof init?.body === "string" ? init.body : "",
        });
        return Response.json({
          entryIds: [firstId, secondId],
          revision: 4,
        });
      }),
    );

    render(<FileManagerBrowser instanceToken={"a".repeat(43)} />);
    await user.click(await screen.findByText("first.txt"));
    const secondRow = screen.getByText("second.txt").closest("tr");
    expect(secondRow).not.toBeNull();
    expect(
      secondRow!.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          shiftKey: true,
        }),
      ),
    ).toBe(false);
    await user.keyboard("{Shift>}");
    await user.click(screen.getByText("second.txt"));
    await user.keyboard("{/Shift}");

    expect(screen.getByRole("status")).toHaveTextContent("已选择 2 项");
    expect(screen.getByRole("button", { name: "重命名" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "将 2 个项目导出为 ZIP" }),
    ).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "移动" }));
    const dialog = screen.getByRole("dialog", { name: "移动 2 项" });
    await user.click(
      within(dialog).getByRole("button", { name: "📁 Documents" }),
    );
    const moveHere = within(dialog).getByRole("button", {
      name: "移动到这里",
    });
    await waitFor(() => expect(moveHere).toBeEnabled());
    await user.click(moveHere);

    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0]).toEqual({
      url: "/api/v1/internal/files/batch/move",
      body: JSON.stringify({
        entryIds: [firstId, secondId],
        newParentEntryId: directoryId,
        expectedRevision: 3,
      }),
    });
  });

  it("shows the complete launched desktop directory ancestry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          revision: 3,
          rootEntryId: rootId,
          parent: {
            entryId: deepDirectoryId,
            name: "Notes",
            kind: "directory",
            mtimeMs: 0,
          },
          breadcrumbs: [
            {
              entryId: directoryId,
              name: "Documents",
              kind: "directory",
              mtimeMs: 0,
            },
            {
              entryId: deepDirectoryId,
              name: "Notes",
              kind: "directory",
              mtimeMs: 0,
            },
          ],
          entries: [],
        }),
      ),
    );
    queueDirectoryLaunch(deepDirectoryId, "Notes");

    render(<FileManagerBrowser instanceToken={"a".repeat(43)} />);

    const breadcrumbs = await screen.findByRole("navigation", {
      name: "当前位置",
    });
    expect(
      within(breadcrumbs).getByRole("button", { name: "Documents" }),
    ).toBeVisible();
    expect(
      within(breadcrumbs).getByRole("button", { name: "Notes" }),
    ).toBeVisible();
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/host/files?parent=${deepDirectoryId}`,
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
  });

  it("creates an empty file and copies a file only once per submit", async () => {
    const user = userEvent.setup();
    const fileId = "4".repeat(32);
    const mutations: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
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
        mutations.push({
          url,
          body: typeof init?.body === "string" ? init.body : "",
        });
        return Response.json(
          { entryId: "5".repeat(32), revision: 4 },
          { status: 201 },
        );
      }),
    );

    render(<FileManagerBrowser instanceToken={"a".repeat(43)} />);
    await screen.findByText("note.txt");

    await user.click(screen.getByRole("button", { name: "新建文件" }));
    const createDialog = screen.getByRole("dialog", { name: "新建文件" });
    expect(within(createDialog).getByLabelText("名称")).toHaveValue(
      "未命名.txt",
    );
    const createButton = within(createDialog).getByRole("button", {
      name: "确定",
    });
    act(() => {
      createButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      createButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0]).toEqual({
      url: "/api/v1/internal/files/files",
      body: JSON.stringify({
        parentEntryId: rootId,
        name: "未命名.txt",
        expectedRevision: 3,
      }),
    });

    await user.click(await screen.findByText("note.txt"));
    await user.click(screen.getByRole("button", { name: "复制" }));
    const copyDialog = screen.getByRole("dialog", { name: "复制文件" });
    expect(within(copyDialog).getByLabelText("名称")).toHaveValue(
      "note - 副本.txt",
    );
    await user.click(
      within(copyDialog).getByRole("button", { name: "确定" }),
    );
    await waitFor(() => expect(mutations).toHaveLength(2));
    expect(mutations[1]).toEqual({
      url: `/api/v1/internal/files/entries/${fileId}/copies`,
      body: JSON.stringify({
        newParentEntryId: rootId,
        newName: "note - 副本.txt",
        expectedRevision: 3,
      }),
    });
  });

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
    useDesktopSurfaceStore.setState({
      surface: {
        schemaVersion: 1,
        revision: 2,
        items: [
          {
            id: "5".repeat(32),
            target: { type: "file", handle: fileId },
            position: { x: 0, y: 0 },
            createdAtMs: 1,
            resolved: {
              available: true,
              name: "note.txt",
              kind: "file",
              fileRevision: 3,
            },
          },
        ],
      },
    });
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
    expect(
      useDesktopSurfaceStore.getState().surface.items[0].resolved.name,
    ).toBe("renamed.txt");

    await user.click(await screen.findByText("note.txt"));
    await user.click(screen.getByRole("button", { name: "移动" }));
    const moveDialog = screen.getByRole("dialog", {
      name: "移动“note.txt”",
    });
    const targetDirectory = within(moveDialog).getByRole("button", {
      name: "📁 Documents",
    });
    act(() => {
      targetDirectory.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      targetDirectory.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(
      within(moveDialog).getAllByRole("button", { name: "Documents" }),
    ).toHaveLength(1);
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
    expect(
      useDesktopSurfaceStore.getState().surface.items[0].resolved,
    ).toMatchObject({
      available: false,
      reason: "文件或目录不存在",
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
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          onProgress: expect.any(Function),
        }),
      ),
    );
    expect(
      await screen.findByText("已上传 1 个文件。"),
    ).toBeInTheDocument();

    await user.click(screen.getByText("note.txt"));
    await user.click(screen.getByRole("button", { name: "下载文件" }));
    await waitFor(() =>
      expect(transferMocks.downloadFile).toHaveBeenCalledWith(
        "a".repeat(43),
        expect.objectContaining({
          entryId: fileId,
          name: "note.txt",
        }),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          onProgress: expect.any(Function),
        }),
      ),
    );
    expect(
      await screen.findByText("已下载“note.txt”。"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭提示" }));
    expect(
      screen.queryByText("已下载“note.txt”。"),
    ).not.toBeInTheDocument();
  });

  it("exports a selected directory through the existing download button", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          revision: 8,
          rootEntryId: rootId,
          parent: {
            entryId: rootId,
            name: "",
            kind: "directory",
            mtimeMs: 0,
          },
          entries: [{
            entryId: directoryId,
            name: "资料",
            kind: "directory",
            mtimeMs: 100,
          }],
        }),
      ),
    );
    transferMocks.downloadZip.mockResolvedValueOnce("资料.zip");

    render(<FileManagerBrowser instanceToken={"a".repeat(43)} />);
    await user.click(await screen.findByText("资料"));
    await user.click(
      screen.getByRole("button", { name: "将目录导出为 ZIP" }),
    );

    await waitFor(() =>
      expect(transferMocks.downloadZip).toHaveBeenCalledWith(
        "a".repeat(43),
        [expect.objectContaining({
          entryId: directoryId,
          name: "资料",
          kind: "directory",
        })],
        8,
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          onProgress: expect.any(Function),
        }),
      ),
    );
    expect(await screen.findByText("已下载“资料.zip”。")).toBeInTheDocument();
  });

  it("shows transfer progress and cancels the active upload", async () => {
    const user = userEvent.setup();
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
          entries: [],
        }),
      ),
    );
    transferMocks.uploadLocalFile.mockImplementationOnce(
      async (_token, _parent, file, options) => {
        const transferOptions = options as {
          signal: AbortSignal;
          onProgress: (progress: { loaded: number; total: number }) => void;
        };
        transferOptions.onProgress({ loaded: 3, total: file.size });
        await new Promise<void>((_resolve, reject) => {
          transferOptions.signal.addEventListener("abort", () => {
            reject(new DOMException("cancelled", "AbortError"));
          });
        });
      },
    );

    render(<FileManagerBrowser instanceToken={"a".repeat(43)} />);
    await screen.findByText("此文件夹为空。");
    await user.upload(
      screen.getByLabelText("选择要上传的文件"),
      new File(["123456"], "large.bin"),
    );

    expect(await screen.findByText(/正在上传 1\/1/)).toBeInTheDocument();
    expect(screen.getByText("3 B / 6 B · 50%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "上传进度" })).toHaveValue(
      3,
    );
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(await screen.findByText("上传已取消。")).toBeInTheDocument();
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
