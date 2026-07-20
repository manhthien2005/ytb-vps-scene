"use client";

import { useState } from "react";
import type { JobSummary } from "@/lib/domain/control-plane";
import type { DriveConnectionView, FreeTierHealthView, PublicProject, WorkerViewModel } from "./dashboard-types";
import { DriveCard } from "./drive-card";
import { ProjectUpload } from "./project-upload";
import { WorkerCard } from "./worker-card";
import { JobList } from "./job-list";
import { SceneEditor } from "./scene-editor";

export function DashboardShell({ workerOnline, jobs, drive, health, projects, workers }: {
  workerOnline: boolean;
  jobs: readonly JobSummary[];
  drive: DriveConnectionView;
  health: FreeTierHealthView;
  projects: readonly PublicProject[];
  workers: readonly WorkerViewModel[];
}) {
  const [videoItems, setVideoItems] = useState<readonly PublicProject[]>(projects);
  const connected = workerOnline || workers.some((worker) => worker.state !== "REVOKED");
  const sourceReady = videoItems.some((project) => project.sourceStatus === "SOURCE_READY");
  const vpsReady = workerOnline || workers.some((worker) => worker.state === "READY");
  const outputReady = jobs.some((job) => job.state === "COMPLETED");
  const [activeStep, setActiveStep] = useState<"drive" | "vps" | "review" | "render">("drive");
  const steps = [
    { id: "drive" as const, label: "1. Drive", done: sourceReady, disabled: false },
    { id: "vps" as const, label: "2. VPS", done: vpsReady, disabled: false },
    { id: "review" as const, label: "3. Review", done: sourceReady, disabled: !sourceReady },
    { id: "render" as const, label: "4. Render", done: outputReady, disabled: !sourceReady || !vpsReady },
  ];
  const sourceProject = videoItems.find((project) => project.sourceStatus === "SOURCE_READY");

  return (
    <main className="dashboard">
      <header><div><p className="eyebrow">Control plane cá nhân</p><h1>YTB VPS Studio</h1></div></header>
      <section className="status-card" aria-label="Trạng thái worker">
        <strong>{connected ? "GPU VPS đã kết nối" : "Chưa gắn GPU VPS"}</strong>
        <span>{connected ? "Worker đang giữ kênh HTTPS với control plane." : "Anh có thể tạo lệnh gắn VPS bất cứ lúc nào."}</span>
      </section>
      <nav className="workflow-stepper" aria-label="Quy trình render">
        {steps.map((step) => <button key={step.id} type="button" className={activeStep === step.id ? "workflow-step active" : "workflow-step"} aria-current={activeStep === step.id ? "step" : undefined} disabled={step.disabled} onClick={() => setActiveStep(step.id)}><span>{step.label}</span><small>{step.done ? "Sẵn sàng" : step.disabled ? "Chờ bước trước" : "Đang chờ"}</small></button>)}
      </nav>
      <section className="workflow-summary" aria-label="Tóm tắt sẵn sàng">
        <span>Nguồn: {sourceReady ? "Sẵn sàng" : "Chưa có"}</span><span>VPS: {vpsReady ? "Sẵn sàng" : "Chưa gắn"}</span><span>Output: {outputReady ? "Đã có file" : "Chưa render"}</span>
      </section>
      <div className="workflow-panels">
        <section className={`workflow-panel ${activeStep === "drive" ? "workflow-panel-active" : ""}`} aria-labelledby="workflow-drive-title">
          <div className="workflow-panel-heading"><p className="eyebrow">Bước 1</p><h2 id="workflow-drive-title">Drive · Nguồn và thư mục output</h2></div>
          <div className="workspace-grid"><DriveCard value={drive} health={health} /><ProjectUpload health={health} projects={videoItems} onProjectsChange={setVideoItems} /></div>
        </section>
        <section className={`workflow-panel ${activeStep === "vps" ? "workflow-panel-active" : ""}`} aria-labelledby="workflow-vps-title">
          <div className="workflow-panel-heading"><p className="eyebrow">Bước 2</p><h2 id="workflow-vps-title">VPS · Setup và kiểm tra GPU</h2></div><WorkerCard workers={workers} />
        </section>
        <section className={`workflow-panel ${activeStep === "review" ? "workflow-panel-active" : ""}`} aria-labelledby="workflow-review-title">
          <div className="workflow-panel-heading"><p className="eyebrow">Bước 3</p><h2 id="workflow-review-title">Review · Blur hình chữ nhật và voice TTS</h2></div><SceneEditor projectId={sourceProject?.id ?? null} />
        </section>
        <section className={`workflow-panel ${activeStep === "render" ? "workflow-panel-active" : ""}`} aria-labelledby="workflow-render-title">
          <div className="workflow-panel-heading"><p className="eyebrow">Bước 4</p><h2 id="workflow-render-title">Render · Theo dõi output</h2></div><JobList jobs={jobs} projects={videoItems} />
        </section>
      </div>
    </main>
  );
}
