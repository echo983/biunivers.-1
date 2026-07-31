import { describe, expect, it } from "vitest";
import {
  bwaInstanceOrigin,
  bwaOriginLabel,
  requestHostMatchesBwaInstance,
} from "./bwaOrigin.js";

const instanceIdHex = "11".repeat(16);

describe("BWA browser origin", () => {
  it("derives one stable opaque subdomain per Instance", () => {
    const label = bwaOriginLabel(instanceIdHex);
    expect(label).toMatch(/^bwa-[0-9a-f]{40}$/);
    expect(bwaInstanceOrigin("http://localhost:8081", instanceIdHex)).toBe(
      `http://${label}.localhost:8081`,
    );
    expect(
      requestHostMatchesBwaInstance(
        `${label}.localhost:8081`,
        "http://localhost:8081",
        instanceIdHex,
      ),
    ).toBe(true);
    expect(
      requestHostMatchesBwaInstance(
        "bwa-attacker.localhost:8081",
        "http://localhost:8081",
        instanceIdHex,
      ),
    ).toBe(false);
  });
});
