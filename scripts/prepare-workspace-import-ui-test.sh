#!/usr/bin/env bash
set -euo pipefail

container_name="${BIUNIVERS_TEST_CONTAINER:-biunivers-v02-test}"

if ! docker container inspect "${container_name}" >/dev/null 2>&1; then
  echo "未找到运行中的测试容器：${container_name}" >&2
  echo "请先运行 bash scripts/run-workspace-product-test.sh" >&2
  exit 1
fi

if [ "$(docker inspect -f '{{.State.Running}}' "${container_name}")" != "true" ]; then
  echo "测试容器未运行：${container_name}" >&2
  exit 1
fi

echo "为最新 Workspace 准备导回界面验收数据……"
docker exec -i "${container_name}" \
  node --input-type=module \
  < scripts/prepare-workspace-import-ui-fixture.mjs

echo
echo "请刷新工作空间应用，进入最新 Workspace 的“变更”视图："
echo "1. 勾选新增目录和 collision-<Workspace 短 ID>.txt。"
echo "2. 点击“导回 main…”，进入脚本输出的 Workspace Import Target 目录。"
echo "3. 保持“自动改名”并确认导回。"
echo "4. 在文件管理器中确认目录整体出现，且冲突文件名中插入了 (Workspace)。"
