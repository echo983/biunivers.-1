import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadPvlogCore } from "./pvlogCore.js";

describe("packaged PVLog Core WASM", () => {
  it("loads ABI v1 and validates every frozen object vector", async () => {
    const core = loadPvlogCore();
    const document = JSON.parse(
      await readFile(
        "docs/protocols/pvlog-cbor-v1-vectors.json",
        "utf8",
      ),
    ) as {
      vectors: Array<{ name: string; cborHex: string; fidHex: string }>;
    };
    const validators: Record<string, (bytes: Uint8Array) => void> = {
      head_v1: core.validateHead,
      segment_v1: core.validateSegment,
      checkpoint_v1: core.validateCheckpoint,
      manifest_v1: core.validateManifest,
    };

    expect(core.abiVersion()).toBe(1);
    for (const vector of document.vectors) {
      const bytes = Buffer.from(vector.cborHex, "hex");
      expect(() => validators[vector.name]?.(bytes)).not.toThrow();
      expect(core.fidHex(bytes)).toBe(vector.fidHex);
    }
  });
});
