import { describe, expect, it } from "vitest";
import {
  resourceHandlerKey,
  selectResourceHandler,
} from "./defaultResourceHandlers";

const candidates = [
  { appId: "notes", handler: { id: "text" } },
  { appId: "editor", handler: { id: "plain-text" } },
];

describe("default resource handlers", () => {
  it("uses a valid default for the extension and action", () => {
    expect(
      selectResourceHandler(
        candidates,
        {
          "extension:.txt:edit": {
            appId: "editor",
            handlerId: "plain-text",
          },
        },
        ".TXT",
        "edit",
      ),
    ).toEqual(candidates[1]);
  });

  it("ignores stale defaults and only auto-selects a unique candidate", () => {
    const stale = {
      "extension:.txt:edit": {
        appId: "removed",
        handlerId: "text",
      },
    };
    expect(
      selectResourceHandler(candidates, stale, ".txt", "edit"),
    ).toBeUndefined();
    expect(
      selectResourceHandler([candidates[0]], stale, ".txt", "edit"),
    ).toEqual(candidates[0]);
  });

  it("separates open and edit association keys", () => {
    expect(resourceHandlerKey(".txt", "open")).toBe(
      "extension:.txt:open",
    );
    expect(resourceHandlerKey(".txt", "edit")).toBe(
      "extension:.txt:edit",
    );
  });
});
