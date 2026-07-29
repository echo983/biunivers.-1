import { describe, expect, it } from "vitest";
import {
  HOST_API_MAX_MESSAGE_BYTES,
  HOST_API_PROTOCOL,
  isTrustedHostMessage,
  parseHostRequest,
  unsupportedResponse,
} from "./protocol";

const validRequest = {
  protocol: HOST_API_PROTOCOL,
  requestId: "request-1",
  method: "file.open",
  params: { accept: ["text/plain"] },
};

describe("Host API v1 protocol", () => {
  it("accepts only the frozen v1 request envelope and methods", () => {
    expect(parseHostRequest(validRequest)).toEqual(validRequest);
    expect(parseHostRequest({ ...validRequest, protocol: "other" })).toBeNull();
    expect(parseHostRequest({ ...validRequest, requestId: "../bad" })).toBeNull();
    expect(parseHostRequest({ ...validRequest, method: "admin.install" })).toBeNull();
    expect(
      parseHostRequest({ ...validRequest, params: undefined }),
    ).not.toBeNull();
  });

  it("rejects oversized control messages", () => {
    expect(
      parseHostRequest({
        ...validRequest,
        params: "x".repeat(HOST_API_MAX_MESSAGE_BYTES),
      }),
    ).toBeNull();
  });

  it("builds a correlated unsupported response", () => {
    const request = parseHostRequest(validRequest);
    expect(request && unsupportedResponse(request)).toEqual({
      protocol: HOST_API_PROTOCOL,
      requestId: "request-1",
      ok: false,
      error: {
        code: "HOST_API_UNSUPPORTED",
        message: "当前宿主尚未启用文件能力",
      },
    });
  });

  it("binds messages to both the exact origin and iframe window", () => {
    const iframeWindow = {} as Window;
    expect(
      isTrustedHostMessage(
        {
          origin: "https://app-1.apps.example.com",
          source: iframeWindow,
        },
        "https://app-1.apps.example.com",
        iframeWindow,
      ),
    ).toBe(true);
    expect(
      isTrustedHostMessage(
        {
          origin: "https://app-2.apps.example.com",
          source: iframeWindow,
        },
        "https://app-1.apps.example.com",
        iframeWindow,
      ),
    ).toBe(false);
    expect(
      isTrustedHostMessage(
        {
          origin: "https://app-1.apps.example.com",
          source: {} as Window,
        },
        "https://app-1.apps.example.com",
        iframeWindow,
      ),
    ).toBe(false);
  });
});
