#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

debian_version="${1:-12}"
case "$debian_version" in
  12)
    image_name=debian-12-genericcloud-amd64.qcow2
    image_base=https://cloud.debian.org/images/cloud/bookworm/latest
    default_port=2212
    ;;
  13)
    image_name=debian-13-genericcloud-amd64.qcow2
    image_base=https://cloud.debian.org/images/cloud/trixie/latest
    default_port=2213
    ;;
  *)
    echo "Usage: prepare-debian-deployment-vm.sh <12|13>" >&2
    exit 2
    ;;
esac

for command in qemu-system-x86_64 qemu-img cloud-localds curl sha512sum ssh-keygen ssh; do
  command -v "$command" >/dev/null || {
    echo "Missing $command. Install qemu-system-x86 qemu-utils cloud-image-utils." >&2
    exit 1
  }
done
[[ -r /dev/kvm && -w /dev/kvm ]] || {
  echo "The current user cannot access /dev/kvm." >&2
  exit 1
}

state_root="${BIUNIVERS_VM_STATE_ROOT:-$PWD/secret/debian-deployment-vm-$debian_version}"
ssh_port="${BIUNIVERS_VM_SSH_PORT:-$default_port}"
mkdir -p "$state_root/cache"
chmod 0700 "$state_root"

base_image="$state_root/cache/$image_name"
checksums="$state_root/cache/SHA512SUMS"
curl --fail --location --show-error --output "$checksums" "$image_base/SHA512SUMS"
if [[ ! -f "$base_image" ]]; then
  curl --fail --location --show-error --output "$base_image.partial" \
    "$image_base/$image_name"
  mv "$base_image.partial" "$base_image"
fi
expected="$(awk -v name="$image_name" '$2 == name || $2 == "*" name { print $1 }' "$checksums")"
[[ "$expected" =~ ^[0-9a-f]{128}$ ]] || {
  echo "Official SHA512SUMS has no unique checksum for $image_name." >&2
  exit 1
}
actual="$(sha512sum "$base_image" | awk '{ print $1 }')"
if [[ "$actual" != "$expected" ]]; then
  echo "Cached Debian image changed upstream; downloading the currently checksummed image..."
  curl --fail --location --show-error --output "$base_image.partial" \
    "$image_base/$image_name"
  actual="$(sha512sum "$base_image.partial" | awk '{ print $1 }')"
  [[ "$actual" == "$expected" ]] || {
    echo "Debian cloud image checksum verification failed." >&2
    exit 1
  }
  mv "$base_image.partial" "$base_image"
fi

key="$state_root/id_ed25519"
if [[ ! -f "$key" ]]; then
  ssh-keygen -q -t ed25519 -N '' -f "$key"
fi
public_key="$(<"$key.pub")"
user_data="$state_root/user-data"
meta_data="$state_root/meta-data"
printf '%s\n' \
  '#cloud-config' \
  'users:' \
  '  - default' \
  '  - name: biunivers-test' \
  '    groups: [sudo]' \
  '    shell: /bin/bash' \
  '    sudo: ALL=(ALL) NOPASSWD:ALL' \
  '    ssh_authorized_keys:' \
  "      - $public_key" \
  'ssh_pwauth: false' \
  'disable_root: true' \
  'package_update: false' > "$user_data"
printf 'instance-id: biunivers-debian-%s\nlocal-hostname: biunivers-debian-%s\n' \
  "$debian_version" "$debian_version" > "$meta_data"
cloud-localds "$state_root/seed.img" "$user_data" "$meta_data"

disk="$state_root/disk.qcow2"
if [[ ! -f "$disk" ]]; then
  qemu-img create -q -f qcow2 -F qcow2 -b "$base_image" "$disk" 32G
fi
pid_file="$state_root/qemu.pid"
if [[ -f "$pid_file" ]] && kill -0 "$(<"$pid_file")" 2>/dev/null; then
  echo "Debian $debian_version VM is already running."
else
  qemu-system-x86_64 \
    -name "biunivers-debian-$debian_version" \
    -enable-kvm -cpu host -smp 4 -m 4096 \
    -drive "if=virtio,format=qcow2,file=$disk" \
    -drive "if=virtio,format=raw,readonly=on,file=$state_root/seed.img" \
    -device virtio-net-pci,netdev=net0 \
    -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:$ssh_port-:22" \
    -display none \
    -serial "file:$state_root/serial.log" \
    -daemonize -pidfile "$pid_file"
fi

echo "Waiting for Debian $debian_version cloud-init and SSH..."
for _ in $(seq 1 180); do
  if ssh -i "$key" -p "$ssh_port" \
    -o BatchMode=yes -o ConnectTimeout=2 -o StrictHostKeyChecking=accept-new \
    -o UserKnownHostsFile="$state_root/known_hosts" \
    biunivers-test@127.0.0.1 cloud-init status --wait >/dev/null 2>&1; then
    echo "Debian $debian_version VM is ready."
    echo "Base image SHA-512: $actual"
    echo "SSH: ssh -i $key -p $ssh_port biunivers-test@127.0.0.1"
    echo "State: $state_root"
    exit 0
  fi
  sleep 2
done

echo "VM did not become ready; inspect $state_root/serial.log" >&2
exit 1
