"use client";

import Image from "next/image";
import { useMemo, useRef, useState, type SVGProps } from "react";
import type { JobSummary, JobState } from "@/lib/domain/control-plane";
import type { DriveConnectionView, FreeTierHealthView, PublicProject, UsageView, WorkerViewModel } from "./dashboard-types";
import { DriveWorkspace } from "./drive-workspace";
import { JobList } from "./job-list";
import { SceneEditor } from "./scene-editor";
import { WorkerCard } from "./worker-card";

type SurfaceId = "workspace" | "files" | "jobs" | "workers" | "settings";

const NAV_ICON = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  strokeWidth: 1.75,
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
} satisfies SVGProps<SVGSVGElement>;

function WorkspaceIcon() {
  return <svg {...NAV_ICON} aria-hidden><rect x="3" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" /></svg>;
}
function FilesIcon() {
  return <svg {...NAV_ICON} aria-hidden><path d="M3.5 7.5h6l2-2h5a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /></svg>;
}
function JobsIcon() {
  return <svg {...NAV_ICON} aria-hidden><path d="m8 6 9 6-9 6z" /></svg>;
}
function WorkersIcon() {
  return <svg {...NAV_ICON} aria-hidden><rect x="3.5" y="4" width="17" height="7" rx="1.5" /><rect x="3.5" y="13" width="17" height="7" rx="1.5" /><path d="M7 7.5h.01M7 16.5h.01" /></svg>;
}
function SettingsIcon() {
  return <svg {...NAV_ICON} aria-hidden><path d="M6 8h12M6 8a2 2 0 1 1-.01 0M6 8h.01M18 16H6m12 0a2 2 0 1 0 .01 0M18 16h-.01" /></svg>;
}

type ProjectReadiness = Readonly<{
  source: string;
  scene: string;
  worker: string;
  job: string;
  output: string;
}>;

const SURFACES: readonly Readonly<{ id: SurfaceId; label: string; Icon: () => React.ReactElement }>[] = [
  { id: "workspace", label: "Workspace", Icon: WorkspaceIcon },
  { id: "files", label: "Files", Icon: FilesIcon },
  { id: "jobs", label: "Jobs", Icon: JobsIcon },
  { id: "workers", label: "Workers", Icon: WorkersIcon },
  { id: "settings", label: "Settings", Icon: SettingsIcon },
];

const JOB_LABELS: Readonly<Record<JobState, string>> = {
  DRAFT: "Nháp",
  READY: "Sẵn sàng",
  QUEUED: "Đang chờ",
  CLAIMED: "Worker đã nhận",
  DOWNLOADING: "Tải nguồn",
  OCR: "OCR",
  TRANSLATE: "Dịch",
  REVIEW_READY: "Chờ review",
  PAUSED_REVIEW: "Tạm dừng review",
  TTS: "Tạo voice",
  RENDER: "Render",
  UPLOADING: "Tải output",
  COMPLETED: "Hoàn tất",
  PAUSED_QUOTA: "Tạm dừng quota",
  PAUSED_NO_WORKER: "Chờ worker",
  FAILED_RETRYABLE: "Lỗi có thể thử lại",
  FAILED_FINAL: "Lỗi cuối",
  CANCEL_REQUESTED: "Đang hủy",
  CANCELLED: "Đã hủy",
  DELETING: "Đang xóa",
  DELETED: "Đã xóa",
};

const STORAGE_FORMAT = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });

function projectSourceLabel(status: PublicProject["sourceStatus"]): string {
  if (status === "SOURCE_READY") return "Nguồn sẵn sàng";
  if (status === "UPLOAD_PENDING") return "Đang tải nguồn";
  if (status === "UPLOAD_FAILED") return "Tải nguồn lỗi";
  return "Chưa có nguồn";
}

function latestJobForProject(jobs: readonly JobSummary[], project: PublicProject | null): JobSummary | null {
  if (project === null) return null;
  return jobs.find((job) => job.projectName === project.name) ?? null;
}

function settingReadiness(project: PublicProject | null, job: JobSummary | null): string {
  if (project === null) return "Chưa có video";
  if (project.sourceStatus !== "SOURCE_READY") return "Chờ nguồn";
  if (job?.settingsSnapshot != null || (job !== null && !["DRAFT", "READY"].includes(job.state))) {
    return "Đã xác nhận";
  }
  return "Cần thiết lập";
}

function jobProgressLabel(job: JobSummary | null): string {
  if (job === null) return "Chưa có job";
  if (!Number.isFinite(job.progressPercent)) return JOB_LABELS[job.state];
  const progress = Math.min(100, Math.max(0, Math.round(job.progressPercent)));
  return `${JOB_LABELS[job.state]} · ${progress}%`;
}

function jobEtaLabel(job: JobSummary | null): string {
  if (job === null) return "Chưa có job";
  if (job.state === "COMPLETED") return "Output sẵn sàng";
  if (job.etaSeconds == null || !Number.isFinite(job.etaSeconds) || job.etaSeconds < 0) {
    return "Chưa có ETA";
  }
  if (job.etaSeconds < 60) return "Còn dưới 1 phút";
  const minutes = Math.ceil(job.etaSeconds / 60);
  if (minutes < 60) return `Còn khoảng ${minutes} phút`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `Còn khoảng ${hours} giờ${remainingMinutes > 0 ? ` ${remainingMinutes} phút` : ""}`;
}

function activeJobs(jobs: readonly JobSummary[]): readonly JobSummary[] {
  return jobs.filter((job) => !["COMPLETED", "FAILED_FINAL", "CANCELLED", "DELETED"].includes(job.state));
}

function storagePercent(snapshot: UsageView | null): number | null {
  if (snapshot === null || snapshot.limitBytes <= 0) return null;
  return Math.min(100, Math.max(0, Math.round(snapshot.usedBytes * 100 / snapshot.limitBytes)));
}

function storageLabel(snapshot: UsageView | null): string {
  if (snapshot === null || snapshot.limitBytes <= 0) return "Chưa xác minh";
  const used = STORAGE_FORMAT.format(snapshot.usedBytes / 1_073_741_824);
  const limit = STORAGE_FORMAT.format(snapshot.limitBytes / 1_073_741_824);
  return `${used} / ${limit} GB`;
}

function workerReady(workers: readonly WorkerViewModel[], workerOnline: boolean): boolean {
  return workerOnline || workers.some((worker) => worker.state === "READY");
}

function workerConnected(workers: readonly WorkerViewModel[], workerOnline: boolean): boolean {
  return workerOnline || workers.some((worker) => worker.state !== "REVOKED");
}

function readinessFor(project: PublicProject | null, job: JobSummary | null, hasReadyWorker: boolean): ProjectReadiness {
  if (project === null) {
    return {
      source: "Chưa có dự án",
      scene: "Chưa có dự án",
      worker: hasReadyWorker ? "Worker sẵn sàng" : "Chưa có worker",
      job: "Chưa có job",
      output: "Chưa có output",
    };
  }

  const sourceReady = project.sourceStatus === "SOURCE_READY";
  const completed = job?.state === "COMPLETED";

  return {
    source: projectSourceLabel(project.sourceStatus),
    scene: settingReadiness(project, job),
    worker: hasReadyWorker ? "Worker sẵn sàng" : "Chưa có worker",
    job: job === null ? (sourceReady && hasReadyWorker ? "Chờ xác nhận render" : "Chờ điều kiện") : jobProgressLabel(job),
    output: completed ? "Output sẵn sàng" : "Chưa có output",
  };
}

function StatusChip({ label, value, tone }: Readonly<{ label: string; value: string; tone: "good" | "warn" | "danger" | "neutral" }>) {
  return (
    <span className={`status-chip status-chip-${tone}`} title={`${label}: ${value}`} aria-label={`${label}: ${value}`}>
      <span className="chip-dot" aria-hidden />
      <strong>{label}</strong>
    </span>
  );
}

function ReadinessCard({ label, value, tone }: Readonly<{ label: string; value: string; tone: "good" | "warn" | "danger" | "neutral" }>) {
  return (
    <div className={`readiness-card readiness-${tone}`}>
      <span>{label}</span>
      <strong><i className="rc-dot" aria-hidden />{value}</strong>
    </div>
  );
}

function SettingMeter({ title, usage }: Readonly<{ title: string; usage: UsageView | null }>) {
  const percent = storagePercent(usage);
  return (
    <div className="setting-meter">
      <div>
        <strong>{title}</strong>
        <span>{storageLabel(usage)}</span>
      </div>
      <div className="meter-track" aria-hidden>
        <span style={{ width: `${percent ?? 0}%` }} />
      </div>
      <p>{percent === null ? "Chưa có snapshot dung lượng." : `${percent}% đã dùng, cập nhật ${usage?.observedAt ?? "chưa rõ"}.`}</p>
    </div>
  );
}

function SurfaceShell({ children }: Readonly<{ children: React.ReactNode }>) {
  return <section className="surface-panel">{children}</section>;
}

export function DashboardShell({ workerOnline, jobs, drive, health, projects, workers }: {
  workerOnline: boolean;
  jobs: readonly JobSummary[];
  drive: DriveConnectionView;
  health: FreeTierHealthView;
  projects: readonly PublicProject[];
  workers: readonly WorkerViewModel[];
}) {
  const [surface, setSurface] = useState<SurfaceId>("workspace");
  const [videoItems, setVideoItems] = useState<readonly PublicProject[]>(projects);
  const [sourceFiles, setSourceFiles] = useState<Readonly<Record<string, File>>>({});
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(projects[0]?.id ?? null);
  const [logoutMessage, setLogoutMessage] = useState<string | null>(null);
  const sceneSetupRef = useRef<HTMLElement>(null);

  // Derive selection so a removed/stale id transparently falls back to the first project.
  const selectedProject = videoItems.find((project) => project.id === selectedProjectId) ?? videoItems[0] ?? null;
  const selectedJob = latestJobForProject(jobs, selectedProject);
  const hasReadyWorker = workerReady(workers, workerOnline);
  const hasConnectedWorker = workerConnected(workers, workerOnline);
  const activeJobCount = activeJobs(jobs).length;
  const readiness = readinessFor(selectedProject, selectedJob, hasReadyWorker);
  const sourceReady = videoItems.some((project) => project.sourceStatus === "SOURCE_READY");
  const driveReady = drive.status === "CONNECTED" && drive.rootReady;
  const selectedSourceFile = selectedProject === null ? null : sourceFiles[selectedProject.id] ?? null;
  const currentSurface = useMemo(() => SURFACES.find((item) => item.id === surface) ?? SURFACES[0]!, [surface]);
  const selectedSourceReady = selectedProject?.sourceStatus === "SOURCE_READY";
  const setupHelp = selectedProject === null
    ? "Thêm video nguồn để tạo dự án và mở thiết lập."
    : !selectedSourceReady
      ? "Hoàn tất video nguồn trước khi thiết lập và xem trước."
      : !hasReadyWorker
        ? "Có thể thiết lập ngay; cần setup VPS trước khi xác nhận render."
        : selectedJob === null
          ? "Xem trước, lưu thiết lập rồi xác nhận render."
          : "Job đã tạo; theo dõi tiến độ trong Jobs.";

  // Track the cursor as a CSS variable so the ambient glow follows it without re-rendering.
  function trackPointer(event: React.PointerEvent<HTMLElement>): void {
    const style = event.currentTarget.style;
    style.setProperty("--mx", `${event.clientX}px`);
    style.setProperty("--my", `${event.clientY}px`);
  }

  function handleSourceFile(projectId: string, file: File): void {
    setSourceFiles((current) => ({ ...current, [projectId]: file }));
    setSelectedProjectId(projectId);
    setSurface("workspace");
  }

  function openSetup(): void {
    if (!selectedSourceReady) {
      setSurface("files");
      return;
    }
    sceneSetupRef.current?.focus();
  }

  async function logout(): Promise<void> {
    setLogoutMessage(null);
    const response = await fetch("/api/v1/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { origin: window.location.origin },
    });
    if (!response.ok) {
      setLogoutMessage("Chưa đăng xuất được. Hãy thử lại.");
      return;
    }
    window.location.reload();
  }

  return (
    <main className="zeus-shell" onPointerMove={trackPointer}>
      <aside className="app-sidebar" aria-label="Zeus MMO">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden><Image alt="" height={42} priority src="/logo.svg" width={42} /></span>
          <div>
            <strong>Zeus MMO</strong>
            <span>AIO Tool</span>
          </div>
        </div>

        <nav aria-label="Điều hướng Zeus MMO" className="side-nav">
          {SURFACES.map((item) => (
            <button
              aria-current={surface === item.id ? "page" : undefined}
              className={surface === item.id ? "side-nav-item active" : "side-nav-item"}
              key={item.id}
              onClick={() => setSurface(item.id)}
              type="button"
            >
              <item.Icon />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span>{videoItems.length} dự án</span>
          <span>{jobs.length} job</span>
        </div>
      </aside>

      <section className="app-main">
        <header className="command-bar">
          <div>
            <p className="micro-label">Enjoy ur day ;)</p>
            <h1>{currentSurface.label}</h1>
          </div>
          <div className="status-strip" aria-label="Trạng thái hệ thống">
            <StatusChip label="Drive" value={driveReady ? "Sẵn sàng" : drive.status === "REAUTH_REQUIRED" ? "Cần cấp quyền lại" : "Chưa kết nối"} tone={driveReady ? "good" : "warn"} />
            <StatusChip label="Worker" value={hasConnectedWorker ? `Đã gắn ${workers.length || 1} máy` : "Chưa gắn"} tone={hasConnectedWorker ? "good" : "warn"} />
            <StatusChip label="Storage" value={health.mode === "READ_WRITE" ? "An toàn, cho phép ghi" : "Chỉ đọc"} tone={health.mode === "READ_WRITE" ? "good" : "danger"} />
            <StatusChip label="Jobs" value={activeJobCount > 0 ? `${activeJobCount} đang chạy` : "Rảnh"} tone={activeJobCount > 0 ? "good" : "neutral"} />
          </div>
        </header>

        <div hidden={surface !== "workspace"}>
          <SurfaceShell>
            <div className="workspace-hero">
              <div>
                <p className="micro-label">Daily run</p>
                <h2>Run your daily jobs</h2>
                <p>Mỗi video tạo đúng một job render.</p>
              </div>
              <div className="hero-actions">
                <button type="button" onClick={() => setSurface("files")}>Thêm video</button>
                <button
                  className="button-secondary"
                  type="button"
                  onClick={() => {
                    if (selectedJob !== null) setSurface("jobs");
                    else if (!hasReadyWorker) setSurface("workers");
                    else openSetup();
                  }}
                >
                  {selectedJob !== null
                    ? "Theo dõi job"
                    : !hasReadyWorker
                      ? "Setup VPS"
                      : selectedSourceReady
                        ? "Tiếp tục thiết lập"
                        : "Thêm video nguồn"}
                </button>
              </div>
            </div>

            <section className="readiness-grid" aria-label="Tóm tắt sẵn sàng">
              <ReadinessCard label="Nguồn" value={sourceReady ? `${videoItems.filter((project) => project.sourceStatus === "SOURCE_READY").length} sẵn sàng` : "Chưa có"} tone={sourceReady ? "good" : "neutral"} />
              <ReadinessCard label="Thiết lập" value={readiness.scene} tone={readiness.scene === "Đã xác nhận" ? "good" : "warn"} />
              <ReadinessCard label="VPS" value={hasReadyWorker ? "Sẵn sàng" : hasConnectedWorker ? "Đang kiểm tra" : "Chưa gắn"} tone={hasReadyWorker ? "good" : "warn"} />
              <ReadinessCard label="Job" value={selectedJob === null ? "Chưa tạo" : jobProgressLabel(selectedJob)} tone={selectedJob === null ? "neutral" : "good"} />
            </section>

            <div className="workspace-layout">
              <section className="project-board" aria-label="Dự án">
                <div className="section-heading">
                  <div>
                    <h2>Dự án</h2>
                  </div>
                  <button className="button-secondary" type="button" onClick={() => setSurface("files")}>Mở Files</button>
                </div>

                {videoItems.length === 0 ? (
                  <div className="empty-state">
                    <strong>Chưa có dự án.</strong>
                    <p>Thêm video trong Files để Zeus MMO tạo dự án từ tên file.</p>
                    <button type="button" onClick={() => setSurface("files")}>Thêm video đầu tiên</button>
                  </div>
                ) : (
                  <div className="project-table" aria-label="Danh sách dự án">
                    <div className="project-table-head" role="presentation">
                      <span>Video</span>
                      <span>Thiết lập</span>
                      <span>Job</span>
                      <span>ETA / Output</span>
                    </div>
                    {videoItems.map((project) => {
                      const job = latestJobForProject(jobs, project);
                      return (
                        <button
                          aria-pressed={selectedProject?.id === project.id}
                          className={selectedProject?.id === project.id ? "project-row active" : "project-row"}
                          key={project.id}
                          onClick={() => {
                            setSelectedProjectId(project.id);
                            setSurface("workspace");
                          }}
                          type="button"
                        >
                          <span>
                            <strong>{project.name}</strong>
                            <small>{projectSourceLabel(project.sourceStatus)}</small>
                          </span>
                          <span>{settingReadiness(project, job)}</span>
                          <span>{jobProgressLabel(job)}</span>
                          <span>{jobEtaLabel(job)}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>

              <aside className="project-inspector" aria-label="Project inspector">
                <div className="section-heading compact">
                  <div>
                    <h2>{selectedProject?.name ?? "Chưa chọn dự án"}</h2>
                    <p>{selectedProject === null ? "Thêm video để bắt đầu." : "1 video • 1 thiết lập • 1 job"}</p>
                  </div>
                </div>
                <div className="inspector-stack">
                  <div><span>Source</span><strong>{readiness.source}</strong></div>
                  <div><span>Scene</span><strong>{readiness.scene}</strong></div>
                  <div><span>Worker</span><strong>{readiness.worker}</strong></div>
                  <div><span>Job</span><strong>{readiness.job}</strong></div>
                  <div><span>Output</span><strong>{readiness.output}</strong></div>
                </div>
                <div className="inspector-actions">
                  <button aria-describedby="setup-help" type="button" onClick={openSetup}>
                    {selectedSourceReady ? "Thiết lập & xem trước" : selectedProject === null ? "Thêm video đầu tiên" : "Thêm video nguồn"}
                  </button>
                  {!hasReadyWorker ? (
                    <button className="button-secondary" type="button" onClick={() => setSurface("workers")}>Setup VPS để render</button>
                  ) : selectedJob !== null ? (
                    <button className="button-secondary" type="button" onClick={() => setSurface("jobs")}>Theo dõi job</button>
                  ) : (
                    <button className="button-secondary" disabled={selectedProject === null} type="button" onClick={() => setSurface("files")}>Xem file</button>
                  )}
                </div>
                <p className="helper-inline" id="setup-help">{setupHelp}</p>
              </aside>
            </div>

            <section
              className="scene-workbench"
              aria-label="Review scene và voice"
              ref={sceneSetupRef}
              tabIndex={-1}
            >
              {selectedProject?.sourceStatus === "SOURCE_READY" ? (
                <SceneEditor
                  projectId={selectedProject.id}
                  projectName={selectedProject.name}
                  quotaMode={health.mode}
                  sourceFile={selectedSourceFile}
                  sourceReady
                  workerReady={hasReadyWorker}
                />
              ) : (
                <div className="empty-state">
                  <strong>Scene chờ video nguồn.</strong>
                  <p>Upload hoặc chọn một dự án đã có nguồn để cấu hình blur và voice.</p>
                  <button className="button-secondary" type="button" onClick={() => setSurface("files")}>Mở Files</button>
                </div>
              )}
            </section>
          </SurfaceShell>
        </div>

        {surface === "files" && (
          <SurfaceShell>
            <DriveWorkspace
              drive={drive}
              health={health}
              onProjectsChange={setVideoItems}
              onSourceFile={handleSourceFile}
              projects={videoItems}
            />
          </SurfaceShell>
        )}

        {surface === "jobs" && (
          <SurfaceShell>
            <JobList jobs={jobs} projects={videoItems} />
          </SurfaceShell>
        )}

        {surface === "workers" && (
          <SurfaceShell>
            <WorkerCard workers={workers} />
          </SurfaceShell>
        )}

        {surface === "settings" && (
          <SurfaceShell>
            <section className="settings-grid" aria-label="Settings">
              <section className="settings-card" aria-label="Connections">
                <h2>Connections</h2>
                <div className="settings-row"><span>Google Drive</span><strong>{drive.accountHint ?? (drive.status === "CONNECTED" ? "Đã kết nối" : "Chưa kết nối")}</strong></div>
                <div className="settings-row"><span>Drive root</span><strong>{drive.rootReady ? "Đã xác minh" : "Chưa sẵn sàng"}</strong></div>
                <div className="settings-row"><span>Local VPS Connector</span><strong>127.0.0.1:55871</strong></div>
                <button className="button-secondary" type="button" onClick={() => setSurface("files")}>Quản lý Drive</button>
              </section>
              <section className="settings-card" aria-label="Storage">
                <h2>Storage</h2>
                <SettingMeter title="Google Drive" usage={health.drive} />
                <SettingMeter title="Neon" usage={health.neon} />
                {health.reasons.length > 0 && <p className="warning-copy">{health.reasons.join(", ")}</p>}
              </section>
              <section className="settings-card" aria-label="Scene và voice">
                <h2>Scene và voice</h2>
                <div className="settings-row"><span>Voice</span><strong>BV074_streaming</strong></div>
                <div className="settings-row"><span>Rate</span><strong>0.80x đến 1.20x</strong></div>
                <p>Cấu hình chi tiết nằm trong Project inspector.</p>
              </section>
              <section className="settings-card" aria-label="Security">
                <h2>Security</h2>
                <p>Phiên admin giữ bằng cookie HTTP-only.</p>
                <button className="button-danger" type="button" onClick={() => { void logout(); }}>Đăng xuất</button>
                {logoutMessage !== null && <p role="alert">{logoutMessage}</p>}
              </section>
            </section>
          </SurfaceShell>
        )}
      </section>
    </main>
  );
}
