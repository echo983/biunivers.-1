#!/usr/bin/env bash
set -euo pipefail

container_name="biunivers-v02-test"
desktop_origin="http://localhost:8080"
app_id="io.github.echo983.biunivers-notepad"

instance_token="$(
  curl -fsS \
    -X POST \
    -H "Origin: ${desktop_origin}" \
    -H "Sec-Fetch-Site: same-origin" \
    -H "Content-Type: application/json" \
    --data "{\"appId\":\"${app_id}\",\"windowInstanceId\":\"restart-verification\"}" \
    "${desktop_origin}/api/v1/host/instances" |
    jq -r .instanceToken
)"

listing="$(
  curl -fsS \
    -H "Origin: ${desktop_origin}" \
    -H "Authorization: Biunivers-Instance ${instance_token}" \
    "${desktop_origin}/api/v1/host/files"
)"
entry_id="$(
  jq -r '.entries[] | select(.kind == "file" and (.name | endswith(".txt"))) | .entryId' \
    <<<"${listing}" |
    head -n 1
)"
test -n "${entry_id}"

session_id="$(
  curl -fsS \
    -X POST \
    -H "Origin: ${desktop_origin}" \
    -H "Authorization: Biunivers-Instance ${instance_token}" \
    -H "Content-Type: application/json" \
    --data "{\"entryId\":\"${entry_id}\",\"access\":\"read\"}" \
    "${desktop_origin}/api/v1/host/resource-sessions" |
    jq -r .sessionId
)"

app_origin="$(
  node -e '
    const { createHash } = require("node:crypto");
    const label = createHash("sha256")
      .update(process.argv[1])
      .digest("hex")
      .slice(0, 40);
    console.log(`http://app-${label}.localhost:8081`);
  ' "${app_id}"
)"

before="$(
  curl -sS -o /dev/null -w "%{http_code}" \
    -H "Origin: ${app_origin}" \
    -H "Authorization: Biunivers-Instance ${instance_token}" \
    -H "Biunivers-Resource-Session: ${session_id}" \
    "${desktop_origin}/api/v1/resource-content"
)"
test "${before}" = "200"

docker restart "${container_name}" >/dev/null
echo "等待 Biunivers 重启……"
for attempt in {1..30}; do
  if curl --fail --silent "${desktop_origin}/health" >/dev/null; then
    break
  fi
  sleep 1
done

after="$(
  curl -sS -o /dev/null -w "%{http_code}" \
    -H "Origin: ${app_origin}" \
    -H "Authorization: Biunivers-Instance ${instance_token}" \
    -H "Biunivers-Resource-Session: ${session_id}" \
    "${desktop_origin}/api/v1/resource-content"
)"

echo "重启前资源读取：HTTP ${before}"
echo "重启后旧凭据读取：HTTP ${after}"
if [ "${after}" != "404" ]; then
  echo "预期旧实例和会话返回 HTTP 404，实际为 ${after}。" >&2
  exit 1
fi
echo "宿主重启未恢复旧实例和资源会话，符合预期。"
