"use client";

import { useState } from "react";
import type { JobSummary } from "@/lib/domain/control-plane";
import type { PublicProject } from "./dashboard-types";

export function JobList({ jobs, projects, fetcher = fetch }: { jobs: readonly JobSummary[]; projects: readonly PublicProject[]; fetcher?: typeof fetch }) {
  const [message, setMessage] = useState<string | null>(null);
  const [queueingProjectIds, setQueueingProjectIds] = useState<ReadonlySet<string>>(() => new Set());
  async function queue(projectId: string) {
    if (queueingProjectIds.has(projectId)) return;
    setQueueingProjectIds((current) => new Set(current).add(projectId));
    try {
      const response = await fetcher(`/api/v1/projects/${projectId}/jobs`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID(), origin: window.location.origin } });
      setMessage(response.ok ? "Đã xếp job vào hàng đợi." : "Dự án chưa sẵn sàng để xếp job.");
    } catch {
      setMessage("Chưa thể xếp job. Vui lòng thử lại.");
    } finally {
      setQueueingProjectIds((current) => {
        const next = new Set(current);
        next.delete(projectId);
        return next;
      });
    }
  }
  return (
    <section className="recent-jobs" aria-label="Dự án gần đây">
      <h2>Dự án gần đây</h2>
      {message !== null && <p aria-live="polite">{message}</p>}
      {jobs.length === 0 ? <p>Chưa có dự án.</p> : <ul>{jobs.map((job) => <li key={job.id}><strong>{job.projectName}</strong><span>{job.state} · {job.progressPercent}%</span></li>)}</ul>}
      <div className="queue-list">
        {projects.filter((project) => project.sourceStatus === "SOURCE_READY").map((project) => (
          <button key={project.id} type="button" className="button-secondary" disabled={queueingProjectIds.has(project.id)} onClick={() => queue(project.id)}>Xếp “{project.name}”</button>
        ))}
      </div>
    </section>
  );
}
