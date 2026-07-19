import type { JobSummary } from "@/lib/domain/control-plane";

export function DashboardShell({
  workerOnline,
  jobs,
}: {
  workerOnline: boolean;
  jobs: readonly JobSummary[];
}) {
  return (
    <main className="dashboard">
      <header>
        <div>
          <p className="eyebrow">Control plane cá nhân</p>
          <h1>YTB VPS Studio</h1>
        </div>
        <button>Gắn VPS</button>
      </header>
      <section className="status-card" aria-label="Trạng thái worker">
        <strong>{workerOnline ? "GPU VPS đang sẵn sàng" : "Chưa gắn GPU VPS"}</strong>
        <span>
          {workerOnline ? "Có thể nhận job" : "Anh vẫn có thể chuẩn bị và xếp hàng dự án."}
        </span>
      </section>
      <section>
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
