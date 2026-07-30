#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://localhost:8080/wormhole/webdav/}"
test_name=".wormhole-mount-$(date +%s)"
mount_dir="$(mktemp -d)"
mount_pid=""

read -r -s -p "请输入 Wormhole 界面显示的 10 位密码：" password
echo

export RCLONE_CONFIG_WORMHOLE_TYPE="webdav"
export RCLONE_CONFIG_WORMHOLE_URL="${base_url}"
export RCLONE_CONFIG_WORMHOLE_VENDOR="rclone"
export RCLONE_CONFIG_WORMHOLE_USER="biunivers"
export RCLONE_CONFIG_WORMHOLE_PASS
RCLONE_CONFIG_WORMHOLE_PASS="$(rclone obscure "${password}")"

unmount_test() {
  if mountpoint --quiet "${mount_dir}"; then
    fusermount3 -u "${mount_dir}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${mount_pid}" ]]; then
    kill "${mount_pid}" >/dev/null 2>&1 || true
    wait "${mount_pid}" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  unmount_test
  rclone purge "wormhole:${test_name}" >/dev/null 2>&1 || true
  rm -rf "${mount_dir}"
}
trap cleanup EXIT

rclone mount \
  wormhole: \
  "${mount_dir}" \
  --vfs-cache-mode writes \
  --dir-cache-time 2s &
mount_pid="$!"

for attempt in {1..30}; do
  if mountpoint --quiet "${mount_dir}"; then
    break
  fi
  if ! kill -0 "${mount_pid}" >/dev/null 2>&1; then
    echo "rclone mount 提前退出。" >&2
    exit 1
  fi
  sleep 1
done

if ! mountpoint --quiet "${mount_dir}"; then
  echo "rclone mount 未能在 30 秒内就绪。" >&2
  exit 1
fi

payload="Biunivers mounted filesystem acceptance"
mkdir "${mount_dir}/${test_name}"
printf "%s" "${payload}" >"${mount_dir}/${test_name}/source.txt"
downloaded="$(cat "${mount_dir}/${test_name}/source.txt")"
[[ "${downloaded}" == "${payload}" ]]
mv \
  "${mount_dir}/${test_name}/source.txt" \
  "${mount_dir}/${test_name}/renamed.txt"
rm "${mount_dir}/${test_name}/renamed.txt"
rmdir "${mount_dir}/${test_name}"

unmount_test
mount_pid=""
trap - EXIT
rm -rf "${mount_dir}"
echo "rclone mount 挂载、普通文件写入、读取、改名、删除和卸载全部通过。"
