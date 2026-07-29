import { describe, expect, it } from "vitest";
import {
  parseResourceSessionRequest,
  RESOURCE_SESSION_MAX_MESSAGE_BYTES,
  RESOURCE_SESSION_PROTOCOL,
} from "./protocol";

describe("Resource Session protocol", () => {
  it("accepts only known, correlated requests", () => {
    const request = {
      protocol: RESOURCE_SESSION_PROTOCOL,
      requestId: "request-1",
      method: "resource.open",
      params: { access: "read" },
    };
    expect(parseResourceSessionRequest(request)).toEqual(request);
    expect(
      parseResourceSessionRequest({ ...request, method: "resource.private" }),
    ).toBeNull();
    expect(
      parseResourceSessionRequest({ ...request, requestId: "bad id" }),
    ).toBeNull();
    expect(
      parseResourceSessionRequest({
        ...request,
        params: { value: "x".repeat(RESOURCE_SESSION_MAX_MESSAGE_BYTES) },
      }),
    ).toBeNull();
  });
});
