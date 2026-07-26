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

# A brand-new VPS often still holds the dpkg lock (cloud-init/unattended-upgrades on first boot).
# curl + xz-utils are not guaranteed on minimal images; the pipeline needs the static FFmpeg 7.0
# build because Jammy's system FFmpeg 4.4 lacks the -fps_mode contract the renderer requires.
apt-get -o DPkg::Lock::Timeout=600 update
DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends ca-certificates curl xz-utils git python3.10 python3.10-venv

ffmpeg_root=/opt/ytb-vps/ffmpeg-static
ffmpeg_archive=/tmp/ffmpeg-7.0.2-amd64-static.tar.xz
ffmpeg_url=https://johnvansickle.com/ffmpeg/releases/ffmpeg-7.0.2-amd64-static.tar.xz
ffmpeg_sha256=abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67
if [[ ! -x "$ffmpeg_root/ffmpeg" ]]; then
  if ! echo "$ffmpeg_sha256  $ffmpeg_archive" | sha256sum -c - >/dev/null 2>&1; then
    curl -fL --retry 3 -o "$ffmpeg_archive" "$ffmpeg_url"
  fi
  echo "$ffmpeg_sha256  $ffmpeg_archive" | sha256sum -c -
  install -d -m 0755 "$ffmpeg_root"
  tar -xJf "$ffmpeg_archive" -C "$ffmpeg_root" --strip-components=1
fi
ln -sfn "$ffmpeg_root/ffmpeg" /usr/local/bin/ffmpeg-v2
ln -sfn "$ffmpeg_root/ffprobe" /usr/local/bin/ffprobe-v2

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
# mktemp -d creates the staging directory 0700, so the unprivileged ytb-vps
# service account cannot traverse into the release it is supposed to run:
# both the systemd unit and the s6 run script fail to exec the venv python.
chmod 0755 "$release"

python3.10 -m venv "$release/.venv"
# Jammy's ensurepip ships setuptools 59.6, which predates PEP 621 and would silently
# build this pyproject-only package as an empty UNKNOWN-0.0.0 dist under --no-build-isolation.
"$release/.venv/bin/pip" install --no-cache-dir --upgrade "pip>=24" "setuptools>=68" wheel
"$release/.venv/bin/pip" install --no-deps --no-build-isolation "$release"
# Edge TTS is a free outbound provider; it keeps audio synthesis off Vercel.
"$release/.venv/bin/pip" install --no-cache-dir edge-tts
"$release/.venv/bin/python" -m ytb_vps_v2 worker-enroll \
  --origin "$app_origin" \
  --token "$enrollment_token" \
  --credential-path /var/lib/ytb-vps/worker-credential.json
"$release/.venv/bin/python" -m ytb_vps_v2 worker-status --credential-path /var/lib/ytb-vps/worker-credential.json >/dev/null

chown -R ytb-vps:ytb-vps /var/lib/ytb-vps
chmod 700 /var/lib/ytb-vps
chmod 600 /var/lib/ytb-vps/worker-credential.json
# ExecStart resolves through /opt/ytb-vps/current, so the symlink must exist before the first start.
ln -sfn "$release" /opt/ytb-vps/current
install -d -m 0755 /opt/ytb-vps/bin
install -m 0755 -o root -g root "$release/ops/native-v2/worker-ctl.sh" /opt/ytb-vps/bin/ytb-vps-worker-ctl

# The inexpensive GPU templates this profile targets are frequently containers
# supervised by s6-overlay, where systemctl does not exist at all. Installing only
# the systemd unit there leaves an enrolled worker that never starts and never
# claims a job, so pick the init system that is actually running.
if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  install -m 0644 -o root -g root "$release/ops/native-v2/ytb-vps-worker.service" /etc/systemd/system/ytb-vps-worker.service
  systemctl daemon-reload
  systemctl enable --now ytb-vps-worker.service
  supervisor=systemd
elif [[ -x /command/s6-svscanctl && -d /run/service ]]; then
  # /etc/services.d survives a container restart; /run/s6/legacy-services is the
  # live copy s6-overlay actually supervises, and only new scandir entries start now.
  install -d -m 0755 /etc/services.d/ytb-vps-worker /run/s6/legacy-services/ytb-vps-worker
  for target in /etc/services.d/ytb-vps-worker /run/s6/legacy-services/ytb-vps-worker; do
    install -m 0755 -o root -g root "$release/ops/native-v2/ytb-vps-worker.s6-run" "$target/run"
    install -m 0755 -o root -g root "$release/ops/native-v2/ytb-vps-worker.s6-finish" "$target/finish"
  done
  ln -sfn /run/s6/legacy-services/ytb-vps-worker /run/service/ytb-vps-worker
  /opt/ytb-vps/bin/ytb-vps-worker-ctl start
  supervisor=s6
else
  echo "no supported service manager (systemd or s6-overlay) is available" >&2
  exit 78
fi
echo "native worker attached at commit $commit (supervisor: $supervisor)"
