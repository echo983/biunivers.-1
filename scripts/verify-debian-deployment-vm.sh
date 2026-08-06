#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

debian_version="${1:-}"
version="${2:-}"
release_dir="${3:-}"
environment_file="${4:-}"
if [[ ! "$debian_version" =~ ^(12|13)$ || ! "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
  [[ ! -d "$release_dir" || ! -f "$environment_file" ]]; then
  echo "Usage: verify-debian-deployment-vm.sh <12|13> <vX.Y.Z> <release-dir> <env-file>" >&2
  exit 2
fi

default_port=$((2200 + debian_version))
state_root="${BIUNIVERS_VM_STATE_ROOT:-$PWD/secret/debian-deployment-vm-$debian_version}"
ssh_port="${BIUNIVERS_VM_SSH_PORT:-$default_port}"
key="$state_root/id_ed25519"
known_hosts="$state_root/known_hosts"
asset="biunivers-runtime-$version-linux-x64.tar.zst"
installer="biunivers-install-$version.sh"
for file in "$release_dir/$asset" "$release_dir/$installer" "$release_dir/SHA256SUMS" "$key"; do
  [[ -f "$file" ]] || { echo "Missing acceptance input: $file" >&2; exit 1; }
done

ssh_command=(ssh -i "$key" -p "$ssh_port" -o BatchMode=yes \
  -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$known_hosts" \
  biunivers-test@127.0.0.1)
scp_command=(scp -i "$key" -P "$ssh_port" -o BatchMode=yes \
  -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$known_hosts")

"${ssh_command[@]}" 'mkdir -p /tmp/biunivers-acceptance'
"${scp_command[@]}" \
  "$release_dir/$asset" "$release_dir/$installer" "$release_dir/SHA256SUMS" \
  "$environment_file" \
  biunivers-test@127.0.0.1:/tmp/biunivers-acceptance/

remote_env="/tmp/biunivers-acceptance/$(basename "$environment_file")"
"${ssh_command[@]}" \
  "cd /tmp/biunivers-acceptance && sha256sum --check --ignore-missing SHA256SUMS && sudo bash '$installer' --version '$version' --release-dir /tmp/biunivers-acceptance --env-file '$remote_env'"

verify_remote() {
  "${ssh_command[@]}" "set -euo pipefail
    test \"\$(cat /etc/debian_version)\" != ''
    test \"\$(readlink /opt/biunivers/current)\" = 'releases/$version'
    sudo systemctl is-active --quiet biunivers-runtime.service
    sudo systemctl is-active --quiet biunivers-host.service
    test -S /run/biunivers/runtime.sock
    curl --fail --silent http://127.0.0.1:8080/health >/dev/null
    curl --fail --silent http://127.0.0.1:8081/health >/dev/null
    curl --fail --silent -H 'Sec-Fetch-Site: same-origin' http://127.0.0.1:8080/api/v1/control/file-service | grep -q '\"mode\":\"ready\"'
    sudo docker network inspect biunivers-bwa >/dev/null
    test \"\$(sudo docker inspect --format '{{.HostConfig.Privileged}}' biunivers-host)\" = false
    test \"\$(sudo docker inspect --format '{{.Config.User}}' biunivers-host)\" != '0'
    ! sudo docker inspect --format '{{json .HostConfig.Binds}}' biunivers-host | grep -q '/var/run/docker.sock'
    ! grep -Eq '^(PrivateMounts|PrivateTmp|ProtectSystem|NoNewPrivileges)=' /etc/systemd/system/biunivers-runtime.service
  "
}

verify_remote
before_status="$("${ssh_command[@]}" \
  "curl --fail --silent -H 'Sec-Fetch-Site: same-origin' http://127.0.0.1:8080/api/v1/control/file-service")"

echo "Rebooting Debian $debian_version VM..."
"${ssh_command[@]}" sudo systemctl reboot >/dev/null 2>&1 || true
went_down=false
for _ in $(seq 1 60); do
  if ! "${ssh_command[@]}" true >/dev/null 2>&1; then
    went_down=true
    break
  fi
  sleep 1
done
[[ "$went_down" == true ]] || { echo "VM did not go down for reboot." >&2; exit 1; }
for _ in $(seq 1 120); do
  if "${ssh_command[@]}" true >/dev/null 2>&1; then break; fi
  sleep 2
done
verify_remote
after_status="$("${ssh_command[@]}" \
  "curl --fail --silent -H 'Sec-Fetch-Site: same-origin' http://127.0.0.1:8080/api/v1/control/file-service")"
[[ "$after_status" == "$before_status" ]] || {
  echo "File Service status changed across reboot." >&2
  exit 1
}

"${ssh_command[@]}" 'rm -f /tmp/biunivers-acceptance/*'
echo "Debian $debian_version installation, permissions, health, and reboot persistence passed."
