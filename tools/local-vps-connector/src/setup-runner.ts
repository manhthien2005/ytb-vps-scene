import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { SshTarget } from "./ssh-command.js";

export type SetupStage = "CONNECTING" | "INSTALLING" | "CONFIGURING" | "VERIFYING" | "READY" | "FAILED";
export type SetupEvent = Readonly<{ stage: SetupStage; percent: number; message: string }>;
export type SetupSession = Readonly<{
  exec(command: string): Promise<{ stdout: string; stderr: string; code: number }>;
  upload(localPath: string, remotePath: string): Promise<void>;
  close(): void;
}>;
export type SetupTransport = Readonly<{ connect(target: SshTarget, password: string): Promise<SetupSession> }>;
export type SetupInput = Readonly<{ ssh: SshTarget; password: string; bootstrapCommand: string; transport: SetupTransport }>;

const stages: ReadonlyArray<Readonly<{ stage: Exclude<SetupStage, "FAILED" | "READY">; percent: number; command?: string }>> = [
  { stage: "CONNECTING", percent: 10 },
  { stage: "INSTALLING", percent: 35, command: "apt-get -o DPkg::Lock::Timeout=600 update -y && DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends ca-certificates git ffmpeg python3.10 python3.10-venv" },
  { stage: "CONFIGURING", percent: 65 },
  { stage: "VERIFYING", percent: 90, command: "nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader" },
];

function safeBootstrapCommand(value: string): string {
  if (!/^curl\s+-fsSL\s+https:\/\/raw\.githubusercontent\.com\/[^\s]+\s+\|\s+sudo\s+bash\s+-s\s+--\s+[^\n]+$/.test(value)) {
    throw new Error("Bootstrap command is invalid");
  }
  return value;
}

function capcutDeviceFiles(root = process.env.YTB_VPS_LOCAL_CAPCUT_DEVICES): ReadonlyArray<Readonly<{ source: string; name: string }>> {
  if (!root?.trim()) return [];
  if (!existsSync(root)) throw new Error("Configured CapCut device pool is missing");
  const files = readdirSync(root).filter((name) => /^device-\d+\.json$/.test(name)).sort();
  if (files.length === 0) throw new Error("Configured CapCut device pool is empty");
  return files.map((name) => {
    const source = join(root, name);
    const value = JSON.parse(readFileSync(source, "utf8")) as Record<string, unknown>;
    for (const key of ["device_id", "iid", "tdid"] as const) {
      if (typeof value[key] !== "string" || value[key].length === 0) throw new Error("CapCut device credential is invalid");
    }
    return { source, name: basename(name) };
  });
}

const PREPARE_CAPCUT_POOL = "set -euo pipefail\ninstall -d -o ytb-vps -g ytb-vps -m 0700 /var/lib/ytb-vps/secrets\nrm -rf /var/lib/ytb-vps/secrets/capcut-devices.next\ninstall -d -o ytb-vps -g ytb-vps -m 0700 /var/lib/ytb-vps/secrets/capcut-devices.next";

function activateCapcutPool(first: string): string {
  return `set -euo pipefail
python3 - <<'YTB_VALIDATE_CAPCUT'
import glob, json
paths = glob.glob('/var/lib/ytb-vps/secrets/capcut-devices.next/device-*.json')
assert paths
for path in paths:
    with open(path, encoding='utf-8-sig') as stream:
        value = json.load(stream)
    assert all(isinstance(value.get(key), str) and value[key] for key in ('device_id', 'iid', 'tdid'))
YTB_VALIDATE_CAPCUT
chown -R ytb-vps:ytb-vps /var/lib/ytb-vps/secrets/capcut-devices.next
chmod 700 /var/lib/ytb-vps/secrets/capcut-devices.next
chmod 600 /var/lib/ytb-vps/secrets/capcut-devices.next/*.json
rm -rf /var/lib/ytb-vps/secrets/capcut-devices.previous
if [ -e /var/lib/ytb-vps/secrets/capcut-devices ]; then mv /var/lib/ytb-vps/secrets/capcut-devices /var/lib/ytb-vps/secrets/capcut-devices.previous; fi
mv /var/lib/ytb-vps/secrets/capcut-devices.next /var/lib/ytb-vps/secrets/capcut-devices
cp /var/lib/ytb-vps/secrets/capcut-devices/${first} /var/lib/ytb-vps/secrets/capcut-device.json
chown ytb-vps:ytb-vps /var/lib/ytb-vps/secrets/capcut-device.json
chmod 600 /var/lib/ytb-vps/secrets/capcut-device.json
rm -rf /var/lib/ytb-vps/secrets/capcut-devices.previous
systemctl restart ytb-vps-worker.service`;
}

export async function* runSetup(input: SetupInput): AsyncIterable<SetupEvent> {
  let session: SetupSession | null = null;
  try {
    const bootstrapCommand = safeBootstrapCommand(input.bootstrapCommand);
    for (const item of stages) {
      yield { stage: item.stage, percent: item.percent, message: item.stage === "CONNECTING" ? "Đang kết nối VPS…" : item.stage === "INSTALLING" ? "Đang cài thành phần render…" : item.stage === "CONFIGURING" ? "Đang cấu hình worker…" : "Đang kiểm tra GPU và FFmpeg…" };
      if (item.stage === "CONNECTING") session = await input.transport.connect(input.ssh, input.password);
      if (item.stage === "CONFIGURING") {
        const result = await session!.exec(bootstrapCommand);
        if (result.code !== 0) throw new Error("bootstrap failed");
        const devices = capcutDeviceFiles();
        if (devices.length > 0) {
          const prepared = await session!.exec(PREPARE_CAPCUT_POOL);
          if (prepared.code !== 0) throw new Error("CapCut device staging failed");
          for (const device of devices) {
            await session!.upload(device.source, `/var/lib/ytb-vps/secrets/capcut-devices.next/${device.name}`);
          }
          const activated = await session!.exec(activateCapcutPool(devices[0]!.name));
          if (activated.code !== 0) throw new Error("CapCut device activation failed");
        }
      } else if (item.command) {
        const result = await session!.exec(item.command);
        if (result.code !== 0) throw new Error(`${item.stage.toLowerCase()} failed`);
      }
    }
    yield { stage: "READY", percent: 100, message: "VPS đã sẵn sàng để render." };
  } catch {
    yield { stage: "FAILED", percent: 100, message: "Không hoàn tất được setup VPS. Kiểm tra SSH, mật khẩu và trạng thái máy." };
  } finally {
    session?.close();
  }
}
