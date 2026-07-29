#!/usr/bin/env bash
set -euo pipefail

container_name="biunivers-v02-test"
image_name="biunivers:desktop-surface-dev"

if docker container inspect "${container_name}" >/dev/null 2>&1; then
  docker rm -f "${container_name}" >/dev/null
fi

docker run --rm -d \
  --name "${container_name}" \
  -p 8080:8080 \
  -p 8081:8081 \
  --env-file secret/biunivers-test.env \
  -v biunivers-v02-test-data:/data \
  "${image_name}"

echo "等待 Biunivers 启动……"
for attempt in {1..30}; do
  if curl --fail --silent http://localhost:8080/health; then
    echo
    echo "Biunivers 已启动：http://localhost:8080"
    exit 0
  fi
  sleep 1
done

echo "Biunivers 未能在 30 秒内启动，最近日志如下：" >&2
docker logs --tail 80 "${container_name}" >&2
exit 1
