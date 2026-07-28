import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobSummary } from "@/lib/domain/control-plane";
import { JobList } from "./job-list";

const READY_PROJECT = {
  id: "10000000-0000-4000-8000-000000000001",
  status: "READY",
  name: "Video tháng 7",
  sourceStatus: "SOURCE_READY",
  createdAt: "2026-07-20T08:30:00.000Z",
  updatedAt: "2026-07-20T08:30:00.000Z",
} as const;

const MISSING_SOURCE_PROJECT = {
  ...READY_PROJECT,
  id: "10000000-0000-4000-8000-000000000002",
  name: "Video chưa có nguồn",
  sourceStatus: "NO_SOURCE",
} as const;

const ACTIVE_JOB = {
  id: "20000000-0000-4000-8000-000000000001",
  projectName: "Vietnamese demo",
  state: "RENDER",
  progressPercent: 72,
  updatedAt: "2026-07-25T01:15:00.000Z",
  activePhase: "render",
  phaseProgressPercent: 68,
  latestMessage: "Đang dựng khung hình",
  etaSeconds: 90,
  workerSummary: {
    id: "40000000-0000-4000-8000-000000000001",
    state: "BUSY",
    accountLabel: "render-node-1",
  },
  outputMetadata: null,
} satisfies JobSummary & {
  workerSummary: Readonly<{ id: string; state: "BUSY"; accountLabel: string }>;
  outputMetadata: null;
};

const FAILED_JOB = {
  id: "20000000-0000-4000-8000-000000000002",
  projectName: "Video lỗi",
  state: "FAILED_FINAL",
  progressPercent: 48,
  updatedAt: "2026-07-25T00:15:00.000Z",
  activePhase: "upload",
  phaseProgressPercent: null,
  latestMessage: null,
  etaSeconds: null,
  errorCode: "OUTPUT_UPLOAD_FAILED",
  errorMessage: "Không thể tải output lên Drive.\n    at private stack",
} satisfies JobSummary;

const DETAIL = {
  id: ACTIVE_JOB.id,
  projectName: ACTIVE_JOB.projectName,
  state: ACTIVE_JOB.state,
  progressPercent: ACTIVE_JOB.progressPercent,
  createdAt: "2026-07-25T01:00:00.000Z",
  updatedAt: ACTIVE_JOB.updatedAt,
  settingsSnapshot: {
    version: 2,
    sourceArtifactId: "30000000-0000-4000-8000-000000000001",
    split: { mode: "fixedSeconds", secondsPerPart: 120 },
    blur: {
      mode: "manual",
      regions: [
        {
          kind: "sourceSubtitle",
          enabled: true,
          rectangle: { x: 0.1, y: 0.7, width: 0.8, height: 0.2 },
        },
        {
          kind: "logo",
          enabled: false,
          rectangle: { x: 0.8, y: 0.05, width: 0.1, height: 0.1 },
        },
      ],
    },
    voice: "BV074_streaming",
    rate: 1,
    output: { format: "mp4" },
    preset: { id: null, name: "Bản tin nhanh" },
    sourceSubtitle: { x: 0.1, y: 0.7, width: 0.8, height: 0.2 },
    logo: { x: 0.8, y: 0.05, width: 0.1, height: 0.1 },
  },
  sourceMetadata: {
    artifactId: "30000000-0000-4000-8000-000000000001",
    displayName: "source.mp4",
    mimeType: "video/mp4",
    sizeBytes: 1_024,
    checksumSha256: "a".repeat(64),
  },
  telemetry: {
    activePhase: "render",
    phaseProgressPercent: 68,
    latestMessage: "Đang dựng khung hình",
    etaSeconds: 90,
    startedAt: "2026-07-25T01:05:00.000Z",
    completedAt: null,
    cancelRequestedAt: null,
    errorCode: null,
    errorMessage: null,
  },
  progressHistory: [{
    id: "50000000-0000-4000-8000-000000000001",
    phase: "render",
    progressPercent: 68,
    message: "Đang dựng khung hình",
    recordedAt: "2026-07-25T01:14:00.000Z",
  }],
  outputMetadata: {
    artifactId: "30000000-0000-4000-8000-000000000002",
    displayName: "part-01-of-02.mp4",
    mimeType: "video/mp4",
    sizeBytes: 512,
    checksumSha256: "b".repeat(64),
  },
  outputParts: [
    {
      artifactId: "30000000-0000-4000-8000-000000000002",
      displayName: "part-01-of-02.mp4",
      mimeType: "video/mp4",
      sizeBytes: 512,
      checksumSha256: "b".repeat(64),
      partIndex: 1,
      partCount: 2,
    },
    {
      artifactId: "30000000-0000-4000-8000-000000000003",
      displayName: "part-02-of-02.mp4",
      mimeType: "video/mp4",
      sizeBytes: 256,
      checksumSha256: "c".repeat(64),
      partIndex: 2,
      partCount: 2,
    },
  ],
  workerSummary: ACTIVE_JOB.workerSummary,
  attemptSummary: {
    count: 2,
    activeCount: 1,
    latestStartedAt: "2026-07-25T01:05:00.000Z",
    latestEndedAt: null,
    latestOutcome: "LEASE_LOST",
  },
  canCancel: true,
  canRetry: false,
  rawLogs: ["private raw log"],
  workerSecret: "private-worker-secret",
  driveToken: "private-drive-token",
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// JobList polls /api/v1/jobs once on mount; tests route that URL separately from the
// endpoint under test so the mount poll never consumes a scripted response.
function routedFetcher(
  jobs: readonly JobSummary[],
  other: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === "/api/v1/jobs") return jsonResponse({ jobs });
    return other(url, init);
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("JobList", () => {
  it("explains the source-ready prerequisite and only offers queue for source-ready projects", () => {
    render(
      <JobList
        jobs={[]}
        projects={[READY_PROJECT, MISSING_SOURCE_PROJECT]}
        fetcher={routedFetcher([], () => jsonResponse({}, 404))}
      />,
    );

    expect(screen.getByText(/video nguồn.*cấu hình.*xác nhận/i)).toBeVisible();
    expect(screen.getByText(/kiểm tra lại cài đặt trước khi render chính thức/i)).toBeVisible();
    expect(screen.getByRole("button", { name: `Xếp render ${READY_PROJECT.name}` })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Video chưa có nguồn/ })).not.toBeInTheDocument();
  });

  it("queues through the project endpoint and suppresses repeated pending clicks", async () => {
    let resolveQueue!: (response: Response) => void;
    const fetcher = routedFetcher([], () => new Promise((resolve) => {
      resolveQueue = resolve;
    }));
    render(<JobList jobs={[]} projects={[READY_PROJECT]} fetcher={fetcher} />);
    const queueButton = screen.getByRole("button", { name: `Xếp render ${READY_PROJECT.name}` });

    fireEvent.click(queueButton);
    fireEvent.click(queueButton);

    const queueCalls = fetcher.mock.calls.filter(([url]) => String(url).includes("/jobs") && String(url) !== "/api/v1/jobs");
    expect(queueButton).toBeDisabled();
    expect(queueCalls).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith(
      `/api/v1/projects/${READY_PROJECT.id}/jobs`,
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: expect.objectContaining({ "idempotency-key": expect.any(String) }),
      }),
    );

    await act(async () => resolveQueue(jsonResponse({ job: ACTIVE_JOB }, 201)));
    expect(await screen.findByText("Đã xếp job vào hàng đợi.")).toBeVisible();
    expect(queueButton).toBeEnabled();
  });

  it("shows progress, phase, ETA, worker, output, timestamps, and a bounded error state", () => {
    render(
      <JobList
        jobs={[ACTIVE_JOB, FAILED_JOB]}
        projects={[]}
        fetcher={routedFetcher([ACTIVE_JOB, FAILED_JOB], () => jsonResponse({}, 404))}
      />,
    );

    const activeRow = screen.getByRole("listitem", { name: `Job ${ACTIVE_JOB.projectName}` });
    expect(within(activeRow).getByText("Đang render")).toBeVisible();
    expect(within(activeRow).getByText("Pha: Render (68%)")).toBeVisible();
    expect(within(activeRow).getByRole("progressbar", { name: `Tiến độ ${ACTIVE_JOB.projectName}` })).toHaveAttribute("aria-valuenow", "72");
    expect(within(activeRow).getByText("Còn khoảng 1 phút 30 giây")).toBeVisible();
    expect(within(activeRow).getByText("Worker: render-node-1")).toBeVisible();
    expect(within(activeRow).getByText("Output: Chưa sẵn sàng")).toBeVisible();
    expect(within(activeRow).getByText(/Cập nhật/)).toHaveAttribute("dateTime", ACTIVE_JOB.updatedAt);

    const failedRow = screen.getByRole("listitem", { name: `Job ${FAILED_JOB.projectName}` });
    expect(within(failedRow).getByText("Chưa có ước tính thời gian")).toBeVisible();
    expect(within(failedRow).getByRole("alert")).toHaveTextContent("OUTPUT_UPLOAD_FAILED");
    expect(within(failedRow).getByRole("alert")).toHaveTextContent("Không thể tải output lên Drive.");
    expect(within(failedRow).getByRole("alert")).not.toHaveTextContent("private stack");
  });

  it("renders the existing multipart progress message without adding controls", () => {
    const multipartJob = {
      ...ACTIVE_JOB,
      state: "UPLOADING",
      activePhase: "upload",
      latestMessage: "Uploading output Part 2/4",
      outputMetadata: {
        artifactId: "30000000-0000-4000-8000-000000000002",
        sizeBytes: 512,
      },
      outputParts: [{
        artifactId: "30000000-0000-4000-8000-000000000002",
        displayName: "part-01-of-04.mp4",
        mimeType: "video/mp4",
        sizeBytes: 512,
        checksumSha256: "b".repeat(64),
        partIndex: 1,
        partCount: 4,
      }],
    } satisfies JobSummary;
    render(
      <JobList
        jobs={[multipartJob]}
        projects={[]}
        fetcher={routedFetcher([multipartJob], () => jsonResponse({}, 404))}
      />,
    );

    const row = screen.getByRole("listitem", { name: `Job ${multipartJob.projectName}` });
    expect(within(row).getByText("Uploading output Part 2/4")).toBeVisible();
    expect(within(row).getByText("Output: Chưa sẵn sàng")).toBeVisible();
  });

  it("fetches detail on demand and renders only allowed settings, metadata, telemetry, and actions", async () => {
    const fetcher = routedFetcher([ACTIVE_JOB], () => jsonResponse({ job: DETAIL }));
    render(<JobList jobs={[ACTIVE_JOB]} projects={[]} fetcher={fetcher} />);

    fireEvent.click(screen.getByRole("button", { name: `Xem chi tiết ${ACTIVE_JOB.projectName}` }));

    const panel = await screen.findByRole("dialog", { name: `Chi tiết job ${ACTIVE_JOB.projectName}` });
    expect(fetcher).toHaveBeenCalledWith(
      `/api/v1/jobs/${ACTIVE_JOB.id}`,
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );
    expect(within(panel).getByText("Bản tin nhanh")).toBeVisible();
    expect(within(panel).getByText("BV074_streaming · 1x")).toBeVisible();
    expect(within(panel).getByText("Chia mỗi 120 giây")).toBeVisible();
    expect(within(panel).getByText("source.mp4 · video/mp4 · 1 KB")).toBeVisible();
    expect(within(panel).getByText("part-01-of-02.mp4 · video/mp4 · 512 B")).toBeVisible();
    expect(within(panel).getByText("part-02-of-02.mp4 · video/mp4 · 256 B")).toBeVisible();
    expect(within(panel).getByText("render-node-1 · BUSY")).toBeVisible();
    expect(within(panel).getByText("Đang dựng khung hình")).toBeVisible();
    expect(within(panel).getByText("2 lượt · 1 đang chạy")).toBeVisible();
    expect(panel).not.toHaveTextContent("private raw log");
    expect(panel).not.toHaveTextContent("private-worker-secret");
    expect(panel).not.toHaveTextContent("private-drive-token");
    expect(panel).not.toHaveTextContent("a".repeat(64));
  });

  it("keeps the detail panel open with a recoverable error", async () => {
    const detailResponses = [
      () => jsonResponse({ code: "INTERNAL_ERROR" }, 500),
      () => jsonResponse({ job: DETAIL }),
    ];
    const fetcher = routedFetcher([ACTIVE_JOB], () => (detailResponses.shift() ?? (() => jsonResponse({ job: DETAIL })))());
    render(<JobList jobs={[ACTIVE_JOB]} projects={[]} fetcher={fetcher} />);

    fireEvent.click(screen.getByRole("button", { name: `Xem chi tiết ${ACTIVE_JOB.projectName}` }));
    const panel = await screen.findByRole("dialog", { name: `Chi tiết job ${ACTIVE_JOB.projectName}` });

    expect(within(panel).getByRole("alert")).toHaveTextContent("Chưa thể tải chi tiết job.");
    fireEvent.click(within(panel).getByRole("button", { name: "Thử tải lại chi tiết" }));
    expect(await within(panel).findByText("Bản tin nhanh")).toBeVisible();
  });

  it("confirms cancellation, posts the exact action, and marks only a confirmed request as cancelling", async () => {
    const completedJob = {
      ...ACTIVE_JOB,
      id: "20000000-0000-4000-8000-000000000003",
      projectName: "Video hoàn tất",
      state: "COMPLETED",
      progressPercent: 100,
    } satisfies JobSummary;
    const confirm = vi.spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const fetcher = routedFetcher([ACTIVE_JOB, completedJob], () => jsonResponse({ outcome: "REQUESTED" }));
    render(<JobList jobs={[ACTIVE_JOB, completedJob]} projects={[]} fetcher={fetcher} />);
    const cancel = screen.getByRole("button", { name: `Hủy job ${ACTIVE_JOB.projectName}` });

    expect(screen.queryByRole("button", { name: `Hủy job ${completedJob.projectName}` })).not.toBeInTheDocument();
    fireEvent.click(cancel);
    expect(fetcher).not.toHaveBeenCalledWith(
      `/api/v1/jobs/${ACTIVE_JOB.id}`,
      expect.objectContaining({ method: "POST" }),
    );
    fireEvent.click(cancel);

    expect(confirm).toHaveBeenCalledWith(`Hủy job "${ACTIVE_JOB.projectName}"?`);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      `/api/v1/jobs/${ACTIVE_JOB.id}`,
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ action: "cancel" }),
      }),
    ));
    expect(await screen.findByText("Đang hủy")).toBeVisible();
    expect(screen.queryByRole("button", { name: `Hủy job ${ACTIVE_JOB.projectName}` })).not.toBeInTheDocument();
  });

  it("does not change visible state when cancellation fails", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetcher = routedFetcher([ACTIVE_JOB], () => jsonResponse({ outcome: "NOT_CANCELABLE" }));
    render(<JobList jobs={[ACTIVE_JOB]} projects={[]} fetcher={fetcher} />);

    fireEvent.click(screen.getByRole("button", { name: `Hủy job ${ACTIVE_JOB.projectName}` }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Chưa thể hủy job.");
    expect(screen.getByText("Đang render")).toBeVisible();
    expect(screen.getByRole("button", { name: `Hủy job ${ACTIVE_JOB.projectName}` })).toBeEnabled();
  });

  it("refreshes on mount, polls conservatively with no-store, and lets manual refresh update the retained list", async () => {
    vi.useFakeTimers();
    const refreshedJob = {
      ...ACTIVE_JOB,
      progressPercent: 81,
      etaSeconds: 30,
      updatedAt: "2026-07-25T01:16:00.000Z",
    };
    const listResponses = [
      () => jsonResponse({ jobs: [ACTIVE_JOB] }),
      () => jsonResponse({ jobs: [refreshedJob] }),
      () => jsonResponse({ jobs: [FAILED_JOB] }),
    ];
    const fetcher = vi.fn<typeof fetch>(async () => (listResponses.shift() ?? (() => jsonResponse({ jobs: [FAILED_JOB] })))());
    render(<JobList jobs={[ACTIVE_JOB]} projects={[]} fetcher={fetcher} />);

    // Mount refresh fires immediately; the interval waits the full 15s after it.
    await act(async () => {});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/jobs",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(14_999); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("progressbar", { name: `Tiến độ ${ACTIVE_JOB.projectName}` })).toHaveAttribute("aria-valuenow", "81");

    fireEvent.click(screen.getByRole("button", { name: "Làm mới danh sách job" }));
    // waitFor cannot advance vitest fake timers — flush the fetch chain via act instead
    await act(async () => {});
    expect(screen.getByText(FAILED_JOB.projectName)).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("keeps the last success and backs polling off after an error", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(jsonResponse({ jobs: [FAILED_JOB] }));
    render(<JobList jobs={[ACTIVE_JOB]} projects={[]} fetcher={fetcher} />);

    // The mount refresh fails; the SSR list is retained with a warning.
    await act(async () => {});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getByText(ACTIVE_JOB.projectName)).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Đang giữ danh sách gần nhất");

    // The 15s tick inside the backoff window is skipped…
    await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    // …and the tick 30s after the failure retries.
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByText(FAILED_JOB.projectName)).toBeVisible();
    expect(screen.queryByText(ACTIVE_JOB.projectName)).not.toBeInTheDocument();
    expect(screen.queryByText("Đang giữ danh sách gần nhất")).not.toBeInTheDocument();
  });

  it("pauses polling while hidden and closes the detail sheet with Escape while restoring focus", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const fetcher = routedFetcher([ACTIVE_JOB], () => jsonResponse({ job: DETAIL }));
    render(<JobList jobs={[ACTIVE_JOB]} projects={[]} fetcher={fetcher} />);
    const detailButton = screen.getByRole("button", { name: `Xem chi tiết ${ACTIVE_JOB.projectName}` });
    detailButton.focus();
    fireEvent.click(detailButton);
    // findByRole's waitFor cannot advance vitest fake timers — flush the fetch chain via act instead
    await act(async () => {});
    const panel = screen.getByRole("dialog", { name: `Chi tiết job ${ACTIVE_JOB.projectName}` });
    expect(within(panel).getByRole("button", { name: "Đóng chi tiết" })).toHaveStyle({ minHeight: "44px", minWidth: "44px" });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(detailButton).toHaveFocus();

    visibility = "hidden";
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    // Only the mount refresh and the detail fetch — hidden-tab ticks never fire.
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
