import { describe, expect, it } from "vitest";
import {
  ByteRangeError,
  parseSingleByteRange,
} from "./byteRange.js";

describe("parseSingleByteRange", () => {
  it("leaves a request without Range as a full response", () => {
    expect(parseSingleByteRange(undefined, 100)).toBeNull();
    expect(parseSingleByteRange(undefined, 0)).toBeNull();
  });

  it("normalizes bounded, open-ended, and suffix ranges", () => {
    expect(parseSingleByteRange("bytes=10-19", 100)).toEqual({
      start: 10,
      endInclusive: 19,
      length: 10,
    });
    expect(parseSingleByteRange("bytes=90-", 100)).toEqual({
      start: 90,
      endInclusive: 99,
      length: 10,
    });
    expect(parseSingleByteRange("bytes=-10", 100)).toEqual({
      start: 90,
      endInclusive: 99,
      length: 10,
    });
  });

  it("clamps an end or suffix beyond the resource size", () => {
    expect(parseSingleByteRange("bytes=95-999", 100)).toEqual({
      start: 95,
      endInclusive: 99,
      length: 5,
    });
    expect(parseSingleByteRange("bytes=-999", 100)).toEqual({
      start: 0,
      endInclusive: 99,
      length: 100,
    });
  });

  it.each([
    "",
    "items=0-1",
    "bytes=",
    "bytes=-",
    "bytes=1-2,4-5",
    "bytes= 1-2",
    "bytes=1 -2",
    "bytes=9007199254740992-",
  ])("rejects invalid syntax: %s", (header) => {
    expect(() => parseSingleByteRange(header, 100)).toThrowError(
      expect.objectContaining<Partial<ByteRangeError>>({
        code: "RANGE_INVALID",
      }),
    );
  });

  it.each([
    ["bytes=100-", 100],
    ["bytes=20-10", 100],
    ["bytes=-0", 100],
    ["bytes=0-0", 0],
  ] as const)("rejects an unsatisfiable range: %s", (header, size) => {
    expect(() => parseSingleByteRange(header, size)).toThrowError(
      expect.objectContaining<Partial<ByteRangeError>>({
        code: "RANGE_NOT_SATISFIABLE",
      }),
    );
  });
});
