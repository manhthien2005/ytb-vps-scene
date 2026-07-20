import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { Project } from "@/lib/domain/drive";
import { AppError } from "@/lib/domain/errors";
import type { DriveAccessProvider, DriveFilesPort } from "@/lib/ports/drive";
import {
  PROJECT_TREE_CLAIM_ID,
  type DriveControlPlaneRepository,
} from "@/lib/repositories/drive-control-plane";

export type CreateProjectInput = Readonly<{
  idempotencyKey: string;
  name: string;
}>;

export type ProjectCreationResult = Readonly<{
  outcome: "CREATED" | "REPLAYED";
  project: Project;
}>;

export interface ProjectService {
  createProject(input: CreateProjectInput): Promise<ProjectCreationResult>;
  listProjects(): Promise<readonly Project[]>;
}

type ProjectDependencies = Readonly<{
  repository: DriveControlPlaneRepository;
  access: DriveAccessProvider;
  files: DriveFilesPort;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createProjectService(dependencies: ProjectDependencies): ProjectService {
  return {
    async createProject(input) {
      const name = input.name.trim();
      const idempotencyKeyHash = sha256(input.idempotencyKey);
      const requestHash = sha256(JSON.stringify({ name }));
      const reservation = await dependencies.repository.reserveProject({
        idempotencyKeyHash,
        requestHash,
        name,
      });
      if (reservation.outcome === "CONFLICT") {
        throw new AppError("IDEMPOTENCY_CONFLICT", 409);
      }
      if (reservation.outcome === "EXISTING") {
        return { outcome: "REPLAYED", project: reservation.project };
      }
      const claimToken = randomUUID();
      const claimed = await dependencies.repository.claimProvisioning(
        "PROJECT",
        PROJECT_TREE_CLAIM_ID,
        claimToken,
      );
      if (!claimed) {
        const current = await dependencies.repository.getProject(reservation.project.id);
        if (current?.status === "READY") return { outcome: "REPLAYED", project: current };
        throw new AppError("DRIVE_TEMPORARILY_UNAVAILABLE", 503);
      }
      try {
        const accessToken = await dependencies.access.getAccessToken();
        const folders = await dependencies.files.ensureProjectFolders(
          accessToken,
          reservation.project.id,
          reservation.project.name,
        );
        const project = await dependencies.repository.completeProjectFolders(
          reservation.project.id,
          folders.projectFolderId,
          folders.inputFolderId,
          claimToken,
        );
        await dependencies.repository.recordAudit({
          eventType: "PROJECT_CREATED",
          targetId: project.id,
          actorClass: "admin",
          payload: { status: project.status },
        });
        return {
          outcome: reservation.outcome === "CREATED" ? "CREATED" : "REPLAYED",
          project,
        };
      } catch (error) {
        if (error instanceof AppError && error.code === "DRIVE_REMOTE_MISMATCH") {
          await dependencies.repository.markProjectFailed(reservation.project.id, claimToken);
        }
        throw error;
      } finally {
        await dependencies.repository.releaseProvisioning(
          "PROJECT",
          PROJECT_TREE_CLAIM_ID,
          claimToken,
        ).catch(() => undefined);
      }
    },

    listProjects() {
      return dependencies.repository.listProjects();
    },
  };
}
