#!/usr/bin/env bash
# One control surface for the native worker across both supported init systems.
# Installed by bootstrap-worker.sh as /opt/ytb-vps/bin/ytb-vps-worker-ctl so that
# callers (the Local VPS Connector, operators) never have to know whether the host
# runs systemd or s6-overlay.
set -euo pipefail

action=${1:-status}
service=/run/service/ytb-vps-worker

if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  case "$action" in
    start) systemctl enable --now ytb-vps-worker.service ;;
    restart) systemctl restart ytb-vps-worker.service ;;
    stop) systemctl stop ytb-vps-worker.service ;;
    status) systemctl is-active ytb-vps-worker.service ;;
    *) echo "usage: ytb-vps-worker-ctl {start|restart|stop|status}" >&2; exit 64 ;;
  esac
  exit 0
fi

if [[ -x /command/s6-svc ]]; then
  case "$action" in
    start)
      /command/s6-svscanctl -a /run/service
      # The scan is asynchronous: s6-supervise has to exist before -wU can wait on it.
      for _ in $(seq 1 50); do
        [[ -S "$service/supervise/control" ]] && break
        sleep 0.2
      done
      /command/s6-svc -wU -T 30000 -u "$service"
      ;;
    restart)
      /command/s6-svc -wD -T 30000 -d "$service"
      /command/s6-svc -wU -T 30000 -u "$service"
      ;;
    stop) /command/s6-svc -wD -T 30000 -d "$service" ;;
    status) /command/s6-svstat "$service" ;;
    *) echo "usage: ytb-vps-worker-ctl {start|restart|stop|status}" >&2; exit 64 ;;
  esac
  exit 0
fi

echo "no supported service manager (systemd or s6-overlay) is available" >&2
exit 78
