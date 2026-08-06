#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

version="${BIUNIVERS_RELEASE_VERSION:-v$(node -p 'require("./package.json").version')}"
output_root="${BIUNIVERS_RELEASE_OUTPUT:-$PWD/release}"
node_bin="${BIUNIVERS_RELEASE_NODE:-$(command -v node || true)}"

if [[ ! "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "BIUNIVERS_RELEASE_VERSION must be a stable vMAJOR.MINOR.PATCH value." >&2
  exit 1
fi
if [[ -z "$node_bin" || "$($node_bin --version)" != v24.* ]]; then
  echo "Node.js 24 is required to build a Debian Runtime release." >&2
  exit 1
fi
for command in npm cargo git tar zstd sha256sum; do
  command -v "$command" >/dev/null || { echo "Missing build command: $command" >&2; exit 1; }
done
if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo "The V0.16 release builder only supports Linux x86_64." >&2
  exit 1
fi

staging="$(mktemp -d)"
trap 'rm -rf -- "$staging"' EXIT
release_dir="$staging/biunivers-runtime-$version-linux-x64"
mkdir -p "$release_dir/app" "$release_dir/bin" "$release_dir/node/bin" "$release_dir/deploy"

echo "Building Biunivers server and Runtime binaries..."
PATH="$(dirname "$node_bin"):$PATH" "$node_bin" "$(command -v npm)" run build:server
cargo build --locked --release --manifest-path crates/pvlogfs/Cargo.toml
cargo build --locked --release --manifest-path crates/workspace-cow/Cargo.toml

cp package.json package-lock.json "$release_dir/app/"
cp "$node_bin" "$release_dir/node/bin/node"
(
  cd "$release_dir/app"
  PATH="$release_dir/node/bin:$PATH" "$node_bin" "$(command -v npm)" \
    ci --omit=dev --ignore-scripts
  PATH="$release_dir/node/bin:$PATH" "$node_bin" "$(command -v npm)" \
    rebuild better-sqlite3
  PATH="$release_dir/node/bin:$PATH" "$node_bin" "$(command -v npm)" \
    audit --omit=dev --audit-level=high
)
mkdir -p "$release_dir/app/dist"
cp -a dist/server "$release_dir/app/dist/"
cp -a generated "$release_dir/app/"
cp crates/pvlogfs/target/release/biunivers-pvlogfs "$release_dir/bin/"
cp crates/workspace-cow/target/release/biunivers-workspace-cow-scan "$release_dir/bin/"
cp -a deploy/. "$release_dir/deploy/"

(
  cd "$staging"
  RELEASE_APP="$release_dir/app" "$release_dir/node/bin/node" --input-type=module <<'NODE'
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(pathToFileURL(`${process.env.RELEASE_APP}/package.json`));
const Database = require("better-sqlite3");
require("hash-wasm");
const { loadPvlogCore } = await import(
  pathToFileURL(`${process.env.RELEASE_APP}/dist/server/files/pvlogCore.js`)
);
const database = new Database(":memory:");
database.prepare("SELECT 1").get();
database.close();
if (loadPvlogCore().abiVersion() !== 1) throw new Error("PVLog Core ABI smoke test failed.");
NODE
)

host_image="${BIUNIVERS_RELEASE_HOST_IMAGE:-ghcr.io/echo983/biunivers:$version}"
host_digest="${BIUNIVERS_RELEASE_HOST_DIGEST:-}"
diagnostic_image="${BIUNIVERS_RELEASE_DIAGNOSTIC_IMAGE:-ghcr.io/echo983/biunivers-runtime-diagnostic:$version}"
diagnostic_digest="${BIUNIVERS_RELEASE_DIAGNOSTIC_DIGEST:-}"
if [[ -n "$host_digest" && ! "$host_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "BIUNIVERS_RELEASE_HOST_DIGEST must be sha256:<64 lowercase hex>." >&2
  exit 1
fi
if [[ -n "$diagnostic_digest" && ! "$diagnostic_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "BIUNIVERS_RELEASE_DIAGNOSTIC_DIGEST must be sha256:<64 lowercase hex>." >&2
  exit 1
fi

VERSION="$version" HOST_IMAGE="$host_image" HOST_DIGEST="$host_digest" \
DIAGNOSTIC_IMAGE="$diagnostic_image" DIAGNOSTIC_DIGEST="$diagnostic_digest" \
COMMIT="$(git rev-parse HEAD)" NODE_VERSION="$($node_bin --version)" \
  "$node_bin" --input-type=module > "$release_dir/release.json" <<'NODE'
const value = {
  schemaVersion: 1,
  version: process.env.VERSION,
  platform: "linux",
  architecture: "x64",
  nodeVersion: process.env.NODE_VERSION,
  hostImage: process.env.HOST_IMAGE,
  hostDigest: process.env.HOST_DIGEST || null,
  diagnosticImage: process.env.DIAGNOSTIC_IMAGE,
  diagnosticDigest: process.env.DIAGNOSTIC_DIGEST || null,
  refStoreSchema: { minimum: 6, maximum: 6 },
  commit: process.env.COMMIT,
};
process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
NODE

chmod 0755 "$release_dir/node/bin/node" "$release_dir/bin/"* "$release_dir/deploy/bin/"*
mkdir -p "$output_root"
asset="$output_root/biunivers-runtime-$version-linux-x64.tar.zst"
tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
  -C "$staging" -cf - "$(basename "$release_dir")" | zstd -19 -T0 -o "$asset"
(
  cd "$output_root"
  sha256sum "$(basename "$asset")" > SHA256SUMS
)

echo "Created $asset"
echo "Created $output_root/SHA256SUMS"
