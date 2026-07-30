#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/biunivers-workspace-probe.XXXXXX")"
lower_dir="${probe_dir}/lower"
upper_dir="${probe_dir}/upper"
work_dir="${probe_dir}/work"
merged_dir="${probe_dir}/merged"
probe_pid=""
docker_enabled=false

if [[ "${1:-}" == "--docker" ]]; then
  docker_enabled=true
elif [[ $# -gt 0 ]]; then
  echo "用法：$0 [--docker]" >&2
  exit 2
fi

mkdir -p "${lower_dir}" "${upper_dir}" "${work_dir}" "${merged_dir}"
chmod 0711 "${probe_dir}"

unmount_path() {
  local target="$1"
  if mountpoint --quiet "${target}"; then
    fusermount3 -u "${target}" >/dev/null 2>&1 \
      || fusermount3 -uz "${target}" >/dev/null 2>&1 \
      || true
  fi
}

cleanup() {
  unmount_path "${merged_dir}"
  unmount_path "${lower_dir}"
  if [[ -n "${probe_pid}" ]]; then
    kill "${probe_pid}" >/dev/null 2>&1 || true
    wait "${probe_pid}" >/dev/null 2>&1 || true
  fi
  rm -rf -- "${probe_dir}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for command_name in cargo fusermount3 fuse-overlayfs mountpoint python3; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "缺少依赖：${command_name}" >&2
    exit 1
  fi
done

if [[ "${docker_enabled}" == true ]] \
  && ! grep -Eq '^[[:space:]]*user_allow_other([[:space:]]|$)' /etc/fuse.conf 2>/dev/null; then
  echo "Docker bind mount 需要在 /etc/fuse.conf 中启用 user_allow_other。" >&2
  echo "请先执行：echo user_allow_other | sudo tee -a /etc/fuse.conf" >&2
  exit 1
fi

echo "构建只读 FUSE 探针……"
cargo build \
  --quiet \
  --manifest-path "${repo_dir}/crates/workspace-mount-probe/Cargo.toml"

probe_arguments=("${lower_dir}")
overlay_options="lowerdir=${lower_dir},upperdir=${upper_dir},workdir=${work_dir}"
if [[ "${docker_enabled}" == true ]]; then
  probe_arguments=("--allow-other" "${lower_dir}")
  overlay_options="${overlay_options},allow_other"
fi

"${repo_dir}/crates/workspace-mount-probe/target/debug/workspace-mount-probe" \
  "${probe_arguments[@]}" &
probe_pid="$!"

for _attempt in {1..50}; do
  if mountpoint --quiet "${lower_dir}"; then
    break
  fi
  if ! kill -0 "${probe_pid}" >/dev/null 2>&1; then
    echo "只读 FUSE 探针提前退出。" >&2
    exit 1
  fi
  sleep 0.1
done
mountpoint --quiet "${lower_dir}" || {
  echo "只读 FUSE 探针未能挂载。" >&2
  exit 1
}

[[ "$(cat "${lower_dir}/hello.txt")" == "Biunivers Workspace mount probe" ]]
[[ "$(dd if="${lower_dir}/boundary.bin" bs=1 skip=1048573 count=4 status=none | od -An -tu1 | xargs)" == "25 56 87 118" ]]
if touch "${lower_dir}/must-not-exist" 2>/dev/null; then
  echo "Lower 意外允许写入。" >&2
  exit 1
fi

echo "挂载 fuse-overlayfs COW 层……"
fuse-overlayfs \
  -o "${overlay_options}" \
  "${merged_dir}"
mountpoint --quiet "${merged_dir}" || {
  echo "COW 层未能挂载。" >&2
  exit 1
}

[[ "$(cat "${merged_dir}/hello.txt")" == "Biunivers Workspace mount probe" ]]
printf "overridden\n" >"${merged_dir}/hello.txt"
printf "created\n" >"${merged_dir}/created.txt"
mv "${merged_dir}/created.txt" "${merged_dir}/renamed.txt"
rm "${merged_dir}/docs/readme.md"
mkdir "${merged_dir}/new-directory"
printf "nested\n" >"${merged_dir}/new-directory/nested.txt"

[[ "$(cat "${merged_dir}/hello.txt")" == "overridden" ]]
[[ "$(cat "${lower_dir}/hello.txt")" == "Biunivers Workspace mount probe" ]]
[[ "$(cat "${merged_dir}/renamed.txt")" == "created" ]]
[[ ! -e "${merged_dir}/docs/readme.md" ]]
[[ -f "${merged_dir}/new-directory/nested.txt" ]]
[[ -f "${upper_dir}/hello.txt" ]]
[[ -f "${upper_dir}/renamed.txt" ]]
[[ -f "${upper_dir}/new-directory/nested.txt" ]]

whiteout_description="$(
  find "${upper_dir}/docs" -mindepth 1 -maxdepth 1 -printf '%f:%y\n' 2>/dev/null \
    | LC_ALL=C sort \
    | paste -sd, -
)"
if [[ -z "${whiteout_description}" ]]; then
  echo "Upper 没有表达 Lower 文件删除。" >&2
  exit 1
fi

rm -rf "${merged_dir}/docs"
mkdir "${merged_dir}/docs"
printf "replacement\n" >"${merged_dir}/docs/replacement.txt"
[[ "$(cat "${merged_dir}/docs/replacement.txt")" == "replacement" ]]
[[ ! -e "${merged_dir}/docs/readme.md" ]]

opaque_description="$(
  python3 - "${upper_dir}/docs" <<'PY'
import os
import sys

path = sys.argv[1]
parts = []
for name in sorted(os.listxattr(path)):
    value = os.getxattr(path, name)
    parts.append(f"{name}={value.hex()}")
print(",".join(parts))
PY
)"
if [[ "${opaque_description}" != *"opaque"* ]]; then
  echo "Upper 没有用扩展属性表达被替换的 Lower 目录：${opaque_description:-无扩展属性}" >&2
  exit 1
fi

if [[ "${docker_enabled}" == true ]]; then
  command -v docker >/dev/null 2>&1 || {
    echo "缺少依赖：docker" >&2
    exit 1
  }
  echo "验证隔离容器只看到 merged 工作区……"
  docker run --rm \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --pids-limit 64 \
    --memory 128m \
    --cpus 0.5 \
    --user "$(id -u):$(id -g)" \
    --volume "${merged_dir}:/workspace:rw" \
    --workdir /workspace \
    node:24-alpine \
    sh -eu -c '
      test "$(cat hello.txt)" = "overridden"
      test ! -e /data
      test ! -S /var/run/docker.sock
      printf "container\n" > container-output.txt
    '
  [[ "$(cat "${merged_dir}/container-output.txt")" == "container" ]]
  [[ -f "${upper_dir}/container-output.txt" ]]
fi

unmount_path "${merged_dir}"
unmount_path "${lower_dir}"
wait "${probe_pid}" >/dev/null 2>&1 || true
probe_pid=""

if mountpoint --quiet "${merged_dir}" || mountpoint --quiet "${lower_dir}"; then
  echo "探针卸载后仍残留 mount。" >&2
  exit 1
fi

trap - EXIT INT TERM
rm -rf -- "${probe_dir}"

echo "只读 FUSE、COW 读写隔离、Upper 变化和清理全部通过。"
echo "删除标记：${whiteout_description}"
echo "不透明目录：${opaque_description}"
if [[ "${docker_enabled}" == false ]]; then
  echo "Docker 隔离尚未测试；可运行：sg docker -c 'bash scripts/run-workspace-mount-probe.sh --docker'"
fi
