#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE_ID="${1:-sha256:f3b19461c76eff06f2134be84e0d975895b115cc0025ba86f040cbfaf79aa234}"
ENV_FILE="${BIUNIVERS_TEST_ENV_FILE:-secret/biunivers-test.env}"
PVLOGFS_BINARY="$(pwd)/target/release/biunivers-pvlogfs"
TEST_ROOT="$(mktemp -d /tmp/biunivers-compute-runtime.XXXXXX)"
RUN_ROOT="$TEST_ROOT/runs"
SOCKET_PATH="$TEST_ROOT/runtime.sock"
FIXTURE_PATH="$TEST_ROOT/fixture.json"
LOG_PATH="$TEST_ROOT/runtime.log"
TOKEN_HEX="$(openssl rand -hex 32)"
DAEMON_PID=""
FIXTURE_FINISHED=false

cleanup() {
  if [[ -n "$DAEMON_PID" ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill -TERM "$DAEMON_PID"
    wait "$DAEMON_PID" || true
  fi
  if [[ -f "$FIXTURE_PATH" ]] && [[ "$FIXTURE_FINISHED" != true ]]; then
    node scripts/compute-runtime-fixture.mjs fail "$FIXTURE_PATH" || true
  fi
}
trap cleanup EXIT

set -a
source "$ENV_FILE"
set +a

npm run build:server >/dev/null
cargo build --release --manifest-path crates/pvlogfs/Cargo.toml >/dev/null
node scripts/compute-runtime-fixture.mjs prepare "$FIXTURE_PATH" >/dev/null

export BIUNIVERS_RUNTIME_ROOT="$RUN_ROOT"
export BIUNIVERS_RUNTIME_CACHE="$TEST_ROOT/cache"
export BIUNIVERS_RUNTIME_SOCKET="$SOCKET_PATH"
export BIUNIVERS_RUNTIME_AUTH_TOKEN="$TOKEN_HEX"
export BIUNIVERS_PVLOGFS_BINARY="$PVLOGFS_BINARY"
export BIUNIVERS_DIAGNOSTIC_EXECUTOR_IMAGE="$IMAGE_ID"

node dist/server/computeRuntime/computeRuntimeCli.js >"$LOG_PATH" 2>&1 &
DAEMON_PID="$!"
for _ in $(seq 1 100); do
  [[ -S "$SOCKET_PATH" ]] && break
  kill -0 "$DAEMON_PID"
  sleep 0.1
done
[[ -S "$SOCKET_PATH" ]]

RESULT="$(node scripts/verify-compute-runtime.mjs \
  "$SOCKET_PATH" "$TOKEN_HEX" "$FIXTURE_PATH" "$RUN_ROOT")"
RUNTIME_IDENTITY="$(node -e \
  'const value=JSON.parse(process.argv[1]); process.stdout.write(value.runtimeIdentity)' \
  "$RESULT")"
node scripts/compute-runtime-fixture.mjs finish \
  "$FIXTURE_PATH" "$RUNTIME_IDENTITY"
FIXTURE_FINISHED=true

kill -TERM "$DAEMON_PID"
wait "$DAEMON_PID"
DAEMON_PID=""
echo "$RESULT"
echo "Compute Runtime 真实 PVLogFS、overlay、非 root OCI 沙箱和清理链全部通过。"
