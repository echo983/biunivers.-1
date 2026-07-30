#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://localhost:8080/wormhole/webdav/}"
username="biunivers"
test_name=".wormhole-acceptance-$(date +%s)"
test_url="${base_url%/}/${test_name}"
payload="Biunivers Wormhole acceptance $(date -u +%FT%TZ)"

read -r -s -p "请输入 Wormhole 界面显示的 10 位密码：" password
echo

cleanup() {
  curl --silent --show-error \
    --user "${username}:${password}" \
    --request DELETE \
    "${test_url}/" >/dev/null 2>&1 || true
}
trap cleanup EXIT

status() {
  curl --silent --show-error \
    --output /dev/null \
    --write-out "%{http_code}" \
    --user "${username}:${password}" \
    "$@"
}

expect_status() {
  local expected="$1"
  shift
  local actual
  actual="$(status "$@")"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "失败：期望 HTTP ${expected}，实际 HTTP ${actual}" >&2
    exit 1
  fi
}

expect_status 201 --request MKCOL "${test_url}/"
expect_status 201 \
  --request PUT \
  --header "Content-Type: text/plain" \
  --data-binary "${payload}" \
  "${test_url}/source.txt"

listing="$(
  curl --fail --silent --show-error \
    --user "${username}:${password}" \
    --request PROPFIND \
    --header "Depth: 1" \
    "${test_url}/"
)"
grep -q "source.txt" <<<"${listing}"

downloaded="$(
  curl --fail --silent --show-error \
    --user "${username}:${password}" \
    "${test_url}/source.txt"
)"
[[ "${downloaded}" == "${payload}" ]]

ranged="$(
  curl --fail --silent --show-error \
    --user "${username}:${password}" \
    --header "Range: bytes=0-8" \
    "${test_url}/source.txt"
)"
[[ "${ranged}" == "Biunivers" ]]

expect_status 201 \
  --request COPY \
  --header "Destination: ${test_url}/copy.txt" \
  "${test_url}/source.txt"
expect_status 201 \
  --request MOVE \
  --header "Destination: ${test_url}/moved.txt" \
  "${test_url}/copy.txt"
expect_status 204 --request DELETE "${test_url}/moved.txt"
expect_status 204 --request DELETE "${test_url}/source.txt"
expect_status 204 --request DELETE "${test_url}/"

trap - EXIT
echo "Wormhole WebDAV 基本读写、目录、Range、COPY、MOVE 和 DELETE 全部通过。"
