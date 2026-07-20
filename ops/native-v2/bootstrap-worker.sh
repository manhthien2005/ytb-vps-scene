#!/usr/bin/env bash
# Supported host: ubuntu-22.04 x86_64.
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: bootstrap-worker.sh APP_ORIGIN ENROLLMENT_TOKEN RELEASE_REPOSITORY RELEASE_COMMIT" >&2
  exit 64
fi

app_origin=$1
enrollment_token=$2
repository=$3
commit=$4

if [[ ${EUID} -ne 0 ]]; then echo "must run as root" >&2; exit 77; fi
if [[ ! -r /etc/os-release ]] || ! grep -q '^ID=ubuntu$' /etc/os-release || ! grep -q '^VERSION_ID="22.04"$' /etc/os-release; then
  echo "Ubuntu 22.04 is required" >&2; exit 78
fi
if [[ $(uname -m) != "x86_64" ]]; then echo "x86_64 is required" >&2; exit 78; fi
if [[ ! "$app_origin" =~ ^https://[^/]+$ ]]; then echo "invalid app origin" >&2; exit 64; fi
if [[ ! "$enrollment_token" =~ ^[A-Za-z0-9_-]{43}$ ]]; then echo "invalid enrollment token" >&2; exit 64; fi
if [[ ! "$repository" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git$ ]]; then echo "invalid release repository" >&2; exit 64; fi
if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then echo "invalid release commit" >&2; exit 64; fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates git python3.10 python3.10-venv

id -u ytb-vps >/dev/null 2>&1 || useradd --system --home-dir /var/lib/ytb-vps --create-home --shell /usr/sbin/nologin ytb-vps
install -d -o ytb-vps -g ytb-vps -m 0700 /var/lib/ytb-vps
install -d -o root -g root -m 0755 /opt/ytb-vps/releases

release=/opt/ytb-vps/releases/$commit
if [[ ! -d "$release/.git" ]]; then
  temporary=$(mktemp -d /opt/ytb-vps/.release.XXXXXX)
  trap 'rm -rf -- "$temporary"' EXIT
  git -C "$temporary" init --quiet
  git -C "$temporary" remote add origin "$repository"
  git -C "$temporary" fetch --quiet --depth 1 origin "$commit"
  git -C "$temporary" checkout --detach "$commit"
  mv -- "$temporary" "$release"
  trap - EXIT
fi

python3.10 -m venv "$release/.venv"
"$release/.venv/bin/pip" install --no-deps --no-build-isolation "$release"
"$release/.venv/bin/python" -m ytb_vps_v2 worker-enroll \
  --origin "$app_origin" \
  --token "$enrollment_token" \
  --credential-path /var/lib/ytb-vps/worker-credential.json
"$release/.venv/bin/python" -m ytb_vps_v2 worker-status --credential-path /var/lib/ytb-vps/worker-credential.json >/dev/null

chown -R ytb-vps:ytb-vps /var/lib/ytb-vps
chmod 700 /var/lib/ytb-vps
chmod 600 /var/lib/ytb-vps/worker-credential.json
install -m 0644 -o root -g root "$release/ops/native-v2/ytb-vps-worker.service" /etc/systemd/system/ytb-vps-worker.service
systemctl daemon-reload
systemctl enable --now ytb-vps-worker.service
ln -sfn "$release" /opt/ytb-vps/current
echo "native worker attached at commit $commit"
