#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${repo_dir}/secret/biunivers-test.env"
image_name="${BIUNIVERS_PROBE_IMAGE:-biunivers:workspace-pvlog-probe}"
data_volume="${BIUNIVERS_DATA_VOLUME:-biunivers-v02-test-data}"
probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/biunivers-pvlog-head-probe.XXXXXX")"
mount_dir="${probe_dir}/mount"
socket_path="${probe_dir}/bridge.sock"
snapshot_path="${probe_dir}/snapshot.json"
metrics_path="${probe_dir}/metrics.json"
container_name="biunivers-pvlog-probe-$$"
fuse_pid=""

mkdir "${mount_dir}"
chmod 0777 "${probe_dir}"

unmount_probe() {
  if mountpoint --quiet "${mount_dir}"; then
    fusermount3 -u "${mount_dir}" >/dev/null 2>&1 \
      || fusermount3 -uz "${mount_dir}" >/dev/null 2>&1 \
      || true
  fi
}

cleanup() {
  unmount_probe
  if [[ -n "${fuse_pid}" ]]; then
    kill "${fuse_pid}" >/dev/null 2>&1 || true
    wait "${fuse_pid}" >/dev/null 2>&1 || true
  fi
  docker stop --time 10 "${container_name}" >/dev/null 2>&1 || true
  docker rm -f "${container_name}" >/dev/null 2>&1 || true
  rm -rf -- "${probe_dir}"
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

echo "构建包含真实 PVLog 桥的探针镜像……"
docker build --quiet --tag "${image_name}" "${repo_dir}" >/dev/null
cargo build \
  --quiet \
  --manifest-path "${repo_dir}/crates/workspace-mount-probe/Cargo.toml" \
  --bin pvlog-head-mount-probe

echo "固定当前 main HEAD 并构造 EntryIndex……"
docker run --detach \
  --name "${container_name}" \
  --env-file "${env_file}" \
  --volume "${data_volume}:/data" \
  --volume "${probe_dir}:/probe" \
  --entrypoint node \
  "${image_name}" \
  dist/server/workspace/pvlogMountProbeCli.js \
  /probe/bridge.sock \
  /probe/snapshot.json \
  /probe/metrics.json >/dev/null

for _attempt in {1..300}; do
  [[ -S "${socket_path}" && -f "${snapshot_path}" ]] && break
  if ! docker inspect --format '{{.State.Running}}' "${container_name}" 2>/dev/null \
    | grep -qx true; then
    docker logs "${container_name}" >&2 || true
    echo "PVLog 桥提前退出。" >&2
    exit 1
  fi
  sleep 0.1
done
[[ -S "${socket_path}" && -f "${snapshot_path}" ]] || {
  docker logs "${container_name}" >&2 || true
  echo "PVLog 桥未能在 30 秒内就绪。" >&2
  exit 1
}

"${repo_dir}/crates/workspace-mount-probe/target/debug/pvlog-head-mount-probe" \
  "${snapshot_path}" \
  "${socket_path}" \
  "${mount_dir}" &
fuse_pid="$!"

for _attempt in {1..100}; do
  mountpoint --quiet "${mount_dir}" && break
  kill -0 "${fuse_pid}" >/dev/null 2>&1 || {
    echo "PVLog FUSE 提前退出。" >&2
    exit 1
  }
  sleep 0.1
done
mountpoint --quiet "${mount_dir}" || {
  echo "PVLog FUSE 未能挂载。" >&2
  exit 1
}

echo "枚举固定 HEAD 文件树……"
find "${mount_dir}" -printf '%y %s %p\n' >/dev/null

readarray -t selected < <(
  node - "${snapshot_path}" <<'NODE'
const snapshot = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
const files = snapshot.entries.filter((entry) => entry.kind === "file");
if (files.length === 0) process.exit(2);
files.sort((left, right) => left.size - right.size);
const byInode = new Map(snapshot.entries.map((entry) => [entry.inode, entry]));
function pathOf(entry) {
  const parts = [];
  let current = entry;
  while (current.parentInode !== null) {
    parts.push(current.name);
    current = byInode.get(current.parentInode);
    if (!current) throw new Error("Broken snapshot parent.");
  }
  return parts.reverse().join("/");
}
console.log(pathOf(files[0]));
console.log(pathOf(files.at(-1)));
console.log(files.at(-1).size);
NODE
)
small_path="${selected[0]}"
large_path="${selected[1]}"
large_size="${selected[2]}"

dd if="${mount_dir}/${small_path}" bs=4096 count=1 status=none >/dev/null
if (( large_size > 8192 )); then
  dd \
    if="${mount_dir}/${large_path}" \
    bs=1 \
    skip="$((large_size - 8192))" \
    count=8192 \
    status=none >/dev/null
else
  cat "${mount_dir}/${large_path}" >/dev/null
fi
if (( large_size > 67112960 )); then
  dd \
    if="${mount_dir}/${large_path}" \
    bs=1 \
    skip=67104768 \
    count=8192 \
    status=none >/dev/null
fi

bridge_metrics="$(
  node - "${socket_path}" <<'NODE'
const net = require("node:net");
const socket = net.createConnection(process.argv[2]);
let response = "";
socket.setEncoding("utf8");
socket.on("connect", () => socket.end(JSON.stringify({ op: "stats" })));
socket.on("data", (chunk) => response += chunk);
socket.on("end", () => {
  const parsed = JSON.parse(response);
  if (!parsed.ok) process.exit(1);
  process.stdout.write(JSON.stringify(parsed.metrics));
});
NODE
)"

unmount_probe
wait "${fuse_pid}" >/dev/null 2>&1 || true
fuse_pid=""
docker stop --time 10 "${container_name}" >/dev/null
docker rm "${container_name}" >/dev/null

echo "真实固定 PVLog HEAD 挂载、目录枚举和按需 Range 读取全部通过。"
echo "小文件：${small_path}"
echo "最大文件：${large_path}（${large_size} bytes，仅按需读取尾部和 64 MiB 跨分片区间）"
echo "测量：${bridge_metrics}"

trap - EXIT INT TERM
rm -rf -- "${probe_dir}"
