#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://localhost:8080/wormhole/webdav/}"
test_name=".wormhole-rclone-$(date +%s)"
local_dir="$(mktemp -d)"

read -r -s -p "请输入 Wormhole 界面显示的 10 位密码：" password
echo

export RCLONE_CONFIG_WORMHOLE_TYPE="webdav"
export RCLONE_CONFIG_WORMHOLE_URL="${base_url}"
export RCLONE_CONFIG_WORMHOLE_VENDOR="rclone"
export RCLONE_CONFIG_WORMHOLE_USER="biunivers"
export RCLONE_CONFIG_WORMHOLE_PASS
RCLONE_CONFIG_WORMHOLE_PASS="$(rclone obscure "${password}")"

cleanup() {
  rclone purge "wormhole:${test_name}" >/dev/null 2>&1 || true
  rm -rf "${local_dir}"
}
trap cleanup EXIT

payload="Biunivers rclone acceptance $(date -u +%FT%TZ)"
printf "%s" "${payload}" >"${local_dir}/source.txt"

rclone mkdir "wormhole:${test_name}"
rclone copyto \
  "${local_dir}/source.txt" \
  "wormhole:${test_name}/source.txt"

rclone lsf "wormhole:${test_name}" | grep -qx "source.txt"
downloaded="$(rclone cat "wormhole:${test_name}/source.txt")"
[[ "${downloaded}" == "${payload}" ]]

ranged="$(
  rclone cat \
    --offset 0 \
    --count 9 \
    "wormhole:${test_name}/source.txt"
)"
[[ "${ranged}" == "Biunivers" ]]

rclone copyto \
  "wormhole:${test_name}/source.txt" \
  "wormhole:${test_name}/copy.txt"
rclone moveto \
  "wormhole:${test_name}/copy.txt" \
  "wormhole:${test_name}/moved.txt"
rclone deletefile "wormhole:${test_name}/moved.txt"
rclone deletefile "wormhole:${test_name}/source.txt"
rclone rmdir "wormhole:${test_name}"

trap - EXIT
rm -rf "${local_dir}"
echo "rclone WebDAV 列目录、上传、读取、Range、服务端复制、移动和删除全部通过。"
