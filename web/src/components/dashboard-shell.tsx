import type { JobSummary } from "@/lib/domain/control-plane";
import type { DriveConnectionView, FreeTierHealthView, PublicProject, WorkerViewModel } from "./dashboard-types";
import { DriveCard } from "./drive-card";
import { ProjectUpload } from "./project-upload";
import { WorkerCard } from "./worker-card";
import { JobList } from "./job-list";
import { SceneEditor } from "./scene-editor";

export function DashboardShell({
  workerOnline,
  jobs,
  drive,
  health,
  projects,
  workers,
}: {
  workerOnline: boolean;
  jobs: readonly JobSummary[];
  drive: DriveConnectionView;
  health: FreeTierHealthView;
  projects: readonly PublicProject[];
  workers: readonly WorkerViewModel[];
}) {
  const connected = workerOnline || workers.some((worker) => worker.state !== "REVOKED");
  return (
    <main className="dashboard">
      <header>
        <div>
          <p className="eyebrow">Control plane cá nhân</p>
          <h1>YTB VPS Studio</h1>
        </div>
      </header>
      <section className="status-card" aria-label="Trạng thái worker">
        <strong>{connected ? "GPU VPS đã kết nối" : "Chưa gắn GPU VPS"}</strong>
        <span>
          {connected ? "Worker đang giữ kênh HTTPS với control plane." : "Anh có thể tạo lệnh gắn VPS bất cứ lúc nào."}
        </span>
      </section>
      <div className="workspace-grid">
        <WorkerCard workers={workers} />
        <DriveCard value={drive} health={health} />
        <ProjectUpload health={health} projects={projects} />
      </div>
      <JobList jobs={jobs} projects={projects} />
      <SceneEditor projectId={projects.find((project) => project.sourceStatus === "SOURCE_READY")?.id ?? null} />
    </main>
  );
}
