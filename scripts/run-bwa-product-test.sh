#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${BIUNIVERS_TEST_ENV_FILE:-secret/biunivers-test.env}"
CONTAINER_NAME="${BIUNIVERS_BWA_TEST_CONTAINER:-biunivers-v02-test}"
IMAGE_NAME="${BIUNIVERS_BWA_TEST_IMAGE:-biunivers:bwa-product-dev}"
SOURCE_VOLUME="${BIUNIVERS_BWA_SOURCE_VOLUME:-biunivers-v02-test-data}"
DATA_ROOT="${BIUNIVERS_BWA_TEST_DATA:-$PWD/secret/bwa-product-data}"
RUNTIME_DIR="$DATA_ROOT/compute-runtime"
RUNTIME_STATE_ROOT="${BIUNIVERS_BWA_RUNTIME_STATE:-/var/tmp/biunivers-bwa-$(id -u)}"
SOCKET_PATH="$RUNTIME_STATE_ROOT/runtime.sock"
TOKEN_FILE="$RUNTIME_DIR/auth-token"
PID_FILE="$RUNTIME_DIR/runtime.pid"
LOG_FILE="$RUNTIME_DIR/runtime.log"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "缺少环境文件：$ENV_FILE" >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ "$(${NODE_BIN:-false} --version 2>/dev/null || true)" != v24.* ]]; then
  NODE_BIN="$HOME/.nvm/versions/node/v24.18.0/bin/node"
fi
if [[ ! -x "$NODE_BIN" ]] || [[ "$($NODE_BIN --version)" != v24.* ]]; then
  echo "缺少 Node.js 24。" >&2
  exit 1
fi
CARGO_BIN="$(command -v cargo || true)"
if [[ -z "$CARGO_BIN" ]] && [[ -x "$HOME/.cargo/bin/cargo" ]]; then
  CARGO_BIN="$HOME/.cargo/bin/cargo"
fi
if [[ -z "$CARGO_BIN" ]]; then
  echo "缺少 Cargo。" >&2
  exit 1
fi
for command in docker fuse-overlayfs fusermount3; do
  command -v "$command" >/dev/null || { echo "缺少 $command。" >&2; exit 1; }
done

mkdir -p "$RUNTIME_DIR" "$RUNTIME_STATE_ROOT" "$DATA_ROOT/file-service"
chmod 700 "$RUNTIME_DIR" "$RUNTIME_STATE_ROOT"

set -a
source "$ENV_FILE"
set +a

if [[ ! -f "$DATA_ROOT/file-service/file-service.sqlite" ]]; then
  if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    echo "从当前 Host 创建一致性 RefStore 备份……"
    curl --fail --silent --show-error --request POST \
      --header "Authorization: Bearer $BIUNIVERS_ADMIN_TOKEN" \
      "${BIUNIVERS_DESKTOP_ORIGIN:-http://localhost:8080}/api/v1/admin/file-service/backups" >/dev/null
    docker cp "$CONTAINER_NAME:/data/file-service/backups/latest.sqlite" \
      "$DATA_ROOT/file-service/file-service.sqlite" >/dev/null
  elif docker volume inspect "$SOURCE_VOLUME" >/dev/null 2>&1; then
    echo "从已正常关闭的 Docker 数据卷 $SOURCE_VOLUME 迁移 RefStore……"
    docker run --rm \
      --user "$(id -u):$(id -g)" \
      --mount "type=volume,src=$SOURCE_VOLUME,dst=/source,readonly" \
      --mount "type=bind,src=$DATA_ROOT/file-service,dst=/target" \
      alpine:3.22 \
      sh -c 'test -f /source/file-service/file-service.sqlite && cp /source/file-service/file-service.sqlite* /target/'
  else
    echo "本地 BWA 数据目录没有 RefStore，也未找到容器 $CONTAINER_NAME 或数据卷 $SOURCE_VOLUME。" >&2
    echo "请设置 BIUNIVERS_BWA_TEST_DATA 或 BIUNIVERS_BWA_SOURCE_VOLUME。" >&2
    exit 1
  fi
fi

bash scripts/stop-bwa-product-test.sh
trap 'exit_code=$?; trap - ERR; set +e; bash scripts/stop-bwa-product-test.sh; exit "$exit_code"' ERR

if [[ ! -f "$TOKEN_FILE" ]]; then
  umask 077
  openssl rand -hex 32 > "$TOKEN_FILE"
fi
TOKEN_HEX="$(tr -d '[:space:]' < "$TOKEN_FILE")"
if [[ ! "$TOKEN_HEX" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Runtime token 文件损坏：$TOKEN_FILE" >&2
  exit 1
fi

echo "构建 Host、Runtime 二进制和诊断镜像……"
PATH="$(dirname "$NODE_BIN"):$PATH" npm run build:server >/dev/null
"$CARGO_BIN" build --release --manifest-path crates/pvlogfs/Cargo.toml >/dev/null
"$CARGO_BIN" build --release --manifest-path crates/workspace-cow/Cargo.toml >/dev/null
PVLOGFS_BINARY="$PWD/crates/pvlogfs/target/release/biunivers-pvlogfs"
COW_SCANNER_BINARY="$PWD/crates/workspace-cow/target/release/biunivers-workspace-cow-scan"
if [[ ! -x "$PVLOGFS_BINARY" ]] || [[ ! -x "$COW_SCANNER_BINARY" ]]; then
  echo "Runtime 二进制构建产物缺失。" >&2
  exit 1
fi
docker build --quiet --tag "$IMAGE_NAME" . >/dev/null
docker build --quiet --tag biunivers-runtime-diagnostic:dev runtime/diagnostic >/dev/null
DIAGNOSTIC_IMAGE_ID="$(docker image inspect --format '{{.Id}}' biunivers-runtime-diagnostic:dev)"

export BIUNIVERS_DATA_DIR="$DATA_ROOT"
export BIUNIVERS_FILE_INITIALIZE=false
export BIUNIVERS_BWA_ENABLED=true
export BIUNIVERS_RUNTIME_ROOT="$RUNTIME_STATE_ROOT/runs"
export BIUNIVERS_RUNTIME_CACHE="$RUNTIME_STATE_ROOT/chunk-cache"
export BIUNIVERS_RUNTIME_SOCKET="$SOCKET_PATH"
export BIUNIVERS_RUNTIME_AUTH_TOKEN="$TOKEN_HEX"
export BIUNIVERS_PVLOGFS_BINARY="$PVLOGFS_BINARY"
export BIUNIVERS_WORKSPACE_COW_SCANNER_BINARY="$COW_SCANNER_BINARY"
export BIUNIVERS_DIAGNOSTIC_EXECUTOR_IMAGE="$DIAGNOSTIC_IMAGE_ID"

echo "启动宿主 Compute Runtime……"
nohup "$NODE_BIN" dist/server/computeRuntime/computeRuntimeCli.js >"$LOG_FILE" 2>&1 &
RUNTIME_PID=$!
echo "$RUNTIME_PID" > "$PID_FILE"
for _ in $(seq 1 100); do
  [[ -S "$SOCKET_PATH" ]] && break
  if ! kill -0 "$RUNTIME_PID" 2>/dev/null; then
    tail -n 100 "$LOG_FILE" >&2
    exit 1
  fi
  sleep 0.1
done
if [[ ! -S "$SOCKET_PATH" ]]; then
  echo "Compute Runtime 未创建控制 socket。" >&2
  tail -n 100 "$LOG_FILE" >&2
  exit 1
fi

echo "启动 Biunivers Host 容器……"
docker run --rm -d \
  --name "$CONTAINER_NAME" \
  --network biunivers-bwa \
  --user "$(id -u):$(id -g)" \
  -p 8080:8080 \
  -p 8081:8081 \
  --env-file "$ENV_FILE" \
  -e BIUNIVERS_DATA_DIR="$DATA_ROOT" \
  -e BIUNIVERS_FILE_INITIALIZE=false \
  -e BIUNIVERS_BWA_ENABLED=true \
  -e BIUNIVERS_RUNTIME_SOCKET="$SOCKET_PATH" \
  -e BIUNIVERS_RUNTIME_AUTH_TOKEN="$TOKEN_HEX" \
  --mount "type=bind,src=$DATA_ROOT,dst=$DATA_ROOT" \
  --mount "type=bind,src=$RUNTIME_STATE_ROOT,dst=$RUNTIME_STATE_ROOT" \
  "$IMAGE_NAME" >/dev/null

echo "等待 Biunivers 启动……"
for _ in $(seq 1 30); do
  if curl --fail --silent http://localhost:8080/health >/dev/null; then
    echo "Biunivers BWA 产品测试环境已启动：http://localhost:8080"
    echo "Compute Runtime 日志：$LOG_FILE"
    echo "停止命令：bash scripts/stop-bwa-product-test.sh"
    trap - ERR
    exit 0
  fi
  sleep 1
done

docker logs --tail 100 "$CONTAINER_NAME" >&2 || true
tail -n 100 "$LOG_FILE" >&2 || true
exit 1
