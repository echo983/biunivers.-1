#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

workflow=.github/workflows/release.yml
[[ -f "$workflow" ]] || { echo "Stable Release workflow is missing." >&2; exit 1; }

grep -Fq 'tags:' "$workflow"
grep -Fq '"v*.*.*"' "$workflow"
grep -Fq 'container: node:24-bookworm' "$workflow"
grep -Fq 'BIUNIVERS_RELEASE_HOST_DIGEST:' "$workflow"
grep -Fq 'BIUNIVERS_RELEASE_DIAGNOSTIC_DIGEST:' "$workflow"
grep -Fq 'permissions:' "$workflow"
grep -Fq 'packages: write' "$workflow"
grep -Fq 'contents: write' "$workflow"
grep -Fq 'sha256sum --check SHA256SUMS' "$workflow"
grep -Fq 'gh release create' "$workflow"
grep -Fq 'Verify anonymous image access' "$workflow"

if grep -Eq 'ghcr\.io/[^[:space:]]+:(latest|main)' "$workflow"; then
  echo "Stable Release workflow must not publish or consume floating latest/main artifacts." >&2
  exit 1
fi
if grep -Eq 'curl[^|]*\|[[:space:]]*(sudo[[:space:]]+)?(bash|sh)' "$workflow"; then
  echo "Stable Release workflow must not pipe an unverified download into a shell." >&2
  exit 1
fi

echo "Stable Release workflow passed tag, Debian, digest, checksum, and permission checks."
