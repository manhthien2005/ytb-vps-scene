import { describe, expect, it, vi } from "vitest";
import { createGoogleDriveFilesAdapter } from "./drive-files";

const FILE_FIELDS = "id,name,mimeType,size,parents,trashed,appProperties";
const ABOUT_FIELDS = "storageQuota(limit,usage),user(permissionId,emailAddress)";
const ACCESS_TOKEN = "server-memory-access-token";
const NOW = new Date("2026-07-19T00:00:00.000Z");
const FOLDER_MIME = "application/vnd.google-apps.folder";
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const ARTIFACT_ID = "10000000-0000-4000-8000-000000000001";

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function folder(
  id: string,
  name: string,
  parent: string,
  appProperties: Record<string, string>,
) {
  return { id, name, mimeType: FOLDER_MIME, parents: [parent], trashed: false, appProperties };
}

function adapter(fetcher: typeof fetch) {
  return createGoogleDriveFilesAdapter({ fetcher, now: () => NOW });
}

function requestDetails(fetcher: ReturnType<typeof vi.fn<typeof fetch>>, index = 0) {
  const [input, init] = fetcher.mock.calls[index]!;
  const url = new URL(typeof input === "string" ? input : input.toString());
  expect(url.toString()).not.toContain(ACCESS_TOKEN);
  expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
  return { url, init: init ?? {} };
}

describe("createGoogleDriveFilesAdapter", () => {
  it("inspects exact account fields and masks the returned email", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      storageQuota: { limit: "1000000", usage: "125000" },
      user: { permissionId: "permission-id-001", emailAddress: "private.owner@example.com" },
    }));

    const result = await adapter(fetcher).inspectAccount(ACCESS_TOKEN);

    expect(result).toEqual({
      permissionId: "permission-id-001",
      accountHint: "p***@example.com",
      usedBytes: 125_000,
      limitBytes: 1_000_000,
    });
    expect(JSON.stringify(result)).not.toContain("private.owner@example.com");
    const { url, init } = requestDetails(fetcher);
    expect(url.origin + url.pathname).toBe("https://www.googleapis.com/drive/v3/about");
    expect([...url.searchParams.entries()]).toEqual([["fields", ABOUT_FIELDS]]);
    expect(init.method).toBe("GET");
  });

  it.each([
    [{ storageQuota: { limit: "100", usage: "101" }, user: { permissionId: "id", emailAddress: "a@example.com" } }],
    [{ storageQuota: { limit: "100", usage: "1.5" }, user: { permissionId: "id", emailAddress: "a@example.com" } }],
    [{ storageQuota: { limit: "100", usage: "1" }, user: { permissionId: "", emailAddress: "a@example.com" } }],
    [{ storageQuota: { limit: "100", usage: "1" }, user: { permissionId: "id", emailAddress: "not-an-email" } }],
    [{ storageQuota: { limit: "100", usage: "1" }, user: { permissionId: "id", emailAddress: "a@example.com" }, extra: true }],
  ])("fails closed on malformed account/quota evidence %#", async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body));

    await expect(adapter(fetcher).inspectAccount(ACCESS_TOKEN))
      .rejects.toThrow("DRIVE_PROVIDER_REJECTED");
  });

  it("queries by private root properties and creates one private root folder", async () => {
    const properties = { ytbVpsRole: "root", schema: "1" };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse(folder("drive-root-folder-001", "YTB-VPS", "root", properties)));

    await expect(adapter(fetcher).ensureWorkspace(ACCESS_TOKEN))
      .resolves.toEqual({ rootFolderId: "drive-root-folder-001" });

    const list = requestDetails(fetcher, 0);
    expect(list.url.searchParams.get("fields")).toBe(`files(${FILE_FIELDS})`);
    expect(list.url.searchParams.get("pageSize")).toBe("2");
    expect(list.url.searchParams.get("q")).toContain("'root' in parents");
    expect(list.url.searchParams.get("q")).toContain("key='ytbVpsRole' and value='root'");
    expect(list.url.searchParams.get("q")).toContain("key='schema' and value='1'");

    const create = requestDetails(fetcher, 1);
    expect(create.init.method).toBe("POST");
    expect(create.url.searchParams.get("fields")).toBe(FILE_FIELDS);
    expect(JSON.parse(String(create.init.body))).toEqual({
      name: "YTB-VPS",
      mimeType: FOLDER_MIME,
      parents: ["root"],
      appProperties: properties,
    });
    expect(fetcher.mock.calls.every(([input]) => !String(input).includes("permissions"))).toBe(true);
  });

  it("reuses exactly one valid root and rejects duplicates or mismatches", async () => {
    const properties = { ytbVpsRole: "root", schema: "1" };
    const valid = folder("drive-root-folder-001", "YTB-VPS", "root", properties);
    const reuseFetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ files: [valid] }));
    await expect(adapter(reuseFetcher).ensureWorkspace(ACCESS_TOKEN))
      .resolves.toEqual({ rootFolderId: valid.id });
    expect(reuseFetcher).toHaveBeenCalledOnce();

    const duplicateFetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ files: [valid, valid] }));
    await expect(adapter(duplicateFetcher).ensureWorkspace(ACCESS_TOKEN))
      .rejects.toMatchObject({ code: "DRIVE_REMOTE_MISMATCH", message: "DRIVE_REMOTE_MISMATCH" });

    const mismatchFetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      files: [{ ...valid, parents: ["wrong-parent"] }],
    }));
    await expect(adapter(mismatchFetcher).ensureWorkspace(ACCESS_TOKEN))
      .rejects.toMatchObject({ code: "DRIVE_REMOTE_MISMATCH", message: "DRIVE_REMOTE_MISMATCH" });
  });

  it("ensures the projects/project/input hierarchy by IDs and appProperties", async () => {
    const rootProperties = { ytbVpsRole: "root", schema: "1" };
    const projectsProperties = { ytbVpsRole: "projects", schema: "1" };
    const projectProperties = { ytbVpsProjectId: PROJECT_ID, ytbVpsRole: "project", schema: "1" };
    const inputProperties = { ytbVpsProjectId: PROJECT_ID, ytbVpsRole: "input", schema: "1" };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ files: [folder("drive-root-folder-001", "YTB-VPS", "root", rootProperties)] }))
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse(folder("drive-projects-folder-001", "projects", "drive-root-folder-001", projectsProperties)))
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse(folder("drive-project-folder-001", PROJECT_ID, "drive-projects-folder-001", projectProperties)))
      .mockResolvedValueOnce(jsonResponse({ files: [folder("drive-input-folder-001", "input", "drive-project-folder-001", inputProperties)] }));

    await expect(adapter(fetcher).ensureProjectFolders(ACCESS_TOKEN, PROJECT_ID)).resolves.toEqual({
      projectFolderId: "drive-project-folder-001",
      inputFolderId: "drive-input-folder-001",
    });

    const createdProjects = JSON.parse(String(fetcher.mock.calls[2]![1]?.body));
    const createdProject = JSON.parse(String(fetcher.mock.calls[4]![1]?.body));
    expect(createdProjects).toMatchObject({
      name: "projects",
      parents: ["drive-root-folder-001"],
      appProperties: projectsProperties,
    });
    expect(createdProject).toMatchObject({
      name: PROJECT_ID,
      parents: ["drive-projects-folder-001"],
      appProperties: projectProperties,
    });
  });

  it("escapes appProperty and parent query values and reuses one empty source", async () => {
    const parentId = "parent'id\\segment";
    const properties = {
      ytbVpsProjectId: PROJECT_ID,
      ytbVpsArtifactId: ARTIFACT_ID,
      ytbVpsRole: "source",
      schema: "1",
    };
    const source = {
      id: "drive-source-file-001",
      name: "source.mp4",
      mimeType: "video/mp4",
      size: "0",
      parents: [parentId],
      trashed: false,
      appProperties: properties,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ files: [source] }));

    await expect(adapter(fetcher).ensureSourceFile(ACCESS_TOKEN, {
      projectId: PROJECT_ID,
      artifactId: ARTIFACT_ID,
      parentId,
      fileName: "display-name.mp4",
      mimeType: "video/mp4",
      sizeBytes: 100,
      lastModified: 1,
      normalizedExtension: "mp4",
    })).resolves.toBe("drive-source-file-001");

    const query = requestDetails(fetcher).url.searchParams.get("q")!;
    expect(query).toContain("'parent\\'id\\\\segment' in parents");
    expect(query).toContain(`value='${ARTIFACT_ID}'`);
  });

  it("creates a normalized private empty source file on zero matches", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse({
        id: "drive-source-file-001",
        name: "source.webm",
        mimeType: "video/webm",
        size: "0",
        parents: ["drive-input-folder-001"],
        trashed: false,
        appProperties: {
          ytbVpsProjectId: PROJECT_ID,
          ytbVpsArtifactId: ARTIFACT_ID,
          ytbVpsRole: "source",
          schema: "1",
        },
      }));

    await expect(adapter(fetcher).ensureSourceFile(ACCESS_TOKEN, {
      projectId: PROJECT_ID,
      artifactId: ARTIFACT_ID,
      parentId: "drive-input-folder-001",
      fileName: "private-display-name.webm",
      mimeType: "video/webm",
      sizeBytes: 100,
      lastModified: 1,
      normalizedExtension: "webm",
    })).resolves.toBe("drive-source-file-001");

    const created = JSON.parse(String(fetcher.mock.calls[1]![1]?.body));
    expect(created.name).toBe("source.webm");
    expect(JSON.stringify(created)).not.toContain("private-display-name.webm");
  });

  it("creates a bounded resumable PATCH update session with a trusted URI", async () => {
    const sessionUri = "https://www.googleapis.com/upload/drive/v3/files/file-001?upload_id=opaque";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 200,
      headers: { location: sessionUri },
    }));

    await expect(adapter(fetcher).createResumableUpdateSession(ACCESS_TOKEN, {
      fileId: "drive-source-file-001",
      mimeType: "video/mp4",
      sizeBytes: 8_388_608,
    })).resolves.toEqual({ sessionUri, expiresAt: "2026-07-26T00:00:00.000Z" });

    const { url, init } = requestDetails(fetcher);
    expect(url.origin + url.pathname).toBe(
      "https://www.googleapis.com/upload/drive/v3/files/drive-source-file-001",
    );
    expect(url.searchParams.get("uploadType")).toBe("resumable");
    expect(init.method).toBe("PATCH");
    const headers = new Headers(init.headers);
    expect(headers.get("x-upload-content-length")).toBe("8388608");
    expect(headers.get("x-upload-content-type")).toBe("video/mp4");
  });

  it.each([
    ["http://www.googleapis.com/upload/drive/v3/files/file?upload_id=x"],
    ["https://evil.example/upload/drive/v3/files/file?upload_id=x"],
    ["https://www.googleapis.com/drive/v3/files/file"],
  ])("rejects an untrusted resumable Location %#", async (location) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 200,
      headers: { location },
    }));

    await expect(adapter(fetcher).createResumableUpdateSession(ACCESS_TOKEN, {
      fileId: "drive-source-file-001",
      mimeType: "video/mp4",
      sizeBytes: 1,
    })).rejects.toThrow("DRIVE_PROVIDER_REJECTED");
  });

  it("preserves 401 mapping when response cancellation itself fails", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          throw new Error("provider cancellation diagnostic");
        },
      }),
      { status: 401 },
    ));

    await expect(adapter(fetcher).createResumableUpdateSession(ACCESS_TOKEN, {
      fileId: "drive-source-file-001",
      mimeType: "video/mp4",
      sizeBytes: 1,
    })).rejects.toMatchObject({ code: "DRIVE_REAUTH_REQUIRED" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("inspects exact projected file metadata and deletes without permissions calls", async () => {
    const properties = { ytbVpsProjectId: PROJECT_ID, ytbVpsRole: "source", schema: "1" };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        id: "drive-source-file-001",
        name: "source.mp4",
        mimeType: "video/mp4",
        size: "100",
        parents: ["drive-input-folder-001"],
        trashed: false,
        appProperties: properties,
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(adapter(fetcher).inspectFile(ACCESS_TOKEN, "drive-source-file-001"))
      .resolves.toEqual({
        id: "drive-source-file-001",
        name: "source.mp4",
        mimeType: "video/mp4",
        sizeBytes: 100,
        parentIds: ["drive-input-folder-001"],
        trashed: false,
        appProperties: properties,
      });
    await expect(adapter(fetcher).deleteFile(ACCESS_TOKEN, "drive-source-file-001"))
      .resolves.toBeUndefined();

    expect(requestDetails(fetcher, 0).url.searchParams.get("fields")).toBe(FILE_FIELDS);
    expect(requestDetails(fetcher, 1).init.method).toBe("DELETE");
    expect(fetcher.mock.calls.every(([input]) => !String(input).includes("permissions"))).toBe(true);
  });

  it("retries metadata failures at most three total attempts", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({}, { status: 503 }));

    await expect(adapter(fetcher).inspectAccount(ACCESS_TOKEN))
      .rejects.toThrow("DRIVE_TEMPORARILY_UNAVAILABLE");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
