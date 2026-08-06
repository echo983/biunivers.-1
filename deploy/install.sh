#!/usr/bin/env bash
set -euo pipefail

repository="${BIUNIVERS_GITHUB_REPOSITORY:-echo983/biunivers.-1}"
version=""
environment_source=""
offline_release_dir=""
install_root="/"
stage_only=false

usage() {
  printf '%s\n' \
    "Usage: biunivers-install --version vMAJOR.MINOR.PATCH [options]" \
    "" \
    "Options:" \
    "  --env-file PATH       Complete environment file; required for a fresh install." \
    "  --release-dir PATH    Use already downloaded Release assets." \
    "  --repository OWNER/REPO  GitHub repository (default: $repository)." \
    "  --root PATH           Alternate root; only valid with --stage-only." \
    "  --stage-only          Stage files without apt, Docker, users or systemd." \
    "  --help                Show this help."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      [[ $# -ge 2 ]] || { echo "--version requires a value." >&2; exit 2; }
      version="$2"
      shift 2
      ;;
    --env-file)
      [[ $# -ge 2 ]] || { echo "--env-file requires a path." >&2; exit 2; }
      environment_source="$2"
      shift 2
      ;;
    --release-dir)
      [[ $# -ge 2 ]] || { echo "--release-dir requires a path." >&2; exit 2; }
      offline_release_dir="$2"
      shift 2
      ;;
    --repository)
      [[ $# -ge 2 ]] || { echo "--repository requires a value." >&2; exit 2; }
      repository="$2"
      shift 2
      ;;
    --root)
      [[ $# -ge 2 ]] || { echo "--root requires a path." >&2; exit 2; }
      install_root="${2%/}"
      [[ -n "$install_root" ]] || install_root="/"
      shift 2
      ;;
    --stage-only)
      stage_only=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "--version must be a stable vMAJOR.MINOR.PATCH value." >&2
  exit 2
fi
if [[ ! "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "--repository must be OWNER/REPO." >&2
  exit 2
fi
if [[ "$install_root" != "/" && "$stage_only" != true ]]; then
  echo "--root is a verification feature and requires --stage-only." >&2
  exit 2
fi
if [[ -n "$environment_source" && ! -f "$environment_source" ]]; then
  echo "Environment file does not exist: $environment_source" >&2
  exit 2
fi
if [[ "$stage_only" != true && -z "$environment_source" && \
  ! -f /etc/biunivers/biunivers.env ]]; then
  echo "A complete Biunivers environment file is required for installation." >&2
  echo "Pass it with: --env-file /path/to/biunivers.env" >&2
  exit 2
fi
if [[ -n "$offline_release_dir" && ! -d "$offline_release_dir" ]]; then
  echo "Release directory does not exist: $offline_release_dir" >&2
  exit 2
fi

root_path() {
  local path="$1"
  if [[ "$install_root" == "/" ]]; then
    printf '%s\n' "$path"
  else
    printf '%s%s\n' "$install_root" "$path"
  fi
}

# Parse the last occurrence of KEY=value from /etc/biunivers/biunivers.env.
# This intentionally mirrors the simple dotenv subset used by Node --env-file
# and docker run --env-file: comments only count when the line starts with #,
# values may contain # characters, and surrounding whitespace/quotes are stripped.
read_env_value() {
  local file="$1" key="$2" default="${3:-}" line value
  line="$(grep -E "^[[:space:]]*${key}=" "$file" 2>/dev/null | tail -n 1)" || true
  value="${line#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
    value="${value:1:-1}"
  elif [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
    value="${value:1:-1}"
  fi
  if [[ -z "$value" ]]; then
    printf '%s\n' "$default"
  else
    printf '%s\n' "$value"
  fi
}

# Return 0 when something is already listening on the given TCP port.
is_port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -H -ln "sport = :$port" 2>/dev/null | grep -q .
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ln 2>/dev/null | grep -Eq ":${port}[[:space:]]"
  else
    # No tool available to verify; assume free so the install can proceed.
    return 1
  fi
}

opt_root="$(root_path /opt/biunivers)"
config_root="$(root_path /etc/biunivers)"
state_root="$(root_path /var/lib/biunivers)"
cache_root="$(root_path /var/cache/biunivers)"
unit_root="$(root_path /etc/systemd/system)"
database="$state_root/data/file-service/file-service.sqlite"
release_name="biunivers-runtime-$version-linux-x64"
asset_name="$release_name.tar.zst"

if [[ "$stage_only" != true ]]; then
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "The Biunivers installer must run as root." >&2
    exit 1
  fi
  if [[ ! -r /etc/os-release ]]; then
    echo "Cannot identify this operating system." >&2
    exit 1
  fi
  # os-release is owned by the operating system and contains shell assignments.
  # shellcheck disable=SC1091
  source /etc/os-release
  if [[ "${ID:-}" != debian || ! "${VERSION_ID:-}" =~ ^(12|13)$ ]]; then
    echo "Biunivers V0.16 supports Debian 12 and Debian 13 only." >&2
    exit 1
  fi
  if [[ "$(uname -m)" != x86_64 ]]; then
    echo "Biunivers V0.16 supports x86_64 only." >&2
    exit 1
  fi

  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  required_packages=(ca-certificates curl fuse3 fuse-overlayfs openssl zstd)
  if ! command -v docker >/dev/null; then
    required_packages+=(docker.io)
  fi
  apt-get install -y "${required_packages[@]}"
  systemctl enable --now docker.service

  if ! getent group docker >/dev/null; then
    groupadd --system docker
  fi
  if ! id biunivers >/dev/null 2>&1; then
    useradd --system --user-group --home-dir /var/lib/biunivers --no-create-home \
      --shell /usr/sbin/nologin biunivers
  fi
  getent group biunivers >/dev/null || {
    echo "The existing biunivers user has no matching biunivers group." >&2
    exit 1
  }
  usermod --append --groups docker biunivers
fi

download_root=""
if [[ -n "$offline_release_dir" ]]; then
  release_source="$offline_release_dir"
else
  for command in curl sha256sum tar zstd; do
    command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
  done
  download_root="$(mktemp -d)"
  trap 'if [[ -n "${download_root:-}" ]]; then rm -rf -- "$download_root"; fi' EXIT
  release_source="$download_root"
  release_url="https://github.com/$repository/releases/download/$version"
  curl --fail --location --show-error --output "$release_source/SHA256SUMS" \
    "$release_url/SHA256SUMS"
  curl --fail --location --show-error --output "$release_source/$asset_name" \
    "$release_url/$asset_name"
fi

checksum_file="$release_source/SHA256SUMS"
asset_file="$release_source/$asset_name"
if [[ ! -f "$checksum_file" || ! -f "$asset_file" ]]; then
  echo "Release assets are incomplete in $release_source." >&2
  exit 1
fi
expected_checksum="$(awk -v name="$asset_name" '$2 == name || $2 == "*" name { print $1 }' "$checksum_file")"
if [[ ! "$expected_checksum" =~ ^[0-9a-f]{64}$ ]]; then
  echo "SHA256SUMS does not contain one valid checksum for $asset_name." >&2
  exit 1
fi
actual_checksum="$(sha256sum "$asset_file" | awk '{ print $1 }')"
if [[ "$actual_checksum" != "$expected_checksum" ]]; then
  echo "Release checksum verification failed for $asset_name." >&2
  exit 1
fi

mkdir -p "$opt_root/releases" "$config_root" "$state_root/data" \
  "$state_root/runtime/runs" "$cache_root/chunks" "$unit_root"
release_target="$opt_root/releases/$version"
extract_root="$(mktemp -d "$opt_root/releases/.install-$version.XXXXXX")"
trap 'rm -rf -- "${extract_root:-}"; if [[ -n "${download_root:-}" ]]; then rm -rf -- "$download_root"; fi' EXIT
zstd -dc "$asset_file" | tar -xf - -C "$extract_root"
extracted="$extract_root/$release_name"
for required in \
  release.json \
  node/bin/node \
  app/dist/server/files/fileServiceGenesisCli.js \
  app/dist/server/files/fileServiceVerifyCli.js \
  bin/biunivers-pvlogfs \
  bin/biunivers-workspace-cow-scan \
  deploy/bin/biunivers-runtime \
  deploy/bin/biunivers-host \
  deploy/bin/biunivers-update \
  deploy/systemd/biunivers-runtime.service \
  deploy/systemd/biunivers-host.service \
  deploy/biunivers.env.example; do
  [[ -e "$extracted/$required" ]] || { echo "Release is missing $required." >&2; exit 1; }
done

metadata="$extracted/release.json"
metadata_output="$("$extracted/node/bin/node" --input-type=module - "$metadata" "$version" <<'NODE'
import { readFileSync } from "node:fs";
const [path, requestedVersion] = process.argv.slice(2);
const value = JSON.parse(readFileSync(path, "utf8"));
const digest = /^sha256:[0-9a-f]{64}$/;
const image = /^ghcr\.io\/[a-z0-9._/-]+:v[0-9]+\.[0-9]+\.[0-9]+$/;
if (
  value.schemaVersion !== 1 ||
  value.version !== requestedVersion ||
  value.platform !== "linux" ||
  value.architecture !== "x64" ||
  !image.test(value.hostImage) ||
  !digest.test(value.hostDigest) ||
  !image.test(value.diagnosticImage) ||
  !digest.test(value.diagnosticDigest) ||
  value.refStoreSchema?.minimum !== 6 ||
  value.refStoreSchema?.maximum !== 6
) {
  throw new Error("Release metadata is incomplete, incompatible, or not digest-pinned.");
}
process.stdout.write([
  value.hostImage,
  value.hostDigest,
  value.diagnosticImage,
  value.diagnosticDigest,
].join("\n"));
NODE
)"
mapfile -t release_values <<< "$metadata_output"
host_tag="${release_values[0]}"
host_digest="${release_values[1]}"
diagnostic_tag="${release_values[2]}"
diagnostic_digest="${release_values[3]}"
host_reference="${host_tag%:*}@$host_digest"
diagnostic_reference="${diagnostic_tag%:*}@$diagnostic_digest"

current_link="$opt_root/current"
if [[ -e "$current_link" || -L "$current_link" ]]; then
  if [[ ! -L "$current_link" || "$(readlink "$current_link")" != "releases/$version" ]]; then
    if [[ "$stage_only" != true && ! -e "$database" ]] && \
      ! systemctl is-active --quiet biunivers-host.service && \
      ! systemctl is-active --quiet biunivers-runtime.service; then
      echo "Recovering an incomplete installation that never created a RefStore."
    else
      echo "Another Biunivers version is already active; use biunivers-update instead of the installer." >&2
      exit 1
    fi
  fi
fi

if [[ "$stage_only" != true ]]; then
  image_tags=("$host_tag" "$diagnostic_tag")
  image_references=("$host_reference" "$diagnostic_reference")
  for index in 0 1; do
    image_tag="${image_tags[$index]}"
    image_reference="${image_references[$index]}"
    docker pull "$image_tag" >/dev/null
    tag_image_id="$(docker image inspect --format '{{.Id}}' "$image_tag")"
    digest_image_id="$(docker image inspect --format '{{.Id}}' "$image_reference" 2>/dev/null || true)"
    if [[ -z "$digest_image_id" || "$tag_image_id" != "$digest_image_id" ]]; then
      echo "Pulled tag does not match the expected image digest: $image_reference" >&2
      exit 1
    fi
  done
fi

if [[ -e "$release_target" ]]; then
  if [[ ! -f "$release_target/release.json" ]] || \
    ! cmp --silent "$metadata" "$release_target/release.json"; then
    echo "The installed $version directory does not match this Release." >&2
    exit 1
  fi
else
  mv "$extracted" "$release_target"
fi
chmod -R a+rX "$release_target"

activate_release() {
  ln -sfn "releases/$version" "$opt_root/current.new"
  mv -Tf "$opt_root/current.new" "$opt_root/current"
}

if [[ -n "$environment_source" ]]; then
  install -m 0640 "$environment_source" "$config_root/biunivers.env"
elif [[ ! -e "$config_root/biunivers.env" ]]; then
  # Only isolated --stage-only verification reaches this branch.
  install -m 0640 "$release_target/deploy/biunivers.env.example" \
    "$config_root/biunivers.env"
fi

if [[ ! -e "$config_root/runtime-token" ]]; then
  if command -v openssl >/dev/null; then
    umask 077
    openssl rand -hex 32 > "$config_root/runtime-token"
  elif [[ "$stage_only" == true ]]; then
    printf '%064d\n' 0 > "$config_root/runtime-token"
  else
    echo "OpenSSL is required to create the Runtime token." >&2
    exit 1
  fi
fi
chmod 0640 "$config_root/biunivers.env" "$config_root/runtime-token"

desktop_port="$(read_env_value "$config_root/biunivers.env" BIUNIVERS_DESKTOP_PORT 8090)"
app_port="$(read_env_value "$config_root/biunivers.env" BIUNIVERS_APP_PORT 8091)"
desktop_bind="$(read_env_value "$config_root/biunivers.env" BIUNIVERS_DESKTOP_BIND 127.0.0.1)"
app_bind="$(read_env_value "$config_root/biunivers.env" BIUNIVERS_APP_BIND 127.0.0.1)"
for key_port in "BIUNIVERS_DESKTOP_PORT:$desktop_port" "BIUNIVERS_APP_PORT:$app_port"; do
  key="${key_port%%:*}"
  port="${key_port#*:}"
  if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
    echo "$key must be an integer from 1 to 65535." >&2
    exit 1
  fi
done

release_record="$config_root/release"
umask 077
printf 'BIUNIVERS_VERSION=%q\n' "$version" > "$release_record"
printf 'BIUNIVERS_HOST_IMAGE=%q\n' "$host_reference" >> "$release_record"
printf 'BIUNIVERS_DIAGNOSTIC_EXECUTOR_IMAGE=%q\n' "$diagnostic_reference" >> "$release_record"
chmod 0640 "$release_record"

install -m 0644 "$release_target/deploy/systemd/biunivers-runtime.service" \
  "$unit_root/biunivers-runtime.service"
install -m 0644 "$release_target/deploy/systemd/biunivers-host.service" \
  "$unit_root/biunivers-host.service"
command_root="$(root_path /usr/local/sbin)"
mkdir -p "$command_root"
install -m 0755 "$release_target/deploy/bin/biunivers-update" \
  "$command_root/biunivers-update"

if [[ "$stage_only" == true ]]; then
  activate_release
  echo "Biunivers $version staged successfully below $install_root."
  exit 0
fi

chmod 0755 "$opt_root" "$opt_root/releases" "$state_root" "$cache_root"
chown -R biunivers:biunivers "$state_root" "$cache_root"
chown root:biunivers "$config_root"
chown root:biunivers "$config_root/biunivers.env" "$config_root/runtime-token" "$release_record"
chmod 0750 "$config_root"

if ! grep -Eq '^[[:space:]]*user_allow_other([[:space:]]*(#.*)?)?$' /etc/fuse.conf; then
  printf '\nuser_allow_other\n' >> /etc/fuse.conf
fi

if [[ ! -e "$database" ]]; then
  mkdir -p "$(dirname "$database")"
  chown -R biunivers:biunivers "$(dirname "$database")"
  chmod 0755 "$(dirname "$database")"
  if ! runuser -u biunivers -- env HOME="$state_root" TMPDIR=/tmp BIUNIVERS_DATA_DIR="$state_root/data" \
    "$release_target/node/bin/node" \
    --env-file="$config_root/biunivers.env" \
    "$release_target/app/dist/server/files/fileServiceGenesisCli.js"; then
    echo "S3/File Service initialization failed." >&2
    echo "Check endpoint, bucket, prefix, namespace and GetObject/PutObject permissions." >&2
    exit 1
  fi
else
  if ! runuser -u biunivers -- env HOME="$state_root" TMPDIR=/tmp BIUNIVERS_DATA_DIR="$state_root/data" \
    "$release_target/node/bin/node" \
    --env-file="$config_root/biunivers.env" \
    "$release_target/app/dist/server/files/fileServiceVerifyCli.js"; then
    echo "Existing RefStore or its S3 objects could not be verified." >&2
    echo "No service was started; check the S3 configuration and storage availability." >&2
    exit 1
  fi
fi

# After a successful first-time initialization, prevent the Runtime from
# re-running genesis on every restart. The env file remains authoritative
# for other settings; we only flip the one-shot initialization flag.
if ! grep -Eq '^[[:space:]]*BIUNIVERS_FILE_INITIALIZE=[[:space:]]*false[[:space:]]*(#.*)?$' "$config_root/biunivers.env"; then
  sed -i 's/^[[:space:]]*BIUNIVERS_FILE_INITIALIZE=.*/BIUNIVERS_FILE_INITIALIZE=false/' "$config_root/biunivers.env"
  if ! grep -Eq '^[[:space:]]*BIUNIVERS_FILE_INITIALIZE=' "$config_root/biunivers.env"; then
    printf '\nBIUNIVERS_FILE_INITIALIZE=false\n' >> "$config_root/biunivers.env"
  fi
fi

# The active version changes only after S3 and RefStore validation succeeds.
activate_release

# Make sure the BWA bridge exists before any container tries to join it. The
# Compute Runtime also calls ensure() on this network, but creating it here
# prevents the Host container from crash-looping with "network not found"
# if Runtime fails before it reaches its own network setup.
if ! docker network inspect biunivers-bwa >/dev/null 2>&1; then
  docker network create \
    --driver bridge \
    --label io.biunivers.managed=bwa.v1 \
    biunivers-bwa
fi

for key_port in "BIUNIVERS_DESKTOP_PORT:$desktop_port" "BIUNIVERS_APP_PORT:$app_port"; do
  key="${key_port%%:*}"
  port="${key_port#*:}"
  if is_port_in_use "$port"; then
    echo "$key=$port is already in use on this machine." >&2
    echo "Edit $config_root/biunivers.env and choose a free port, then re-run the installer." >&2
    exit 1
  fi
done

systemctl daemon-reload
systemctl enable biunivers-host.service >/dev/null
systemctl stop biunivers-host.service >/dev/null 2>&1 || true
systemctl restart biunivers-runtime.service
systemctl start biunivers-host.service

healthy=false
for _ in $(seq 1 60); do
  if curl --fail --silent "http://$desktop_bind:$desktop_port/health" >/dev/null && \
    curl --fail --silent "http://$app_bind:$app_port/health" >/dev/null && \
    curl --fail --silent -H 'Sec-Fetch-Site: same-origin' \
      "http://$desktop_bind:$desktop_port/api/v1/control/file-service" | \
      grep -q '"mode":"ready"'; then
    healthy=true
    break
  fi
  sleep 1
done
if [[ "$healthy" != true ]]; then
  echo "Biunivers failed its startup health gate." >&2
  echo "Inspect: journalctl -u biunivers-runtime -u biunivers-host --no-pager -n 200" >&2
  exit 1
fi

echo "Biunivers $version is running on $desktop_bind:$desktop_port (desktop) and $app_bind:$app_port (app)."
