#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://localhost:8080/wormhole/webdav/}"
test_name=".wormhole-large-$(date +%s)"
local_dir="$(mktemp -d)"
source_file="${local_dir}/large-boundary.bin"
download_file="${local_dir}/downloaded.bin"

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

truncate -s 67108865 "${source_file}"
printf "BIUNIVERS-BEGIN" | dd \
  of="${source_file}" \
  bs=1 \
  seek=0 \
  conv=notrunc \
  status=none
printf "BOUNDARY!" | dd \
  of="${source_file}" \
  bs=1 \
  seek=67108856 \
  conv=notrunc \
  status=none

echo "上传 64 MiB + 1 byte 测试文件……"
rclone copyto \
  --progress \
  "${source_file}" \
  "wormhole:${test_name}/large-boundary.bin"

echo "下载并逐字节校验……"
rclone copyto \
  --progress \
  "wormhole:${test_name}/large-boundary.bin" \
  "${download_file}"
cmp "${source_file}" "${download_file}"

boundary="$(
  rclone cat \
    --offset 67108856 \
    --count 9 \
    "wormhole:${test_name}/large-boundary.bin"
)"
[[ "${boundary}" == "BOUNDARY!" ]]

rclone purge "wormhole:${test_name}"
trap - EXIT
rm -rf "${local_dir}"
echo "64 MiB + 1 byte 跨分片上传、完整下载、逐字节校验和边界 Range 全部通过。"
