export const OBJECT_KINDS = [
  "heads",
  "segments",
  "checkpoints",
  "manifests",
  "chunks",
] as const;

export type ObjectKind = (typeof OBJECT_KINDS)[number];

export interface ObjectKey {
  namespace: string;
  kind: ObjectKind;
  fidHex: string;
}

export interface ObjectMetadata {
  size: number;
}

export interface ObjectListItem extends ObjectKey, ObjectMetadata {}

export type CreateObjectResult = "created" | "already-exists-identical";

export interface ImmutableObjectStore {
  create(key: ObjectKey, completeBytes: Uint8Array): Promise<CreateObjectResult>;
  get(key: ObjectKey): Promise<Uint8Array>;
  head(key: ObjectKey): Promise<ObjectMetadata>;
  list(namespace: string, kind?: ObjectKind): Promise<ObjectListItem[]>;
}

export type ObjectStoreErrorCode =
  | "INVALID_OBJECT_KEY"
  | "OBJECT_NOT_FOUND"
  | "FID_COLLISION";

export class ObjectStoreError extends Error {
  constructor(
    public readonly code: ObjectStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ObjectStoreError";
  }
}

const namespaceSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const fidPattern = /^[0-9a-f]{32}$/;

export function validateNamespace(namespace: string): string[] {
  const segments = namespace.split("/");
  if (
    namespace.length === 0 ||
    namespace.length > 512 ||
    segments.some((segment) => !namespaceSegmentPattern.test(segment))
  ) {
    throw new ObjectStoreError(
      "INVALID_OBJECT_KEY",
      "Object namespace contains an invalid segment.",
    );
  }
  return segments;
}

export function validateObjectKey(key: ObjectKey): void {
  validateNamespace(key.namespace);
  if (!OBJECT_KINDS.includes(key.kind)) {
    throw new ObjectStoreError(
      "INVALID_OBJECT_KEY",
      "Object kind is not supported.",
    );
  }
  if (!fidPattern.test(key.fidHex)) {
    throw new ObjectStoreError(
      "INVALID_OBJECT_KEY",
      "Object FID must be 32 lowercase hexadecimal characters.",
    );
  }
}
