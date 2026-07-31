#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${BIUNIVERS_TEST_ENV_FILE:-secret/biunivers-test.env}"
HOST_CONTAINER="${BIUNIVERS_TEST_CONTAINER:-biunivers-v02-test}"
TEST_ROOT="$(mktemp -d /tmp/biunivers-bwa-lifecycle.XXXXXX)"
RUN_ROOT="$TEST_ROOT/runs"
SOCKET_PATH="$TEST_ROOT/runtime.sock"
FIXTURE_PATH="$TEST_ROOT/fixture.json"
SECRET_PATH="$TEST_ROOT/private/bwa-secrets.json"
LOG_PATH="$TEST_ROOT/runtime.log"
PVLOGFS_BINARY="$TEST_ROOT/cargo-target/release/biunivers-pvlogfs"
COW_SCANNER_BINARY="$TEST_ROOT/cargo-target/release/biunivers-workspace-cow-scan"
TOKEN_HEX="$(openssl rand -hex 32)"
DAEMON_PID=""

cleanup() {
  local exit_code=$?
  if [[ -n "$DAEMON_PID" ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill -TERM "$DAEMON_PID"
    wait "$DAEMON_PID" || true
  fi
  if [[ "$exit_code" -ne 0 ]] && [[ -f "$LOG_PATH" ]]; then
    echo "Compute Runtime daemon 日志：" >&2
    tail -n 100 "$LOG_PATH" >&2
  fi
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

set -a
source "$ENV_FILE"
set +a

NODE_BIN="$(command -v node || true)"
if [[ "$(${NODE_BIN:-false} --version 2>/dev/null || true)" != v24.* ]]; then
  NODE_BIN="$HOME/.nvm/versions/node/v24.18.0/bin/node"
fi
if [[ ! -x "$NODE_BIN" ]] || [[ "$($NODE_BIN --version)" != v24.* ]]; then
  echo "缺少 Node.js 24。" >&2
  exit 1
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"

npm run build:server >/dev/null
CARGO_BIN="$(command -v cargo || true)"
if [[ -z "$CARGO_BIN" ]] && [[ -x "$HOME/.cargo/bin/cargo" ]]; then
  CARGO_BIN="$HOME/.cargo/bin/cargo"
fi
if [[ -z "$CARGO_BIN" ]]; then
  echo "缺少 Cargo。" >&2
  exit 1
fi
CARGO_TARGET_DIR="$TEST_ROOT/cargo-target" \
  "$CARGO_BIN" build --release --manifest-path crates/pvlogfs/Cargo.toml >/dev/null
CARGO_TARGET_DIR="$TEST_ROOT/cargo-target" \
  "$CARGO_BIN" build --release --manifest-path crates/workspace-cow/Cargo.toml >/dev/null

docker pull ghcr.io/echo983/biunivers-bwa-diagnostic:latest >/dev/null
BWA_IMAGE_REFERENCE="$(docker image inspect --format '{{index .RepoDigests 0}}' \
  ghcr.io/echo983/biunivers-bwa-diagnostic:latest)"
docker build --quiet --tag biunivers-runtime-diagnostic:dev runtime/diagnostic >/dev/null
DIAGNOSTIC_IMAGE_ID="$(docker image inspect --format '{{.Id}}' biunivers-runtime-diagnostic:dev)"

curl --fail --silent --show-error --request POST \
  --header "Authorization: Bearer $BIUNIVERS_ADMIN_TOKEN" \
  "$BIUNIVERS_DESKTOP_ORIGIN/api/v1/admin/file-service/backups" >/dev/null
mkdir -p "$TEST_ROOT/data/file-service"
docker cp "$HOST_CONTAINER:/data/file-service/backups/latest.sqlite" \
  "$TEST_ROOT/data/file-service/file-service.sqlite" >/dev/null
export BIUNIVERS_DATA_DIR="$TEST_ROOT/data"

"$NODE_BIN" scripts/bwa-lifecycle-fixture.mjs \
  prepare "$FIXTURE_PATH" "$SECRET_PATH" "$BWA_IMAGE_REFERENCE" >/dev/null

export BIUNIVERS_RUNTIME_ROOT="$RUN_ROOT"
export BIUNIVERS_RUNTIME_CACHE="$TEST_ROOT/cache"
export BIUNIVERS_RUNTIME_SOCKET="$SOCKET_PATH"
export BIUNIVERS_RUNTIME_AUTH_TOKEN="$TOKEN_HEX"
export BIUNIVERS_PVLOGFS_BINARY="$PVLOGFS_BINARY"
export BIUNIVERS_WORKSPACE_COW_SCANNER_BINARY="$COW_SCANNER_BINARY"
export BIUNIVERS_DIAGNOSTIC_EXECUTOR_IMAGE="$DIAGNOSTIC_IMAGE_ID"

"$NODE_BIN" dist/server/computeRuntime/computeRuntimeCli.js >>"$LOG_PATH" 2>&1 &
DAEMON_PID="$!"
for _ in $(seq 1 100); do
  [[ -S "$SOCKET_PATH" ]] && break
  kill -0 "$DAEMON_PID"
  sleep 0.1
done
[[ -S "$SOCKET_PATH" ]]

RESULT="$("$NODE_BIN" scripts/verify-bwa-lifecycle.mjs \
  "$SOCKET_PATH" "$TOKEN_HEX" "$FIXTURE_PATH" "$SECRET_PATH" "$RUN_ROOT")"

kill -KILL "$DAEMON_PID"
wait "$DAEMON_PID" 2>/dev/null || true
DAEMON_PID=""
rm -f "$SOCKET_PATH"
"$NODE_BIN" dist/server/computeRuntime/computeRuntimeCli.js >>"$LOG_PATH" 2>&1 &
DAEMON_PID="$!"
for _ in $(seq 1 100); do
  [[ -S "$SOCKET_PATH" ]] && break
  kill -0 "$DAEMON_PID"
  sleep 0.1
done
[[ -S "$SOCKET_PATH" ]]

"$NODE_BIN" scripts/bwa-lifecycle-fixture.mjs \
  verify "$FIXTURE_PATH" "$SECRET_PATH" >/dev/null

kill -TERM "$DAEMON_PID"
wait "$DAEMON_PID"
DAEMON_PID=""
echo "$RESULT"
echo "BWA 保存重启、异常 Upper、daemon 中断恢复、Ref 不变和单次回退基础全部通过。"
