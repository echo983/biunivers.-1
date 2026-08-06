#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
debian_version="${1:-12}"
[[ "$debian_version" == 12 || "$debian_version" == 13 ]] || {
  echo "Usage: stop-debian-deployment-vm.sh <12|13>" >&2
  exit 2
}
default_port=$((2200 + debian_version))
state_root="${BIUNIVERS_VM_STATE_ROOT:-$PWD/secret/debian-deployment-vm-$debian_version}"
ssh_port="${BIUNIVERS_VM_SSH_PORT:-$default_port}"
pid_file="$state_root/qemu.pid"
key="$state_root/id_ed25519"

if [[ ! -f "$pid_file" ]] || ! kill -0 "$(<"$pid_file")" 2>/dev/null; then
  echo "Debian $debian_version VM is not running."
  exit 0
fi

ssh -i "$key" -p "$ssh_port" \
  -o BatchMode=yes -o ConnectTimeout=3 -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile="$state_root/known_hosts" \
  biunivers-test@127.0.0.1 sudo systemctl poweroff >/dev/null 2>&1 || true

pid="$(<"$pid_file")"
for _ in $(seq 1 60); do
  kill -0 "$pid" 2>/dev/null || { rm -f "$pid_file"; echo "VM stopped."; exit 0; }
  sleep 1
done
echo "VM did not stop within 60 seconds; PID $pid was not killed." >&2
exit 1
