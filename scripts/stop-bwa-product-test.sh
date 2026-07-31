#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER_NAME="${BIUNIVERS_BWA_TEST_CONTAINER:-biunivers-v02-test}"
DATA_ROOT="${BIUNIVERS_BWA_TEST_DATA:-$PWD/secret/bwa-product-data}"
PID_FILE="$DATA_ROOT/compute-runtime/runtime.pid"

if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  echo "停止 Biunivers Host……"
  docker stop --time 20 "$CONTAINER_NAME" >/dev/null
fi

if [[ -f "$PID_FILE" ]]; then
  RUNTIME_PID="$(tr -d '[:space:]' < "$PID_FILE")"
  if [[ "$RUNTIME_PID" =~ ^[0-9]+$ ]] && kill -0 "$RUNTIME_PID" 2>/dev/null; then
    echo "受控停止 Compute Runtime 并提交运行中的 BWA……"
    kill -TERM "$RUNTIME_PID"
    for _ in $(seq 1 300); do
      kill -0 "$RUNTIME_PID" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$RUNTIME_PID" 2>/dev/null; then
      echo "Compute Runtime 未能在 30 秒内受控停止，请检查日志：$DATA_ROOT/compute-runtime/runtime.log" >&2
      exit 1
    fi
  fi
  rm -f "$PID_FILE"
fi

echo "BWA 产品测试环境已停止。"
