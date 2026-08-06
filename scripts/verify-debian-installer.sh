#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

grep -Fq 'BIUNIVERS_GITHUB_REPOSITORY:-echo983/biunivers}' deploy/install.sh

for command in node tar zstd sha256sum; do
  command -v "$command" >/dev/null || { echo "Missing verification command: $command" >&2; exit 1; }
done

test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT
version="v9.9.9"
release_name="biunivers-runtime-$version-linux-x64"
fixture="$test_root/fixture/$release_name"
assets="$test_root/assets"
target="$test_root/target"
digest_one="$(printf '1%.0s' {1..64})"
digest_two="$(printf '2%.0s' {1..64})"
mkdir -p \
  "$fixture/node/bin" \
  "$fixture/app/dist/server/files" \
  "$fixture/bin" \
  "$fixture/deploy" \
  "$assets" \
  "$target"

cp "$(command -v node)" "$fixture/node/bin/node"
cp -a deploy/. "$fixture/deploy/"
touch \
  "$fixture/app/dist/server/files/fileServiceGenesisCli.js" \
  "$fixture/bin/biunivers-pvlogfs" \
  "$fixture/bin/biunivers-workspace-cow-scan"
chmod 0755 "$fixture/node/bin/node" "$fixture/bin/"*

VERSION="$version" node --input-type=module > "$fixture/release.json" <<'NODE'
const version = process.env.VERSION;
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  version,
  platform: "linux",
  architecture: "x64",
  nodeVersion: process.version,
  hostImage: `ghcr.io/echo983/biunivers:${version}`,
  hostDigest: `sha256:${"1".repeat(64)}`,
  diagnosticImage: `ghcr.io/echo983/biunivers-runtime-diagnostic:${version}`,
  diagnosticDigest: `sha256:${"2".repeat(64)}`,
  refStoreSchema: { minimum: 6, maximum: 6 },
  commit: "0".repeat(40),
}, null, 2)}\n`);
NODE

asset="$assets/$release_name.tar.zst"
tar -C "$test_root/fixture" -cf - "$release_name" | zstd -q -o "$asset"
(
  cd "$assets"
  sha256sum "$(basename "$asset")" > SHA256SUMS
)

bash deploy/install.sh \
  --version "$version" \
  --release-dir "$assets" \
  --root "$target" \
  --stage-only

test -L "$target/opt/biunivers/current"
test "$(readlink "$target/opt/biunivers/current")" = "releases/$version"
test -x "$target/opt/biunivers/releases/$version/deploy/bin/biunivers-runtime"
test -f "$target/etc/systemd/system/biunivers-runtime.service"
test -f "$target/etc/systemd/system/biunivers-host.service"
test -x "$target/usr/local/sbin/biunivers-update"
grep -q "BIUNIVERS_HOST_IMAGE=ghcr.io/echo983/biunivers@sha256:$digest_one" \
  "$target/etc/biunivers/release"
grep -q "BIUNIVERS_DIAGNOSTIC_EXECUTOR_IMAGE=ghcr.io/echo983/biunivers-runtime-diagnostic@sha256:$digest_two" \
  "$target/etc/biunivers/release"

# Reinstalling the exact same immutable version is idempotent and lets a user
# continue after editing the generated environment template.
bash deploy/install.sh \
  --version "$version" \
  --release-dir "$assets" \
  --root "$target" \
  --stage-only >/dev/null

cp "$assets/SHA256SUMS" "$assets/SHA256SUMS.valid"
printf '%064d  %s\n' 0 "$(basename "$asset")" > "$assets/SHA256SUMS"
if bash deploy/install.sh \
  --version "$version" \
  --release-dir "$assets" \
  --root "$test_root/rejected" \
  --stage-only >/dev/null 2>&1; then
  echo "Installer accepted an invalid Release checksum." >&2
  exit 1
fi
mv "$assets/SHA256SUMS.valid" "$assets/SHA256SUMS"

echo "Debian installer staging, metadata, idempotency, and checksum gates passed."
