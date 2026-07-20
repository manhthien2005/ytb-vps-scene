import type { JobSummary } from "@/lib/domain/control-plane";
import type { DriveConnectionView, FreeTierHealthView, PublicProject } from "./dashboard-types";
import { DriveCard } from "./drive-card";
import { ProjectUpload } from "./project-upload";

export function DashboardShell({
  workerOnline,
  jobs,
  drive,
  health,
  projects,
}: {
  workerOnline: boolean;
  jobs: readonly JobSummary[];
  drive: DriveConnectionView;
  health: FreeTierHealthView;
  projects: readonly PublicProject[];
}) {
  return (
    <main className="dashboard">
      <header>
        <div>
          <p className="eyebrow">Control plane cá nhân</p>
          <h1>YTB VPS Studio</h1>
        </div>
        <div className="attach-control">
          <button type="button" disabled aria-describedby="vps-availability-note">
            Gắn VPS
          </button>
          <p id="vps-availability-note">Tính năng gắn VPS sẽ khả dụng ở giai đoạn sau.</p>
        </div>
      </header>
      <section className="status-card" aria-label="Trạng thái worker">
        <strong>{workerOnline ? "GPU VPS đang sẵn sàng" : "Chưa gắn GPU VPS"}</strong>
        <span>
          {workerOnline ? "Có thể nhận job" : "Anh vẫn có thể chuẩn bị và xếp hàng dự án."}
        </span>
      </section>
      <div className="workspace-grid">
        <DriveCard value={drive} health={health} />
        <ProjectUpload health={health} projects={projects} />
      </div>
      <section className="recent-jobs">
        <h2>Dự án gần đây</h2>
        {jobs.length === 0 ? (
          <p>Chưa có dự án.</p>
        ) : (
          <ul>
            {jobs.map((job) => (
              <li key={job.id}>
                <strong>{job.projectName}</strong>
                <span>
                  {job.state} · {job.progressPercent}%
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
