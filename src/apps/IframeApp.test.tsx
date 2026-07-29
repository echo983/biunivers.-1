import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDefinition } from "../types/desktop";
import {
  pendingResourceLaunch,
  queueResourceLaunch,
  resetResourceLaunchBrokerForTests,
} from "../openResource/launchBroker";
import { OpenResourceClientError } from "../openResource/openResourceClient";
import { useDesktopStore } from "../store/desktopStore";

const mocks = vi.hoisted(() => ({
  claimResourceLaunch: vi.fn(),
  closeHostInstance: vi.fn(),
  createHostInstance: vi.fn(),
}));

vi.mock("../openResource/openResourceClient", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../openResource/openResourceClient")>();
  return {
    ...original,
    claimResourceLaunch: mocks.claimResourceLaunch,
  };
});

vi.mock("../hostApi/instanceClient", () => ({
  closeHostInstance: mocks.closeHostInstance,
  createHostInstance: mocks.createHostInstance,
}));

import { IframeApp } from "./IframeApp";

const app: AppDefinition = {
  id: "io.github.example.notes",
  name: "Notes",
  kind: "iframe",
  icon: "http://notes.localhost:8081/icon.svg",
  url: "http://notes.localhost:8081/index.html",
  defaultWidth: 640,
  defaultHeight: 480,
  desktop: true,
  pinned: false,
  trusted: true,
};

function request(iframe: HTMLIFrameElement, origin = "http://notes.localhost:8081") {
  window.dispatchEvent(
    new MessageEvent("message", {
      origin,
      source: iframe.contentWindow,
      data: {
        protocol: "biunivers.open-resource/1",
        requestId: "request-1",
        method: "launch.getContext",
        params: {},
      },
    }),
  );
}

describe("IframeApp Open Resource delivery", () => {
  beforeEach(() => {
    useDesktopStore.setState({ activeAppId: null });
    resetResourceLaunchBrokerForTests();
    mocks.createHostInstance.mockResolvedValue({
      instanceToken: "i".repeat(43),
      expiresAt: "2026-07-29T12:00:00.000Z",
    });
    mocks.claimResourceLaunch.mockResolvedValue({
      action: "edit",
      resource: {
        handleId: "h".repeat(43),
        name: "note.txt",
        permissions: ["read", "write"],
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shields an inactive iframe and exposes it after activation", async () => {
    render(<IframeApp app={app} />);
    expect(screen.getByTestId("iframe-activation-shield")).toBeInTheDocument();

    act(() => useDesktopStore.getState().setActiveApp(app.id));

    await waitFor(() =>
      expect(
        screen.queryByTestId("iframe-activation-shield"),
      ).not.toBeInTheDocument(),
    );
  });

  it("notifies an existing iframe and returns a claimed context", async () => {
    render(<IframeApp app={app} />);
    const iframe = screen.getByTitle("Notes") as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");

    queueResourceLaunch(app.id, "l".repeat(43));
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        {
          protocol: "biunivers.open-resource/1",
          event: "launch.contextAvailable",
        },
        "http://notes.localhost:8081",
      ),
    );

    request(iframe);
    await waitFor(() =>
      expect(mocks.claimResourceLaunch).toHaveBeenCalledWith(
        "i".repeat(43),
        "l".repeat(43),
      ),
    );
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          protocol: "biunivers.open-resource/1",
          requestId: "request-1",
          ok: true,
        }),
        "http://notes.localhost:8081",
      ),
    );
    expect(pendingResourceLaunch(app.id)).toBeUndefined();
  });

  it("allows startup getContext even if an early notification was missed", async () => {
    queueResourceLaunch(app.id, "l".repeat(43));
    render(<IframeApp app={app} />);
    const iframe = screen.getByTitle("Notes") as HTMLIFrameElement;
    request(iframe);
    await waitFor(() =>
      expect(mocks.claimResourceLaunch).toHaveBeenCalledWith(
        "i".repeat(43),
        "l".repeat(43),
      ),
    );
    expect(pendingResourceLaunch(app.id)).toBeUndefined();
  });

  it("ignores another origin and retains a launch after network failure", async () => {
    mocks.claimResourceLaunch.mockRejectedValue(
      new OpenResourceClientError(
        "NETWORK_ERROR",
        "offline",
        false,
      ),
    );
    render(<IframeApp app={app} />);
    const iframe = screen.getByTitle("Notes") as HTMLIFrameElement;
    queueResourceLaunch(app.id, "l".repeat(43));

    request(iframe, "https://attacker.example");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.claimResourceLaunch).not.toHaveBeenCalled();

    request(iframe);
    await waitFor(() =>
      expect(mocks.claimResourceLaunch).toHaveBeenCalledOnce(),
    );
    expect(pendingResourceLaunch(app.id)).toBe("l".repeat(43));
  });
});
