#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

grep -Fq 'BIUNIVERS_GITHUB_REPOSITORY:-echo983/biunivers.-1}' deploy/bin/biunivers-update

test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT
digest_one="$(printf '1%.0s' {1..64})"
digest_two="$(printf '2%.0s' {1..64})"

create_release_assets() {
  local version="$1"
  local assets="$2"
  local release_name="biunivers-runtime-$version-linux-x64"
  local fixture="$test_root/fixture-$version/$release_name"
  mkdir -p \
    "$fixture/node/bin" \
    "$fixture/app/dist/server/computeRuntime" \
    "$fixture/bin" \
    "$fixture/deploy" \
    "$assets"
  cp "$(command -v node)" "$fixture/node/bin/node"
  cp -a deploy/. "$fixture/deploy/"
  touch \
    "$fixture/app/dist/server/computeRuntime/computeRuntimeCli.js" \
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
  local asset="$assets/$release_name.tar.zst"
  tar -C "$test_root/fixture-$version" -cf - "$release_name" | zstd -q -o "$asset"
  (
    cd "$assets"
    sha256sum "$(basename "$asset")" > SHA256SUMS
  )
}

create_installed_root() {
  local root="$1"
  local version="$2"
  mkdir -p \
    "$root/opt/biunivers/releases/$version/node/bin" \
    "$root/opt/biunivers/releases/$version/deploy/bin" \
    "$root/etc/biunivers" \
    "$root/etc/systemd/system" \
    "$root/var/lib/biunivers/data/file-service" \
    "$root/usr/local/sbin"
  cp "$(command -v node)" "$root/opt/biunivers/releases/$version/node/bin/node"
  cp deploy/bin/biunivers-update \
    "$root/opt/biunivers/releases/$version/deploy/bin/biunivers-update"
  ln -s "releases/$version" "$root/opt/biunivers/current"
  printf '%s\n' 'BIUNIVERS_DESKTOP_PORT=8080' > "$root/etc/biunivers/biunivers.env"
  printf '%064d\n' 0 > "$root/etc/biunivers/runtime-token"
  printf 'BIUNIVERS_VERSION=%q\n' "$version" > "$root/etc/biunivers/release"
  printf 'BIUNIVERS_HOST_IMAGE=ghcr.io/echo983/biunivers@sha256:%s\n' "$digest_one" \
    >> "$root/etc/biunivers/release"
  printf 'BIUNIVERS_DIAGNOSTIC_EXECUTOR_IMAGE=ghcr.io/echo983/biunivers-runtime-diagnostic@sha256:%s\n' "$digest_two" \
    >> "$root/etc/biunivers/release"
  cp deploy/systemd/biunivers-runtime.service deploy/systemd/biunivers-host.service \
    "$root/etc/systemd/system/"
  printf '%s\n' "state-from-$version" > "$root/var/lib/biunivers/data/state.txt"
  touch "$root/var/lib/biunivers/data/file-service/file-service.sqlite"
}

assets_110="$test_root/assets-110"
create_release_assets v1.1.0 "$assets_110"
success_root="$test_root/success"
create_installed_root "$success_root" v1.0.0

BIUNIVERS_UPDATE_TEST_MODE=1 BIUNIVERS_UPDATE_TEST_HEALTH=success \
  bash deploy/bin/biunivers-update \
    --test-mode --root "$success_root" \
    --version v1.1.0 --release-dir "$assets_110"

test "$(readlink "$success_root/opt/biunivers/current")" = releases/v1.1.0
grep -q '^state-from-v1.0.0$' "$success_root/var/lib/biunivers/data/state.txt"
committed_backup="$(find "$success_root/var/lib/biunivers/backups" -mindepth 1 -maxdepth 1 -type d)"
test "$(cat "$committed_backup/result")" = COMMITTED
grep -q '^state-from-v1.0.0$' "$committed_backup/data/state.txt"
test -x "$success_root/usr/local/sbin/biunivers-update"

assets_120="$test_root/assets-120"
create_release_assets v1.2.0 "$assets_120"
failure_root="$test_root/failure"
create_installed_root "$failure_root" v1.1.0

if BIUNIVERS_UPDATE_TEST_MODE=1 BIUNIVERS_UPDATE_TEST_HEALTH=failure \
  bash deploy/bin/biunivers-update \
    --test-mode --root "$failure_root" \
    --version v1.2.0 --release-dir "$assets_120"; then
  echo "Updater accepted a failed health gate." >&2
  exit 1
fi

test "$(readlink "$failure_root/opt/biunivers/current")" = releases/v1.1.0
grep -q '^state-from-v1.1.0$' "$failure_root/var/lib/biunivers/data/state.txt"
rolled_back="$(find "$failure_root/var/lib/biunivers/backups" -mindepth 1 -maxdepth 1 -type d)"
test "$(cat "$rolled_back/result")" = ROLLED_BACK
test -d "$rolled_back/failed-data"
grep -q '^BIUNIVERS_VERSION=v1.1.0$' "$failure_root/etc/biunivers/release"

echo "Debian updater commit and health-gate rollback transactions passed."
