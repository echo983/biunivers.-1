import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

function readBearer(value: string | undefined) {
  if (!value) {
    return null;
  }
  const match = /^Bearer ([^\s]+)$/.exec(value);
  return match?.[1] ?? null;
}

export function createAdminAuth(expectedToken: string): RequestHandler {
  const expectedDigest = digest(expectedToken);

  return (request, response, next) => {
    const token = readBearer(request.header("authorization"));
    if (!token || !timingSafeEqual(digest(token), expectedDigest)) {
      response.status(401).json({
        error: {
          code: "ADMIN_AUTH_REQUIRED",
          message: "需要有效的管理员凭据",
        },
      });
      return;
    }
    next();
  };
}
