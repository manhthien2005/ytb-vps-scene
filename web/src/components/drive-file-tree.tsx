"use client";

import { useState, type ReactNode } from "react";
import type { DriveWorkspaceView } from "./dashboard-types";
import { DriveFileRow } from "./drive-file-row";
import { ChevronIcon, FolderIcon } from "./drive-icons";

export type DriveFileTreeProps = Readonly<{
  kind: "input" | "output";
  view: DriveWorkspaceView;
  onDelete: (artifactId: string) => void | Promise<void>;
  dropzone?: ReactNode;
  error?: string | null;
}>;

export function DriveFileTree({ kind, view, onDelete, dropzone, error = null }: DriveFileTreeProps) {
  const [rootExpanded, setRootExpanded] = useState(true);
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(() => new Set());
  const label = kind === "input" ? "Input" : "Output";
  const path = `YTB-VPS/${kind}`;

  function toggleProject(projectId: string) {
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  function setFileExpanded(key: string, expanded: boolean) {
    setExpandedFiles((current) => {
      const next = new Set(current);
      if (expanded) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  return (
    <section aria-label={label} className={`drive-file-tree drive-tree-${kind}`}>
      <h3>{label}</h3>
      <button
        aria-expanded={rootExpanded}
        aria-label={`${rootExpanded ? "Thu gọn" : "Mở"} ${path}`}
        className="drive-folder-toggle drive-root-folder-toggle"
        onClick={() => setRootExpanded((current) => !current)}
        style={{ minHeight: 44, minWidth: 0, width: "100%" }}
        title={`${rootExpanded ? "Thu gọn" : "Mở"} ${path}`}
        type="button"
      >
        <ChevronIcon aria-hidden direction={rootExpanded ? "down" : "right"} size={18} />
        <FolderIcon aria-hidden size={21} />
        <span>{path}</span>
      </button>

      {rootExpanded && (
        <>
          {error ? (
            <p className="drive-tree-error" role="alert">{error}</p>
          ) : kind === "input" ? (
            <ul className="drive-tree-list">
              {view.input.map((file) => {
                const key = `input:${file.artifactId}`;
                return (
                  <DriveFileRow
                    expanded={expandedFiles.has(key)}
                    file={file}
                    key={file.artifactId}
                    onDelete={onDelete}
                    onExpandedChange={(expanded) => setFileExpanded(key, expanded)}
                  />
                );
              })}
              {view.input.length === 0 && <li className="drive-tree-empty">Chưa có video nguồn.</li>}
              {dropzone && <li className="drive-tree-dropzone">{dropzone}</li>}
            </ul>
          ) : (
            <ul className="drive-tree-list drive-tree-projects">
              {view.output.map((project) => {
                const projectExpanded = expandedProjects.has(project.projectId);
                return (
                  <li className="drive-project-folder" key={project.projectId}>
                    <button
                      aria-expanded={projectExpanded}
                      aria-label={`${projectExpanded ? "Đóng" : "Mở"} thư mục ${project.name}`}
                      className="drive-folder-toggle drive-project-toggle"
                      onClick={() => toggleProject(project.projectId)}
                      style={{ minHeight: 44, minWidth: 0, width: "100%" }}
                      title={`${projectExpanded ? "Đóng" : "Mở"} thư mục ${project.name}`}
                      type="button"
                    >
                      <ChevronIcon aria-hidden direction={projectExpanded ? "down" : "right"} size={18} />
                      <FolderIcon aria-hidden size={21} />
                      <span>{project.name}</span>
                    </button>
                    {projectExpanded && (
                      <ul className="drive-tree-list drive-project-files">
                        {project.files.map((file) => {
                          const key = `${project.projectId}:${file.artifactId}`;
                          return (
                            <DriveFileRow
                              expanded={expandedFiles.has(key)}
                              file={file}
                              key={file.artifactId}
                              onDelete={onDelete}
                              onExpandedChange={(expanded) => setFileExpanded(key, expanded)}
                            />
                          );
                        })}
                        {project.files.length === 0 && <li className="drive-tree-empty">Thư mục chưa có video.</li>}
                      </ul>
                    )}
                  </li>
                );
              })}
              {view.output.length === 0 && <li className="drive-tree-empty">Chưa có video render.</li>}
            </ul>
          )}
          {error && kind === "input" && dropzone}
        </>
      )}
    </section>
  );
}
