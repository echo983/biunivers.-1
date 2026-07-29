import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { xxhash128 } from "hash-wasm";

const vectorsUrl = new URL(
  "../docs/protocols/pvlog-cbor-v1-vectors.json",
  import.meta.url,
);
const document = JSON.parse(await readFile(fileURLToPath(vectorsUrl), "utf8"));
const generated = spawnSync(
  "cargo",
  [
    "run",
    "--quiet",
    "--manifest-path",
    "crates/pvlog-core/Cargo.toml",
    "--example",
    "generate_vectors",
  ],
  { encoding: "utf8" },
);

assert.equal(generated.status, 0, generated.stderr || "Rust vector generator failed");
const rustVectors = new Map(
  generated.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [name, cborHex, fidHex] = line.split("\t");
      return [name, { cborHex, fidHex }];
    }),
);

assert.equal(document.hash.algorithm, "XXH3-128");
assert.equal(document.hash.seed, 0);
assert.equal(rustVectors.size, document.vectors.length);

for (const vector of document.vectors) {
  assert.match(vector.cborHex, /^(?:[0-9a-f]{2})+$/);
  assert.match(vector.fidHex, /^[0-9a-f]{32}$/);
  const actual = await xxhash128(Buffer.from(vector.cborHex, "hex"), 0, 0);
  assert.equal(actual, vector.fidHex, `${vector.name} FID mismatch`);
  assert.deepEqual(
    rustVectors.get(vector.name),
    { cborHex: vector.cborHex, fidHex: vector.fidHex },
    `${vector.name} Rust encoding drifted from the frozen vector`,
  );
}

console.log(`Verified ${document.vectors.length} PVLogS3Lite CBOR v1 vectors.`);
