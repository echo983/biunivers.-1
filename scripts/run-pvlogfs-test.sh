#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${repo_dir}/secret/biunivers-test.env"
image_name="${BIUNIVERS_PVLOGFS_IMAGE:-biunivers:pvlogfs-dev}"
data_volume="${BIUNIVERS_DATA_VOLUME:-biunivers-v02-test-data}"
workspace_selector="${1:-latest}"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/biunivers-pvlogfs.XXXXXX")"
mount_dir="${test_dir}/mount"
socket_path="${test_dir}/gateway.sock"
snapshot_path="${test_dir}/snapshot.json"
session_path="${test_dir}/session.json"
container_name="biunivers-pvlogfs-$$"
fuse_pid=""

mkdir "${mount_dir}"
chmod 0711 "${test_dir}"

cleanup() {
  if mountpoint --quiet "${mount_dir}"; then
    fusermount3 -u "${mount_dir}" >/dev/null 2>&1 \
      || fusermount3 -uz "${mount_dir}" >/dev/null 2>&1 \
      || true
  fi
  if [[ -n "${fuse_pid}" ]]; then
    kill "${fuse_pid}" >/dev/null 2>&1 || true
    wait "${fuse_pid}" >/dev/null 2>&1 || true
  fi
  docker stop --time 10 "${container_name}" >/dev/null 2>&1 || true
  docker rm -f "${container_name}" >/dev/null 2>&1 || true
  rm -rf -- "${test_dir}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for command_name in cargo docker fusermount3 mountpoint node; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    echo "缺少依赖：${command_name}" >&2
    exit 1
  }
done
[[ -f "${env_file}" ]] || {
  echo "缺少测试环境文件：${env_file}" >&2
  exit 1
}

echo "构建正式 PVLogFS 与 Gateway……"
docker build --quiet --tag "${image_name}" "${repo_dir}" >/dev/null
cargo build --quiet --manifest-path "${repo_dir}/crates/pvlogfs/Cargo.toml"

docker run --detach \
  --name "${container_name}" \
  --env-file "${env_file}" \
  --volume "${data_volume}:/data" \
  --volume "${test_dir}:/probe" \
  --entrypoint node \
  "${image_name}" \
  dist/server/workspace/pvlogFsGatewayCli.js \
  "${workspace_selector}" \
  /probe/gateway.sock \
  /probe/snapshot.json \
  /probe/session.json \
  /data/file-service/chunk-cache >/dev/null

for _attempt in {1..300}; do
  [[ -S "${socket_path}" && -f "${snapshot_path}" && -f "${session_path}" ]] && break
  if ! docker inspect --format '{{.State.Running}}' "${container_name}" 2>/dev/null \
    | grep -qx true; then
    docker logs "${container_name}" >&2 || true
    echo "PVLogFS Gateway 提前退出。" >&2
    exit 1
  fi
  sleep 0.1
done
[[ -S "${socket_path}" && -f "${snapshot_path}" && -f "${session_path}" ]] || {
  docker logs "${container_name}" >&2 || true
  echo "PVLogFS Gateway 未能在 30 秒内就绪。" >&2
  exit 1
}

capability="$(
  node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).capabilityHex)' \
    "${session_path}"
)"
"${repo_dir}/crates/pvlogfs/target/debug/biunivers-pvlogfs" \
  "${snapshot_path}" \
  "${socket_path}" \
  "${capability}" \
  "${mount_dir}" &
fuse_pid="$!"

for _attempt in {1..100}; do
  mountpoint --quiet "${mount_dir}" && break
  kill -0 "${fuse_pid}" >/dev/null 2>&1 || {
    echo "PVLogFS 进程提前退出。" >&2
    exit 1
  }
  sleep 0.1
done
mountpoint --quiet "${mount_dir}" || {
  echo "PVLogFS 未能挂载。" >&2
  exit 1
}

echo "枚举固定 Workspace HEAD……"
find "${mount_dir}" -printf '%y %i %s %p\n'
first_file="$(find "${mount_dir}" -type f -print -quit)"
[[ -n "${first_file}" ]] || {
  echo "Workspace 内没有可用于读取验证的文件。" >&2
  exit 1
}
dd if="${first_file}" bs=4096 count=1 status=none >/dev/null
dd if="${first_file}" bs=4096 count=1 status=none >/dev/null

echo "主动破坏最近使用的同长度 Chunk cache，并验证自动恢复……"
docker exec "${container_name}" node -e '
const fs = require("node:fs");
const directory = "/data/file-service/chunk-cache";
const files = fs.readdirSync(directory)
  .filter((name) => /^[0-9a-f]{32}\.chunk$/.test(name))
  .map((name) => ({ name, mtime: fs.statSync(`${directory}/${name}`).mtimeMs }))
  .sort((left, right) => right.mtime - left.mtime);
if (!files.length) throw new Error("No verified Chunk cache file exists.");
const path = `${directory}/${files[0].name}`;
const bytes = fs.readFileSync(path);
if (!bytes.length) throw new Error("Cannot corrupt an empty Chunk fixture.");
bytes[0] ^= 0xff;
fs.writeFileSync(path, bytes);
console.log(files[0].name);
'
dd if="${first_file}" bs=4096 count=1 status=none >/dev/null

if touch "${mount_dir}/must-not-exist" 2>/dev/null; then
  echo "PVLogFS 意外允许写入。" >&2
  exit 1
fi

fusermount3 -u "${mount_dir}"
wait "${fuse_pid}" >/dev/null 2>&1 || true
fuse_pid=""
docker stop --time 10 "${container_name}" >/dev/null
gateway_log="$(docker logs "${container_name}" 2>&1)"
docker rm "${container_name}" >/dev/null

trap - EXIT INT TERM
rm -rf -- "${test_dir}"
echo "正式 PVLogFS 固定 HEAD、目录枚举、冷/热/损坏缓存恢复和只读保护全部通过。"
echo "Gateway 测量：${gateway_log##*$'\n'}"
