import { randomUUID } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import type { ObjectKey } from "./objectStore.js";
import { S3WormObjectStore } from "./s3WormObjectStore.js";

const live = process.env.BIUNIVERS_S3_LIVE === "1";
const describeLive = live ? describe : describe.skip;

describeLive("S3WormObjectStore live contract", () => {
  it("preserves create-only semantics on the configured S3-compatible bucket", async () => {
    const bucket = requiredEnvironment("BIUNIVERS_S3_BUCKET");
    const client = new S3Client({
      endpoint: requiredEnvironment("BIUNIVERS_S3_ENDPOINT"),
      region: process.env.BIUNIVERS_S3_REGION ?? "auto",
      forcePathStyle: true,
      credentials: {
        accessKeyId: requiredEnvironment("BIUNIVERS_S3_ACCESS_KEY_ID"),
        secretAccessKey: requiredEnvironment(
          "BIUNIVERS_S3_SECRET_ACCESS_KEY",
        ),
      },
    });
    const store = new S3WormObjectStore({
      bucket,
      client,
      keyPrefix: "biunivers-contract-tests",
    });
    const original = Buffer.from(`immutable-probe:${randomUUID()}`);
    const key: ObjectKey = {
      namespace: `runs/${randomUUID()}`,
      kind: "chunks",
      fidHex: randomUUID().replaceAll("-", ""),
    };

    await expect(store.create(key, original)).resolves.toBe("created");
    await expect(store.create(key, original)).resolves.toBe(
      "already-exists-identical",
    );
    await expect(store.create(key, Buffer.from("different"))).rejects.toMatchObject(
      { code: "FID_COLLISION" },
    );
    await expect(store.get(key)).resolves.toEqual(original);
    await expect(store.head(key)).resolves.toEqual({ size: original.byteLength });
    await expect(store.list(key.namespace, key.kind)).resolves.toEqual([
      { ...key, size: original.byteLength },
    ]);

    client.destroy();
  });
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for the live S3 contract test.`);
  }
  return value;
}
