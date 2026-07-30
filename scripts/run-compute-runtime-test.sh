#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE_ID="${1:-sha256:f3b19461c76eff06f2134be84e0d975895b115cc0025ba86f040cbfaf79aa234}"
ENV_FILE="${BIUNIVERS_TEST_ENV_FILE:-secret/biunivers-test.env}"
HOST_CONTAINER="${BIUNIVERS_TEST_CONTAINER:-biunivers-v02-test}"
TEST_ROOT="$(mktemp -d /tmp/biunivers-compute-runtime.XXXXXX)"
PVLOGFS_BINARY="$TEST_ROOT/cargo-target/release/biunivers-pvlogfs"
RUN_ROOT="$TEST_ROOT/runs"
SOCKET_PATH="$TEST_ROOT/runtime.sock"
FIXTURE_PATH="$TEST_ROOT/fixture.json"
LOG_PATH="$TEST_ROOT/runtime.log"
TOKEN_HEX="$(openssl rand -hex 32)"
DAEMON_PID=""
FIXTURE_FINISHED=false
NODE_BIN="node"

cleanup() {
  local exit_code=$?
  if [[ -n "$DAEMON_PID" ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill -TERM "$DAEMON_PID"
    wait "$DAEMON_PID" || true
  fi
  if [[ -f "$FIXTURE_PATH" ]] && [[ "$FIXTURE_FINISHED" != true ]]; then
    "$NODE_BIN" scripts/compute-runtime-fixture.mjs fail "$FIXTURE_PATH" || true
  fi
  if [[ "$exit_code" -ne 0 ]] && [[ -f "$LOG_PATH" ]]; then
    echo "Compute Runtime daemon 日志：" >&2
    tail -n 100 "$LOG_PATH" >&2
  fi
}
trap cleanup EXIT

set -a
source "$ENV_FILE"
set +a

NODE_BIN="$(command -v node || true)"
if [[ "$("$NODE_BIN" --version 2>/dev/null || true)" != v24.* ]]; then
  NODE_BIN="$HOME/.nvm/versions/node/v24.18.0/bin/node"
fi
if [[ ! -x "$NODE_BIN" ]] || [[ "$("$NODE_BIN" --version)" != v24.* ]]; then
  echo "缺少 Node.js 24；Compute Runtime 要求 Node.js >=24 <25。" >&2
  exit 1
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"

if ! "$NODE_BIN" -e \
  'const D=require("better-sqlite3"); const d=new D(":memory:"); d.close()' \
  >/dev/null 2>&1; then
  echo "为 Node.js 24 重编译 better-sqlite3……"
  npm rebuild better-sqlite3 --foreground-scripts >/dev/null
fi
"$NODE_BIN" -e \
  'const D=require("better-sqlite3"); const d=new D(":memory:"); d.close()'

npm run build:server >/dev/null
CARGO_BIN="$(command -v cargo || true)"
if [[ -z "$CARGO_BIN" ]] && [[ -x "$HOME/.cargo/bin/cargo" ]]; then
  CARGO_BIN="$HOME/.cargo/bin/cargo"
fi
if [[ -z "$CARGO_BIN" ]]; then
  echo "缺少 Cargo；请先安装 Rust toolchain。" >&2
  exit 1
fi
CARGO_TARGET_DIR="$TEST_ROOT/cargo-target" \
  "$CARGO_BIN" build --release \
  --manifest-path crates/pvlogfs/Cargo.toml >/dev/null

curl --fail --silent --show-error \
  --request POST \
  --header "Authorization: Bearer $BIUNIVERS_ADMIN_TOKEN" \
  "$BIUNIVERS_DESKTOP_ORIGIN/api/v1/admin/file-service/backups" >/dev/null
mkdir -p "$TEST_ROOT/data/file-service"
docker cp \
  "$HOST_CONTAINER:/data/file-service/backups/latest.sqlite" \
  "$TEST_ROOT/data/file-service/file-service.sqlite" >/dev/null
export BIUNIVERS_DATA_DIR="$TEST_ROOT/data"

"$NODE_BIN" scripts/compute-runtime-fixture.mjs prepare "$FIXTURE_PATH" >/dev/null

export BIUNIVERS_RUNTIME_ROOT="$RUN_ROOT"
export BIUNIVERS_RUNTIME_CACHE="$TEST_ROOT/cache"
export BIUNIVERS_RUNTIME_SOCKET="$SOCKET_PATH"
export BIUNIVERS_RUNTIME_AUTH_TOKEN="$TOKEN_HEX"
export BIUNIVERS_PVLOGFS_BINARY="$PVLOGFS_BINARY"
export BIUNIVERS_DIAGNOSTIC_EXECUTOR_IMAGE="$IMAGE_ID"

"$NODE_BIN" dist/server/computeRuntime/computeRuntimeCli.js >"$LOG_PATH" 2>&1 &
DAEMON_PID="$!"
for _ in $(seq 1 100); do
  [[ -S "$SOCKET_PATH" ]] && break
  kill -0 "$DAEMON_PID"
  sleep 0.1
done
[[ -S "$SOCKET_PATH" ]]

RESULT="$("$NODE_BIN" scripts/verify-compute-runtime.mjs \
  "$SOCKET_PATH" "$TOKEN_HEX" "$FIXTURE_PATH" "$RUN_ROOT")"
RUNTIME_IDENTITY="$("$NODE_BIN" -e \
  'const value=JSON.parse(process.argv[1]); process.stdout.write(value.runtimeIdentity)' \
  "$RESULT")"
"$NODE_BIN" scripts/compute-runtime-fixture.mjs finish \
  "$FIXTURE_PATH" "$RUNTIME_IDENTITY"
FIXTURE_FINISHED=true

kill -TERM "$DAEMON_PID"
wait "$DAEMON_PID"
DAEMON_PID=""
echo "$RESULT"
echo "Compute Runtime 真实 PVLogFS、overlay、非 root OCI 沙箱和清理链全部通过。"
