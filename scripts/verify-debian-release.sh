#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

for file in \
  deploy/bin/biunivers-runtime \
  deploy/bin/biunivers-host \
  deploy/systemd/biunivers-runtime.service \
  deploy/systemd/biunivers-host.service \
  deploy/biunivers.env.example \
  scripts/build-debian-release.sh; do
  [[ -f "$file" ]] || { echo "Missing deployment file: $file" >&2; exit 1; }
done

bash -n deploy/bin/biunivers-runtime
bash -n deploy/bin/biunivers-host
bash -n scripts/build-debian-release.sh

grep -q '^User=biunivers$' deploy/systemd/biunivers-runtime.service
grep -q '^User=biunivers$' deploy/systemd/biunivers-host.service
grep -q '^Requires=biunivers-runtime.service$' deploy/systemd/biunivers-host.service
grep -q '^After=biunivers-runtime.service$' deploy/systemd/biunivers-host.service
grep -q 'BIUNIVERS_DIAGNOSTIC_EXECUTOR_IMAGE' deploy/bin/biunivers-runtime
if grep -Eq -- '--privileged|/var/run/docker.sock|/dev/fuse|SYS_ADMIN' deploy/bin/biunivers-host; then
  echo "Host launcher must not receive Docker, FUSE, privileged, or SYS_ADMIN access." >&2
  exit 1
fi

if command -v systemd-analyze >/dev/null; then
  set +e
  verify_output="$(systemd-analyze verify \
    "$PWD/deploy/systemd/biunivers-runtime.service" \
    "$PWD/deploy/systemd/biunivers-host.service" 2>&1)"
  set -e
  unexpected_output="$(printf '%s\n' "$verify_output" | \
    grep -vE 'Command /opt/biunivers/current/deploy/bin/biunivers-(runtime|host) is not executable: No such file or directory' || true)"
  if [[ -n "$unexpected_output" ]]; then
    printf '%s\n' "$verify_output" >&2
    exit 1
  fi
fi

echo "Debian Release launchers and systemd units passed static verification."
