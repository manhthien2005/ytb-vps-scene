import { describe, expect, it, vi } from "vitest";
import { createGoogleDriveFilesAdapter } from "./drive-files";

const FILE_FIELDS = "id,name,mimeType,size,parents,trashed,appProperties";
const VIDEO_METADATA_FIELDS = `${FILE_FIELDS},createdTime,modifiedTime,videoMediaMetadata(width,height,durationMillis),webViewLink,webContentLink`;
const ABOUT_FIELDS = "storageQuota(limit,usage),user(permissionId,emailAddress)";
const ACCESS_TOKEN = "server-memory-access-token";
const NOW = new Date("2026-07-19T00:00:00.000Z");
const FOLDER_MIME = "application/vnd.google-apps.folder";
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const ARTIFACT_ID = "10000000-0000-4000-8000-000000000001";
const MY_DRIVE_ROOT_ID = "opaque-my-drive-root-id";
const READY_VIDEO_FILE = {
  id: "drive-video-001",
  name: "source.mp4",
  mimeType: "video/mp4",
  size: "864026624",
  parents: ["drive-parent-001"],
  trashed: false,
  appProperties: { schema: "1", ytbVpsRole: "source", ytbVpsArtifactId: ARTIFACT_ID },
  createdTime: "2026-07-22T07:30:00.000Z",
  modifiedTime: "2026-07-22T07:35:00.000Z",
  videoMediaMetadata: { width: 1920, height: 1080, durationMillis: "5076000" },
  webViewLink: "https://drive.google.com/file/d/drive-video-001/view",
  webContentLink: "https://drive.usercontent.google.com/download?id=drive-video-001",
};

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
  it("returns bounded video metadata and safe Drive browser links", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(READY_VIDEO_FILE));

    await expect(adapter(fetcher).inspectVideoMetadata(ACCESS_TOKEN, "drive-video-001"))
      .resolves.toMatchObject({
        sizeBytes: 864_026_624,
        width: 1920,
        height: 1080,
        durationMillis: 5_076_000,
        webViewLink: READY_VIDEO_FILE.webViewLink,
        webContentLink: READY_VIDEO_FILE.webContentLink,
      });

    expect(requestDetails(fetcher).url.searchParams.get("fields")).toBe(VIDEO_METADATA_FIELDS);
  });

  it("returns null media fields while Drive is processing", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({
      ...READY_VIDEO_FILE,
      videoMediaMetadata: undefined,
      webViewLink: undefined,
      webContentLink: undefined,
    }));

    await expect(adapter(fetcher).inspectVideoMetadata(ACCESS_TOKEN, "drive-video-001"))
      .resolves.toMatchObject({
        width: null,
        height: null,
        durationMillis: null,
        webViewLink: null,
        webContentLink: null,
      });
  });

  it("maps an authenticated video metadata 404 to the distinct file-not-found code", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 404 }));

    await expect(adapter(fetcher).inspectVideoMetadata(ACCESS_TOKEN, "drive-video-001"))
      .rejects.toMatchObject({ code: "DRIVE_FILE_NOT_FOUND", status: 404 });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(requestDetails(fetcher).init.method).toBe("GET");
  });

  it.each([
    [401, "DRIVE_REAUTH_REQUIRED"],
    [429, "DRIVE_RATE_LIMITED"],
    [503, "DRIVE_TEMPORARILY_UNAVAILABLE"],
  ] as const)("does not collapse video metadata HTTP %i into file-not-found", async (status, code) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async () => new Response(null, { status }),
    );

    await expect(adapter(fetcher).inspectVideoMetadata(ACCESS_TOKEN, "drive-video-001"))
      .rejects.toMatchObject({ code });
  });

  it("rejects browser links outside the Google Drive allowlist", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({
      ...READY_VIDEO_FILE,
      webViewLink: "https://evil.test/file",
    }));

    await expect(adapter(fetcher).inspectVideoMetadata(ACCESS_TOKEN, "drive-video-001"))
      .rejects.toMatchObject({ code: "DRIVE_REMOTE_MISMATCH" });
  });

  it("rejects an impossible Drive metadata calendar date", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({
      ...READY_VIDEO_FILE,
      createdTime: "2026-02-30T07:30:00.000Z",
    }));

    await expect(adapter(fetcher).inspectVideoMetadata(ACCESS_TOKEN, "drive-video-001"))
      .rejects.toMatchObject({ code: "DRIVE_REMOTE_MISMATCH" });
  });

  it.each([
    ["a malformed timestamp", { modifiedTime: "2026-07-22 07:35:00Z" }],
    ["a non-leap-day timestamp", { modifiedTime: "2026-02-29T07:35:00.000Z" }],
    ["an out-of-range timestamp time", { modifiedTime: "2026-07-22T24:35:00.000Z" }],
    ["a zero dimension", {
      videoMediaMetadata: { width: 0, height: 1080, durationMillis: "5076000" },
    }],
    ["a fractional dimension", {
      videoMediaMetadata: { width: 1920.5, height: 1080, durationMillis: "5076000" },
    }],
    ["an unsafe dimension", {
      videoMediaMetadata: { width: Number.MAX_SAFE_INTEGER + 1, height: 1080, durationMillis: "5076000" },
    }],
    ["a negative duration", {
      videoMediaMetadata: { width: 1920, height: 1080, durationMillis: "-1" },
    }],
    ["a non-integer duration", {
      videoMediaMetadata: { width: 1920, height: 1080, durationMillis: "5076.5" },
    }],
    ["an unsafe duration", {
      videoMediaMetadata: { width: 1920, height: 1080, durationMillis: "9007199254740992" },
    }],
  ])("rejects present video metadata with %s", async (_reason, overrides) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({
      ...READY_VIDEO_FILE,
      ...overrides,
    }));

    await expect(adapter(fetcher).inspectVideoMetadata(ACCESS_TOKEN, "drive-video-001"))
      .rejects.toMatchObject({ code: "DRIVE_REMOTE_MISMATCH" });
  });

  it.each([
    ["embedded credentials", "https://user:password@drive.google.com/file/d/drive-video-001/view"],
    ["a fragment", "https://drive.google.com/file/d/drive-video-001/view#private"],
    ["a non-default port", "https://drive.google.com:8443/file/d/drive-video-001/view"],
    ["an insecure protocol", "http://drive.google.com/file/d/drive-video-001/view"],
    ["a non-Drive host", "https://evil.test/file/d/drive-video-001/view"],
  ])("rejects a browser link with %s", async (_reason, webViewLink) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({
      ...READY_VIDEO_FILE,
      webViewLink,
    }));

    await expect(adapter(fetcher).inspectVideoMetadata(ACCESS_TOKEN, "drive-video-001"))
      .rejects.toMatchObject({ code: "DRIVE_REMOTE_MISMATCH" });
  });

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

  it("uses the root alias without reading My Drive and creates one private root folder", async () => {
    const properties = { ytbVpsRole: "root", schema: "1" };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse(folder(
        "drive-root-folder-001",
        "YTB-VPS",
        MY_DRIVE_ROOT_ID,
        properties,
      )));

    await expect(adapter(fetcher).ensureWorkspace(ACCESS_TOKEN))
      .resolves.toEqual({ rootFolderId: "drive-root-folder-001" });

    const list = requestDetails(fetcher, 0);
    expect(list.url.searchParams.get("fields")).toBe(`nextPageToken,files(${FILE_FIELDS})`);
    expect(list.url.searchParams.get("pageSize")).toBe("17");
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

  it("reconciles an ambiguous root create without issuing a second POST", async () => {
    const properties = { ytbVpsRole: "root", schema: "1" };
    const created = folder(
      "drive-root-folder-001",
      "YTB-VPS",
      MY_DRIVE_ROOT_ID,
      properties,
    );
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ files: [created] }));

    await expect(adapter(fetcher).ensureWorkspace(ACCESS_TOKEN))
      .resolves.toEqual({ rootFolderId: created.id });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual([
      "GET",
      "POST",
      "GET",
    ]);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("reuses exact duplicate roots with one deterministic canonical identity", async () => {
    const properties = { ytbVpsRole: "root", schema: "1" };
    const valid = folder("drive-root-folder-001", "YTB-VPS", MY_DRIVE_ROOT_ID, properties);
    const reuseFetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ files: [valid] }));
    await expect(adapter(reuseFetcher).ensureWorkspace(ACCESS_TOKEN))
      .resolves.toEqual({ rootFolderId: valid.id });
    expect(reuseFetcher).toHaveBeenCalledTimes(1);

    const duplicateFetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({
      files: [
        folder("drive-root-folder-002", "YTB-VPS", MY_DRIVE_ROOT_ID, properties),
        valid,
      ],
    }));
    await expect(adapter(duplicateFetcher).ensureWorkspace(ACCESS_TOKEN))
      .resolves.toEqual({ rootFolderId: valid.id });
    expect(duplicateFetcher).toHaveBeenCalledOnce();
    expect(duplicateFetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("rejects mixed duplicate or mismatched root evidence", async () => {
    const properties = { ytbVpsRole: "root", schema: "1" };
    const valid = folder("drive-root-folder-001", "YTB-VPS", MY_DRIVE_ROOT_ID, properties);
    const duplicateFetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({
      files: [valid, { ...valid, id: "drive-root-folder-002", name: "wrong-name" }],
    }));
    await expect(adapter(duplicateFetcher).ensureWorkspace(ACCESS_TOKEN))
      .rejects.toMatchObject({ code: "DRIVE_REMOTE_MISMATCH", message: "DRIVE_REMOTE_MISMATCH" });

    const mismatchFetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        files: [{ ...valid, name: "wrong-name" }],
      }));
    await expect(adapter(mismatchFetcher).ensureWorkspace(ACCESS_TOKEN))
      .rejects.toMatchObject({ code: "DRIVE_REMOTE_MISMATCH", message: "DRIVE_REMOTE_MISMATCH" });
  });

  it("creates project film folders under shared input and output folders", async () => {
    const rootProperties = { ytbVpsRole: "root", schema: "1" };
    const inputProperties = { ytbVpsRole: "input", schema: "1" };
    const outputProperties = { ytbVpsRole: "output", schema: "1" };
    const projectInputProperties = { ytbVpsProjectId: PROJECT_ID, ytbVpsRole: "input", schema: "1" };
    const filmProperties = { ytbVpsProjectId: PROJECT_ID, ytbVpsRole: "film", schema: "1" };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        files: [folder("drive-root-folder-001", "YTB-VPS", MY_DRIVE_ROOT_ID, rootProperties)],
      }))
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse(folder("drive-input-folder-001", "input", "drive-root-folder-001", inputProperties)))
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse(folder("drive-project-input-folder-001", "Tên phim - Phần 1", "drive-input-folder-001", projectInputProperties)))
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse(folder("drive-output-folder-001", "output", "drive-root-folder-001", outputProperties)))
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse(folder("drive-film-folder-001", "Tên phim - Phần 1", "drive-output-folder-001", filmProperties)));

    await expect(adapter(fetcher).ensureProjectFolders(ACCESS_TOKEN, PROJECT_ID, "Tên phim / Phần 1")).resolves.toEqual({
      projectFolderId: "drive-film-folder-001",
      inputFolderId: "drive-project-input-folder-001",
    });

    const createdInput = JSON.parse(String(fetcher.mock.calls[2]![1]?.body));
    const createdProjectInput = JSON.parse(String(fetcher.mock.calls[4]![1]?.body));
    const createdOutput = JSON.parse(String(fetcher.mock.calls[6]![1]?.body));
    const createdFilm = JSON.parse(String(fetcher.mock.calls[8]![1]?.body));
    expect(createdInput).toMatchObject({
      name: "input",
      parents: ["drive-root-folder-001"],
      appProperties: inputProperties,
    });
    expect(createdProjectInput).toMatchObject({
      name: "Tên phim - Phần 1",
      parents: ["drive-input-folder-001"],
      appProperties: projectInputProperties,
    });
    expect(createdOutput).toMatchObject({
      name: "output",
      parents: ["drive-root-folder-001"],
      appProperties: outputProperties,
    });
    expect(createdFilm).toMatchObject({
      name: "Tên phim - Phần 1",
      parents: ["drive-output-folder-001"],
      appProperties: filmProperties,
    });
  });

  it("reuses an existing per-project input folder", async () => {
    const rootProperties = { ytbVpsRole: "root", schema: "1" };
    const inputProperties = { ytbVpsRole: "input", schema: "1" };
    const outputProperties = { ytbVpsRole: "output", schema: "1" };
    const projectInputProperties = { ytbVpsProjectId: PROJECT_ID, ytbVpsRole: "input", schema: "1" };
    const filmProperties = { ytbVpsProjectId: PROJECT_ID, ytbVpsRole: "film", schema: "1" };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        files: [folder("drive-root-folder-001", "YTB-VPS", MY_DRIVE_ROOT_ID, rootProperties)],
      }))
      .mockResolvedValueOnce(jsonResponse({
        files: [folder("drive-input-folder-001", "input", "drive-root-folder-001", inputProperties)],
      }))
      .mockResolvedValueOnce(jsonResponse({
        files: [folder("drive-project-input-folder-001", "Tên phim", "drive-input-folder-001", projectInputProperties)],
      }))
      .mockResolvedValueOnce(jsonResponse({
        files: [folder("drive-output-folder-001", "output", "drive-root-folder-001", outputProperties)],
      }))
      .mockResolvedValueOnce(jsonResponse({
        files: [folder("drive-film-folder-001", "Tên phim", "drive-output-folder-001", filmProperties)],
      }));

    await expect(adapter(fetcher).ensureProjectFolders(ACCESS_TOKEN, PROJECT_ID, "Tên phim")).resolves.toEqual({
      projectFolderId: "drive-film-folder-001",
      inputFolderId: "drive-project-input-folder-001",
    });
    expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
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
      name: "display-name.mp4",
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

  it("accepts a canonical Vietnamese source filename", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse({
        id: "drive-source-file-001",
        name: "Phụ đề tiếng Việt.mp4",
        mimeType: "video/mp4",
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
      fileName: "Phụ đề tiếng Việt.mp4",
      mimeType: "video/mp4",
      sizeBytes: 100,
      lastModified: 1,
      normalizedExtension: "mp4",
    })).resolves.toBe("drive-source-file-001");
  });

  it("reuses the lowest opaque ID when exact empty source duplicates exist", async () => {
    const properties = {
      ytbVpsProjectId: PROJECT_ID,
      ytbVpsArtifactId: ARTIFACT_ID,
      ytbVpsRole: "source",
      schema: "1",
    };
    const source = (id: string) => ({
      id,
      name: "display-name.mp4",
      mimeType: "video/mp4",
      size: "0",
      parents: ["drive-input-folder-001"],
      trashed: false,
      appProperties: properties,
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({
      files: [source("drive-source-file-002"), source("drive-source-file-001")],
    }));

    await expect(adapter(fetcher).ensureSourceFile(ACCESS_TOKEN, {
      projectId: PROJECT_ID,
      artifactId: ARTIFACT_ID,
      parentId: "drive-input-folder-001",
      fileName: "display-name.mp4",
      mimeType: "video/mp4",
      sizeBytes: 100,
      lastModified: 1,
      normalizedExtension: "mp4",
    })).resolves.toBe("drive-source-file-001");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("creates an empty source file using the original filename", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse({
        id: "drive-source-file-001",
        name: "private-display-name.webm",
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
    expect(created.name).toBe("private-display-name.webm");
  });

  it.each([
    ["malformed success JSON", () => new Response("{", { status: 200 })],
    ["a failed success stream", () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":"part'));
        controller.error(new Error("private provider stream failure"));
      },
    }), { status: 200 })],
  ])("reconciles %s after one source create", async (_case, ambiguousResponse) => {
    const properties = {
      ytbVpsProjectId: PROJECT_ID,
      ytbVpsArtifactId: ARTIFACT_ID,
      ytbVpsRole: "source",
      schema: "1",
    };
    const created = {
      id: "drive-source-file-001",
      name: "private-display-name.webm",
      mimeType: "video/webm",
      size: "0",
      parents: ["drive-input-folder-001"],
      trashed: false,
      appProperties: properties,
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(ambiguousResponse())
      .mockResolvedValueOnce(jsonResponse({ files: [created] }));

    await expect(adapter(fetcher).ensureSourceFile(ACCESS_TOKEN, {
      projectId: PROJECT_ID,
      artifactId: ARTIFACT_ID,
      parentId: "drive-input-folder-001",
      fileName: "private-display-name.webm",
      mimeType: "video/webm",
      sizeBytes: 100,
      lastModified: 1,
      normalizedExtension: "webm",
    })).resolves.toBe(created.id);

    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST", "GET"]);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("re-lists once without repeating a definitively rejected source create", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse({ error: "invalid" }, { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ files: [] }));

    await expect(adapter(fetcher).ensureSourceFile(ACCESS_TOKEN, {
      projectId: PROJECT_ID,
      artifactId: ARTIFACT_ID,
      parentId: "drive-input-folder-001",
      fileName: "private-display-name.webm",
      mimeType: "video/webm",
      sizeBytes: 100,
      lastModified: 1,
      normalizedExtension: "webm",
    })).rejects.toMatchObject({ code: "DRIVE_PROVIDER_REJECTED" });

    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST", "GET"]);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("creates a bounded resumable PATCH update session with a trusted URI", async () => {
    const sessionUri = "https://www.googleapis.com/upload/drive/v3/files/file-001?uploadType=resumable&upload_id=opaque";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 200,
      headers: { location: sessionUri },
    }));

    const sessionInput = {
      fileId: "drive-source-file-001",
      mimeType: "video/mp4",
      sizeBytes: 8_388_608,
      origin: "https://ytb-vps-scene.vercel.app",
    };
    await expect(adapter(fetcher).createResumableUpdateSession(ACCESS_TOKEN, sessionInput))
      .resolves.toEqual({ sessionUri, expiresAt: "2026-07-26T00:00:00.000Z" });

    const { url, init } = requestDetails(fetcher);
    expect(url.origin + url.pathname).toBe(
      "https://www.googleapis.com/upload/drive/v3/files/drive-source-file-001",
    );
    expect(url.searchParams.get("uploadType")).toBe("resumable");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBeUndefined();
    const requestInit = { ...init };
    delete requestInit.signal;
    const request = new Request(url, requestInit);
    expect(request.headers.get("content-type")).toBeNull();
    expect(request.headers.get("content-length")).toBe("0");
    expect(request.headers.get("origin")).toBe("https://ytb-vps-scene.vercel.app");
    expect(request.headers.get("x-upload-content-length")).toBe("8388608");
    expect(request.headers.get("x-upload-content-type")).toBe("video/mp4");
  });

  it("logs only a safe stage and status when Drive rejects session initiation", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(
      { error: { message: "private provider detail" } },
      { status: 400 },
    ));

    try {
      await expect(adapter(fetcher).createResumableUpdateSession(ACCESS_TOKEN, {
        fileId: "drive-source-file-001",
        mimeType: "video/mp4",
        sizeBytes: 8_388_608,
      })).rejects.toMatchObject({ code: "DRIVE_PROVIDER_REJECTED" });

      expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
        "[drive-upload] session-init-rejected",
        { stage: "provider-response", status: 400 },
      );
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(ACCESS_TOKEN);
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("drive-source-file-001");
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private provider detail");
    } finally {
      diagnostic.mockRestore();
    }
  });

  it("logs only the safe shape of a rejected session Location", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 200,
      headers: {
        location: "https://www.googleapis.com/upload/drive/v3/files/private-file-id?uploadType=resumable&upload_protocol=resumable&upload_id=private-capability",
      },
    }));

    try {
      await expect(adapter(fetcher).createResumableUpdateSession(ACCESS_TOKEN, {
        fileId: "drive-source-file-001",
        mimeType: "video/mp4",
        sizeBytes: 8_388_608,
      })).rejects.toMatchObject({ code: "DRIVE_PROVIDER_REJECTED" });

      expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
        "[drive-upload] session-location-rejected",
        {
          stage: "provider-location",
          hostAllowed: true,
          pathAllowed: true,
          queryKeys: ["uploadType", "upload_id", "upload_protocol"],
          uploadIdCount: 1,
          uploadIdLength: 18,
          uploadIdTokenSafe: true,
        },
      );
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private-file-id");
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private-capability");
    } finally {
      diagnostic.mockRestore();
    }
  });

  it("creates one private app-owned output file with exact fenced metadata", async () => {
    const jobId = "40000000-0000-4000-8000-000000000001";
    const properties = {
      ytbVpsProjectId: PROJECT_ID,
      ytbVpsArtifactId: ARTIFACT_ID,
      ytbVpsJobId: jobId,
      ytbVpsRole: "output",
      schema: "1",
    };
    const output = {
      id: "drive-output-file-001",
      name: "part-01-of-01.mp4",
      mimeType: "video/mp4",
      size: "0",
      parents: ["drive-project-folder-001"],
      trashed: false,
      appProperties: properties,
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse(output));

    await expect(adapter(fetcher).ensureOutputFile(ACCESS_TOKEN, {
      projectId: PROJECT_ID,
      jobId,
      artifactId: ARTIFACT_ID,
      parentId: "drive-project-folder-001",
    })).resolves.toBe("drive-output-file-001");

    const create = JSON.parse(String(fetcher.mock.calls[1]![1]?.body));
    expect(create).toEqual({
      name: "part-01-of-01.mp4",
      mimeType: "video/mp4",
      parents: ["drive-project-folder-001"],
      appProperties: properties,
    });
    expect(JSON.stringify(create)).not.toContain("permission");
  });

  it.each([
    ["http://www.googleapis.com/upload/drive/v3/files/file?upload_id=x"],
    ["https://evil.example/upload/drive/v3/files/file?upload_id=x"],
    ["https://www.googleapis.com/drive/v3/files/file"],
    ["https://www.googleapis.com/upload/drive/v3/files/file?upload_id=x&unexpected=value"],
    ["https://www.googleapis.com/upload/drive/v3/files/file?uploadType=resumable&uploadType=resumable&upload_id=x"],
    ["https://www.googleapis.com/upload/drive/v3/files/file?upload_id=x&access_token=credential"],
    ["https://www.googleapis.com/upload/drive/v3/files/file?upload_id=x#fragment"],
  ])("rejects an untrusted resumable Location %#", async (location) => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 200,
      headers: { location },
    }));

    try {
      await expect(adapter(fetcher).createResumableUpdateSession(ACCESS_TOKEN, {
        fileId: "drive-source-file-001",
        mimeType: "video/mp4",
        sizeBytes: 1,
      })).rejects.toThrow("DRIVE_PROVIDER_REJECTED");
      expect(diagnostic).toHaveBeenCalledOnce();
    } finally {
      diagnostic.mockRestore();
    }
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

  it("treats an already-missing claimed file as an idempotent deletion", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));

    await expect(adapter(fetcher).deleteFile(ACCESS_TOKEN, "drive-source-file-001"))
      .resolves.toBeUndefined();
    expect(requestDetails(fetcher).init.method).toBe("DELETE");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("retries metadata failures at most three total attempts", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({}, { status: 503 }));

    await expect(adapter(fetcher).inspectAccount(ACCESS_TOKEN))
      .rejects.toThrow("DRIVE_TEMPORARILY_UNAVAILABLE");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
