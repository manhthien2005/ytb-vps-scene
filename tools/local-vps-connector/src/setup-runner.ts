import type { SshTarget } from "./ssh-command.js";

export type SetupStage = "CONNECTING" | "INSTALLING" | "CONFIGURING" | "VERIFYING" | "READY" | "FAILED";
export type SetupEvent = Readonly<{ stage: SetupStage; percent: number; message: string }>;
export type SetupSession = Readonly<{ exec(command: string): Promise<{ stdout: string; stderr: string; code: number }>; close(): void }>;
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
