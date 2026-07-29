import { describe, expect, it } from "vitest";
import {
  OPEN_RESOURCE_PROTOCOL,
  parseOpenResourceRequest,
} from "./protocol";

describe("Open Resource client protocol", () => {
  it("accepts only the frozen getContext request shape", () => {
    const request = {
      protocol: OPEN_RESOURCE_PROTOCOL,
      requestId: "request-1",
      method: "launch.getContext",
      params: {},
    };
    expect(parseOpenResourceRequest(request)).toEqual(request);
    expect(
      parseOpenResourceRequest({ ...request, params: { extra: true } }),
    ).toBeNull();
    expect(
      parseOpenResourceRequest({ ...request, method: "launch.private" }),
    ).toBeNull();
  });
});
