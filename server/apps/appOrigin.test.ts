// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  appOriginLabel,
  appSpecificOrigin,
  requestHostMatchesApp,
} from "./appOrigin.js";

describe("per-app origins", () => {
  it("maps every app ID to one deterministic DNS label", () => {
    expect(appOriginLabel("io.github.example.hello")).toBe(
      "app-cd3ab3859ceac28abdef8189c8db9692c9566cd7",
    );
    expect(appOriginLabel("io.github.example.hello")).toMatch(
      /^[a-z0-9-]{1,63}$/,
    );
    expect(appOriginLabel("io.github.example.other")).not.toBe(
      appOriginLabel("io.github.example.hello"),
    );
  });

  it("preserves scheme and port while isolating the hostname", () => {
    expect(
      appSpecificOrigin(
        "http://localhost:8081",
        "io.github.example.hello",
      ),
    ).toBe(
      "http://app-cd3ab3859ceac28abdef8189c8db9692c9566cd7.localhost:8081",
    );
    expect(
      requestHostMatchesApp(
        "app-cd3ab3859ceac28abdef8189c8db9692c9566cd7.localhost:8081",
        "http://localhost:8081",
        "io.github.example.hello",
      ),
    ).toBe(true);
  });
});
