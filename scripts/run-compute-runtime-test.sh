#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE_ID="${1:-}"
SCENARIO="${BIUNIVERS_COMPUTE_RUNTIME_SCENARIO:-commit}"
ENV_FILE="${BIUNIVERS_TEST_ENV_FILE:-secret/biunivers-test.env}"
HOST_CONTAINER="${BIUNIVERS_TEST_CONTAINER:-biunivers-v02-test}"
TEST_ROOT="$(mktemp -d /tmp/biunivers-compute-runtime.XXXXXX)"
PVLOGFS_BINARY="$TEST_ROOT/cargo-target/release/biunivers-pvlogfs"
COW_SCANNER_BINARY="$TEST_ROOT/cargo-target/release/biunivers-workspace-cow-scan"
RUN_ROOT="$TEST_ROOT/runs"
SOCKET_PATH="$TEST_ROOT/runtime.sock"
FIXTURE_PATH="$TEST_ROOT/fixture.json"
LOG_PATH="$TEST_ROOT/runtime.log"
TOKEN_HEX="$(openssl rand -hex 32)"
DAEMON_PID=""
FIXTURE_FINISHED=false
NODE_BIN="node"

if [[ "$SCENARIO" != commit ]] && [[ "$SCENARIO" != restart ]]; then
  echo "BIUNIVERS_COMPUTE_RUNTIME_SCENARIO 只能是 commit 或 restart。" >&2
  exit 1
fi

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
if [[ -z "$IMAGE_ID" ]]; then
  echo "构建固定诊断执行器镜像……"
  docker build --quiet \
    --tag biunivers-runtime-diagnostic:dev \
    runtime/diagnostic >/dev/null
  IMAGE_ID="$(docker image inspect \
    --format '{{.Id}}' biunivers-runtime-diagnostic:dev)"
fi
if [[ ! "$IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "诊断执行器镜像必须使用 sha256 内容身份。" >&2
  exit 1
fi

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
CARGO_TARGET_DIR="$TEST_ROOT/cargo-target" \
  "$CARGO_BIN" build --release \
  --manifest-path crates/workspace-cow/Cargo.toml >/dev/null

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
export BIUNIVERS_WORKSPACE_COW_SCANNER_BINARY="$COW_SCANNER_BINARY"
export BIUNIVERS_DIAGNOSTIC_EXECUTOR_IMAGE="$IMAGE_ID"

start_daemon() {
  "$NODE_BIN" dist/server/computeRuntime/computeRuntimeCli.js >>"$LOG_PATH" 2>&1 &
  DAEMON_PID="$!"
  for _ in $(seq 1 100); do
    [[ -S "$SOCKET_PATH" ]] && break
    kill -0 "$DAEMON_PID"
    sleep 0.1
  done
  [[ -S "$SOCKET_PATH" ]]
}

start_daemon
if [[ "$SCENARIO" = restart ]]; then
  "$NODE_BIN" scripts/verify-compute-runtime-restart.mjs \
    start "$SOCKET_PATH" "$TOKEN_HEX" "$FIXTURE_PATH" "$RUN_ROOT"
  kill -KILL "$DAEMON_PID"
  wait "$DAEMON_PID" 2>/dev/null || true
  DAEMON_PID=""
  start_daemon
  RESULT="$("$NODE_BIN" scripts/verify-compute-runtime-restart.mjs \
    verify "$SOCKET_PATH" "$TOKEN_HEX" "$FIXTURE_PATH" "$RUN_ROOT")"
  "$NODE_BIN" scripts/compute-runtime-fixture.mjs \
    verify-recovery "$FIXTURE_PATH"
else
  RESULT="$("$NODE_BIN" scripts/verify-compute-runtime.mjs \
    "$SOCKET_PATH" "$TOKEN_HEX" "$FIXTURE_PATH" "$RUN_ROOT")"
  "$NODE_BIN" scripts/compute-runtime-fixture.mjs verify "$FIXTURE_PATH"
fi
FIXTURE_FINISHED=true

kill -TERM "$DAEMON_PID"
wait "$DAEMON_PID"
DAEMON_PID=""
echo "$RESULT"
if [[ "$SCENARIO" = restart ]]; then
  echo "Compute Runtime daemon 强制终止、容器/挂载清理、Upper 保留、Ref 不变和租约释放全部通过。"
else
  echo "Compute Runtime 真实 PVLogFS、overlay、非 root OCI 沙箱、COW 提交和清理链全部通过。"
fi
