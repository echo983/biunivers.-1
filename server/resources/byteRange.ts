export interface ByteRange {
  start: number;
  endInclusive: number;
  length: number;
}

export type ByteRangeErrorCode = "RANGE_INVALID" | "RANGE_NOT_SATISFIABLE";

export class ByteRangeError extends Error {
  constructor(
    public readonly code: ByteRangeErrorCode,
    message: string,
    public readonly resourceSize?: number,
  ) {
    super(message);
    this.name = "ByteRangeError";
  }
}

export function parseSingleByteRange(
  header: string | undefined,
  size: number,
): ByteRange | null {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new ByteRangeError("RANGE_INVALID", "Resource size is invalid.");
  }
  if (header === undefined) {
    return null;
  }
  if (header.includes(",")) {
    throw invalid("Multiple byte ranges are not supported.", size);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) {
    throw invalid("Range must contain one valid bytes interval.", size);
  }
  if (size === 0) {
    throw unsatisfiable(size);
  }

  if (!match[1]) {
    const suffixLength = parseDecimal(match[2], size);
    if (suffixLength === 0) {
      throw unsatisfiable(size);
    }
    const length = Math.min(suffixLength, size);
    return {
      start: size - length,
      endInclusive: size - 1,
      length,
    };
  }

  const start = parseDecimal(match[1], size);
  if (start >= size) {
    throw unsatisfiable(size);
  }
  const requestedEnd = match[2] ? parseDecimal(match[2], size) : size - 1;
  if (requestedEnd < start) {
    throw unsatisfiable(size);
  }
  const endInclusive = Math.min(requestedEnd, size - 1);
  return {
    start,
    endInclusive,
    length: endInclusive - start + 1,
  };
}

function parseDecimal(value: string | undefined, resourceSize: number): number {
  if (!value || !/^\d+$/.test(value)) {
    throw invalid("Range contains an invalid byte position.", resourceSize);
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw invalid(
      "Range byte position exceeds the supported integer range.",
      resourceSize,
    );
  }
  return result;
}

function invalid(message: string, resourceSize?: number): ByteRangeError {
  return new ByteRangeError("RANGE_INVALID", message, resourceSize);
}

function unsatisfiable(resourceSize: number): ByteRangeError {
  return new ByteRangeError(
    "RANGE_NOT_SATISFIABLE",
    "Requested byte range cannot be satisfied.",
    resourceSize,
  );
}
