#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
for file in \
  scripts/prepare-debian-deployment-vm.sh \
  scripts/stop-debian-deployment-vm.sh \
  scripts/verify-debian-deployment-vm.sh; do
  bash -n "$file"
done
grep -q 'cloud.debian.org/images/cloud/bookworm/latest' scripts/prepare-debian-deployment-vm.sh
grep -q 'cloud.debian.org/images/cloud/trixie/latest' scripts/prepare-debian-deployment-vm.sh
grep -q 'sha512sum' scripts/prepare-debian-deployment-vm.sh
grep -q -- '-enable-kvm' scripts/prepare-debian-deployment-vm.sh
grep -q 'systemctl reboot' scripts/verify-debian-deployment-vm.sh
grep -q 'Privileged' scripts/verify-debian-deployment-vm.sh
grep -q 'File Service status changed across reboot' scripts/verify-debian-deployment-vm.sh
if grep -Eq 'StrictHostKeyChecking=(no|false)' scripts/*debian-deployment-vm.sh; then
  echo "VM harness must not disable SSH host-key checking." >&2
  exit 1
fi
echo "Debian 12/13 KVM deployment harness passed static verification."
