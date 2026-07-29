import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import type { ObjectKey } from "./objectStore.js";
import { S3WormObjectStore } from "./s3WormObjectStore.js";

const key: ObjectKey = {
  namespace: "users/alice",
  kind: "chunks",
  fidHex: "0123456789abcdef0123456789abcdef",
};
const objectKey =
  "pvlog/users/alice/objects/chunks/xxh3-128/01/0123456789abcdef0123456789abcdef";

function createStore(send: ReturnType<typeof vi.fn>) {
  return new S3WormObjectStore({
    bucket: "test-bucket",
    client: { send } as unknown as S3Client,
    keyPrefix: "/pvlog/",
  });
}

function serviceError(name: string, status: number) {
  return Object.assign(new Error(name), {
    name,
    $metadata: { httpStatusCode: status },
  });
}

describe("S3WormObjectStore", () => {
  it("uses a conditional create and the frozen object key layout", async () => {
    const send = vi.fn().mockResolvedValue({});
    const store = createStore(send);

    await expect(store.create(key, Buffer.from("bytes"))).resolves.toBe("created");
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: "test-bucket",
      Key: objectKey,
      ContentLength: 5,
      IfNoneMatch: "*",
    });
  });

  it("accepts an identical object after a failed create-only precondition", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(serviceError("PreconditionFailed", 412))
      .mockResolvedValueOnce({
        Body: {
          transformToByteArray: async () => Uint8Array.from(Buffer.from("same")),
        },
      });
    const store = createStore(send);

    await expect(store.create(key, Buffer.from("same"))).resolves.toBe(
      "already-exists-identical",
    );
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(GetObjectCommand);
  });

  it("reports a collision instead of overwriting different existing bytes", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(serviceError("PreconditionFailed", 412))
      .mockResolvedValueOnce({
        Body: {
          transformToByteArray: async () =>
            Uint8Array.from(Buffer.from("different")),
        },
      });
    const store = createStore(send);

    await expect(store.create(key, Buffer.from("new"))).rejects.toMatchObject({
      code: "FID_COLLISION",
    });
  });

  it("maps missing reads and preserves object metadata", async () => {
    const missingStore = createStore(
      vi.fn().mockRejectedValue(serviceError("NoSuchKey", 404)),
    );
    await expect(missingStore.get(key)).rejects.toMatchObject({
      code: "OBJECT_NOT_FOUND",
    });

    const send = vi.fn().mockResolvedValue({ ContentLength: 123 });
    await expect(createStore(send).head(key)).resolves.toEqual({ size: 123 });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
  });

  it("passes exact byte ranges through to S3", async () => {
    const send = vi.fn().mockResolvedValue({
      ContentLength: 4,
      ContentRange: "bytes 10-13/64",
      Body: {
        transformToByteArray: async () => Uint8Array.from([10, 11, 12, 13]),
      },
    });
    await expect(createStore(send).getRange(key, 10, 13, 64)).resolves.toEqual(
      Uint8Array.from([10, 11, 12, 13]),
    );
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: "test-bucket",
      Key: objectKey,
      Range: "bytes=10-13",
    });
  });

  it("paginates diagnostic lists and ignores malformed keys", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        IsTruncated: true,
        NextContinuationToken: "next",
        Contents: [{ Key: objectKey, Size: 5 }],
      })
      .mockResolvedValueOnce({
        IsTruncated: false,
        Contents: [
          {
            Key: `${objectKey.slice(0, -32)}ff/not-an-object`,
            Size: 9,
          },
        ],
      });
    const store = createStore(send);

    await expect(store.list("users/alice", "chunks")).resolves.toEqual([
      { ...key, size: 5 },
    ]);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(ListObjectsV2Command);
    expect(send.mock.calls[1]?.[0].input.ContinuationToken).toBe("next");
  });
});
