# Thiết kế — YouTube workbench: kết nối kênh, số liệu, và bàn biên soạn metadata

Ngày: 2026-07-27 · Nhánh: `rebuild/v2`

Bổ sung một surface **YouTube** vào control plane: nối các kênh của người vận hành để xem số
liệu nhanh, giữ prompt riêng cho từng kênh, và một **bàn biên soạn** giúp soạn toàn bộ thông tin
cần thiết cho mỗi video đã render xong. Việc đăng video vẫn làm thủ công trên YouTube Studio.

---

## 1. Bối cảnh và quyết định phạm vi

### 1.1 Vì sao không đăng tự động

YouTube Data API có `videos.insert` kèm `status.publishAt`, đủ để đăng và hẹn giờ hoàn toàn tự
động — YouTube tự chuyển video từ private sang public đúng giờ, control plane không cần cron.
Nhưng Google ràng buộc:

> All videos uploaded via the `videos.insert` endpoint from unverified API projects created after
> 28 July 2020 will be restricted to private viewing mode.

Gỡ ràng buộc này phải qua **compliance audit** — nộp [YouTube API Services – Audit and Quota
Extension Form](https://support.google.com/youtube/contact/yt_api_form), Google review thủ công,
**không cam kết thời hạn**. Người vận hành quyết định **không phụ thuộc vào lịch duyệt của
Google**, chấp nhận đăng thủ công.

Hệ quả kiến trúc: **không xin scope ghi nào của YouTube trong vòng này.** Không `youtube.upload`,
không `youtube.force-ssl`. Chỉ đọc.

### 1.2 Vì sao vẫn cần OAuth

Số liệu kênh chia làm hai nguồn không thay thế được nhau:

| Nguồn | Cần gì | Cho gì |
|---|---|---|
| Data API | API key | avatar, tên, `subscriberCount`, `viewCount` tổng, `videoCount`, view từng video |
| Analytics API | OAuth `yt-analytics.readonly` | **giờ xem**, thời lượng xem trung bình, sub tăng/giảm, cắt lát theo video/ngày/quốc gia |

Yêu cầu "tổng số giờ xem" chỉ Analytics API có. Nên bắt buộc OAuth — nhưng **read-only**, không
đụng tới audit, và token bị lộ cũng không phá được kênh.

### 1.3 Không làm trong vòng này

- Đăng video tự động, hẹn giờ đăng, và mọi thứ chạm `videos.insert`
- Xếp lịch đăng (người vận hành đã bỏ khỏi phạm vi)
- Sinh ảnh thumbnail bằng API trả phí — không model sinh ảnh nào của Google có free tier
- Điều khiển ChatGPT bản web bằng robot trình duyệt — vi phạm Terms of Use của OpenAI, cần lưu
  cookie phiên (tương đương chìa khoá tài khoản), và vỡ mỗi lần đổi giao diện
- Số liệu doanh thu (`yt-analytics-monetary.readonly`)
- Biểu đồ tăng trưởng và cắt lát người xem — hoãn tới khi biết thực sự cần lát nào

---

## 2. Kiến trúc tổng thể

Năm mảnh, ghép vào đúng các đường đã có, không phá bất biến nào.

```
Worker (GPU VPS, Python)
  └─ render xong ─┬─ xuất bản dịch  ─→ Drive: artifact TRANSCRIPT
                  └─ trích 8 frame  ─→ Drive: artifact THUMB_CANDIDATE
                        (qua aux-session, cùng pattern fenced lease của output-session)

Control plane (Next.js / Vercel)
  ├─ YouTube OAuth read-only ─→ youtube_channels (refresh token mã hoá)
  ├─ Data API + Analytics API ─→ youtube_channel_stats (snapshot)
  ├─ đọc TRANSCRIPT từ Drive ─→ Gemini 3.5 Flash Lite ─→ publication_drafts
  └─ surface YouTube + surface Publish

Người vận hành
  └─ copy tiêu đề/mô tả/tag · tải frame về · dán prompt sang ChatGPT hoặc AI Studio
     · tải output từ Drive · đăng tay trên Studio · đánh dấu đã đăng
```

**Bất biến được giữ nguyên:** control plane không nhận byte video. TRANSCRIPT là text, chặn cứng
2 MB. Frame JPEG đi thẳng worker → Drive. Người vận hành tải file từ Drive về máy mình.

---

## 3. Mảnh A — Kết nối kênh YouTube

### 3.1 Scope

```
https://www.googleapis.com/auth/youtube.readonly
https://www.googleapis.com/auth/yt-analytics.readonly
```

Cả hai chỉ đọc. Đặt thành hằng trong `lib/domain/youtube.ts`, kiểm tra scope trả về đúng như
`validateRefreshResponse` trong adapter Drive đang làm.

### 3.2 Nhiều kênh

`oauth_credentials` hiện tại **không dùng lại được**: nó khoá `id smallint check (id = 1)` (đúng
một dòng) và CHECK ép `scope = 'https://www.googleapis.com/auth/drive.file'`. YouTube cần nhiều
dòng, scope khác.

Bảng mới `youtube_channels`, mỗi kênh một dòng, refresh token mã hoá bằng chính
`lib/security/credential-cipher.ts` nhưng với khoá riêng `YOUTUBE_TOKEN_KEY_V1` — tách khoá để lộ
khoá Drive không kéo theo YouTube và ngược lại.

Mỗi lần "Thêm kênh" là một lần cấp quyền riêng. Sau khi đổi code, gọi ngay
`channels.list?part=snippet,statistics&mine=true` để biết vừa nối kênh nào và upsert theo
`channel_id`.

### 3.3 Tái dùng và sửa có mục tiêu

`createGoogleOAuthAdapter` đang hardcode `DRIVE_FILE_SCOPE` ở hai chỗ:
`oauth.ts:181` (`buildAuthorizationUrl`) và `oauth.ts:140` (`validateRefreshResponse`). Sửa thành
**tham số `scopes` bắt buộc** truyền từ lời gọi. Riêng chỗ `oauth.ts:140` hiện khẳng định
`scopes.length !== 1` — phải đổi thành so khớp tập hợp, vì YouTube cần đúng hai scope. Đường Drive
truyền `[DRIVE_FILE_SCOPE]` nên hành vi không đổi, có test hiện hành bảo vệ. Đây là sửa tối thiểu
để dùng chung, không phải refactor rộng.

Tái dùng nguyên: `lib/security/oauth-state.ts`, `oauth_states`, `lib/adapters/google/http.ts`.

### 3.4 Cái bẫy vận hành phải ghi vào README

Google Cloud project để publishing status **"Testing"** thì:

> A Google Cloud Platform project with an OAuth consent screen configured for an external user type
> and a publishing status of "Testing" is issued a refresh token expiring in 7 days

Nghĩa là mỗi tuần phải nối lại toàn bộ kênh. **Bắt buộc chuyển app sang "In production".** Không
cần Google verify — chỉ hiện màn hình "app chưa được xác minh", bấm qua được vì là app của chính
chủ — nhưng phải ở trạng thái production thì refresh token mới sống lâu.

---

## 4. Mảnh B — Surface YouTube

### 4.1 Danh sách kênh

Mỗi kênh một thẻ: avatar, tên, số sub, tổng view, tổng giờ xem, số video, thời điểm làm mới gần
nhất. Nút **Thêm kênh**, nút **Làm mới**, nút **Ngắt kết nối** (revoke refresh token rồi xoá).

Nhãn cạnh số sub phải ghi rõ **"đã làm tròn"** — xem §10.

### 4.2 Chi tiết một kênh

- **Top 5 video nhiều view nhất** — thumbnail, tiêu đề, view, link mở video
- **Tab Prompt** — nơi khai bộ khuôn soạn thảo riêng của kênh đó:
  - `title_prompt` — system prompt đặt tiêu đề
  - `description_prompt` — system prompt viết mô tả
  - `description_template` — phần cố định (link, hashtag, CTA) ghép vào mô tả
  - `default_tags` — tag mặc định
  - `thumbnail_prompt_template` — khuôn prompt mang sang ChatGPT / AI Studio

### 4.3 Lấy số liệu

| Cần | Gọi | Giá |
|---|---|---|
| avatar, tên, sub, view, số video | `channels.list?part=snippet,statistics&mine=true` | 1 |
| id uploads playlist | `channels.list?part=contentDetails` (gộp cùng trên) | 0 |
| danh sách video | `playlistItems.list` trên uploads playlist | 1 / 50 video |
| view từng video | `videos.list?part=statistics` | 1 / 50 video |
| tổng giờ xem | Analytics `reports.query`, `metrics=estimatedMinutesWatched` | riêng |

Top 5 lấy từ **Data API** (view toàn thời gian) rồi sắp xếp tại chỗ — không dùng
`search.list` (100 unit, và quota mặc định chỉ 100 lượt/ngày), cũng không dùng Analytics
(chỉ trả số liệu trong khoảng ngày, không phải toàn thời gian).

Tổng giờ xem query khoảng ngày từ **ngày tạo kênh** (`snippet.publishedAt` trả về ngay trong lượt
`channels.list` ở trên, không tốn thêm lượt gọi) đến hôm nay.

**Ngân sách quota:** 10 kênh × 200 video ≈ 90 unit mỗi lượt làm mới. Trần 10.000 unit/ngày cho
phép làm mới mỗi giờ vẫn thừa. Snapshot ghi vào `youtube_channel_stats`; trang đọc snapshot, **không
gọi API mỗi lần load**.

---

## 5. Mảnh C — Worker sinh nguyên liệu

Render xong, trước khi báo hoàn thành, worker làm thêm hai việc.

### 5.1 Xuất bản dịch

`Timeline` đã giữ sẵn `Cue.target_text`. Xuất ra một file text phẳng, upload Drive như artifact
`kind='TRANSCRIPT'`. Cỡ vài trăm KB.

### 5.2 Trích frame ứng viên

Tách hai lớp đúng kiến trúc hexagonal đang có.

**`src/ytb_vps_v2/domain/thumbnail_frames.py`** — hàm thuần, không đụng video, không đụng đĩa:

```python
def pick_candidate_frames(
    duration_frames: int,
    fps: float,
    cues: Sequence[Cue],
    blur_regions: Sequence[BlurRegion],
    count: int = 8,
) -> list[int]
```

Luật chọn:

1. Bỏ 5% đầu và 8% cuối thời lượng — tránh intro và credit
2. Loại mọi frame nằm trong bất kỳ `Cue.interval` hoặc `BlurRegion.interval` — pipeline đã biết
   **chính xác** lúc nào màn hình có phụ đề gốc và logo, nên frame chọn ra là nền sạch, không
   phải đoán và không phải chạy thêm OCR
3. Chia phần còn lại thành `count` khoảng đều nhau; mỗi khoảng lấy điểm giữa của khe sạch dài nhất

Đây là lợi thế riêng của dự án: thông tin để chọn frame sạch đã được tính sẵn trong pipeline.

**Adapter FFmpeg** — trích đúng các frame index đó từ **video nguồn** (không phải output: output đã
bị đè phụ đề tiếng Việt và vùng blur), chấm điểm rồi giữ 8 tấm tốt nhất:

- loại frame quá tối hoặc cháy sáng (mean luma ngoài ngưỡng)
- loại frame nhoè (đo độ nét, bỏ frame dính motion blur)
- cộng điểm cho frame có mặt người — OpenCV đã có sẵn trong môi trường OCR nên detector gần như
  miễn phí

Upload JPEG lên Drive như artifact `kind='THUMB_CANDIDATE'`.

### 5.3 Đường lên Drive

Endpoint mới `POST /api/v1/worker/jobs/:id/aux-session`, dựng theo đúng khuôn của
`web/src/app/api/v1/worker/jobs/[id]/output-session/route.ts`: xác thực worker session, kiểm
`getFencedExecution` với fencing token, cấp resumable session URI, worker đẩy byte. Khác duy nhất
là nhận thêm `kind` (`TRANSCRIPT` | `THUMB_CANDIDATE`) và cho phép nhiều artifact
`THUMB_CANDIDATE` trên một job.

File nhỏ nên **không đi qua** `reserve_drive_upload_capacity` — cơ chế đó dành cho video nguồn cỡ
GB. Vẫn ghi vào `artifacts` để dọn dẹp và kiểm kê hoạt động bình thường.

---

## 6. Mảnh D — Composer

`POST /api/v1/publications/:jobId/compose`:

1. Đọc artifact TRANSCRIPT của job từ Drive. Cần thêm `readTextFile` vào `DriveFilesPort`
   (`files.get?alt=media`), **chặn cứng 2 MB**.
2. **Rút gọn trước khi gửi.** Phim hai tiếng có thể ra 200 KB text. Gộp cue, bỏ câu trùng, lấy mẫu
   đều theo timeline đến một ngân sách ký tự cấu hình được. Vừa nhanh vừa đủ để đặt tiêu đề.
3. Gọi `gemini-3.5-flash-lite` bằng `fetch` qua helper kiểu `googleJson` — **không thêm package
   npm nào**, đúng cách dự án đang gọi Google API. Dùng `responseSchema` ép JSON có cấu trúc:
   **3 phương án tiêu đề**, mô tả, danh sách tag.
   System prompt lấy từ `youtube_channels` của kênh đã chọn.
4. Ghi vào `publication_drafts`.

Route phải khai `export const maxDuration = 60`. `vercel.json` hiện không cấu hình `functions`
nên đang ăn mặc định — một cú Gemini vài chục nghìn token sẽ vượt.

`GEMINI_API_KEY` chỉ đọc ở server, không bao giờ xuống client.

**Chi phí:** `gemini-3.5-flash-lite` có free tier. Trả phí là $0.30 / 1M token vào và $2.50 / 1M
token ra — mỗi video vài nghìn token, coi như bằng không.

---

## 7. Mảnh E — Surface Publish

Danh sách video đã render xong chưa đăng. Mở một video ra:

- Chọn kênh → nút **Soạn bằng AI** → 3 tiêu đề để chọn, mô tả, tag
- Mỗi ô có **bộ đếm ký tự theo giới hạn YouTube** (tiêu đề 100, mô tả 5000, tổng tag 500) và nút copy
- Lưới 8 frame ứng viên → chọn 1 → nút tải về
- Ô prompt thumbnail đã ghép sẵn tên phim và số tập → nút copy
- Nút **Mở Studio** — deeplink `studio.youtube.com/channel/<CHANNEL_ID>/videos/upload`
- Nút **Đánh dấu đã đăng** + ô dán link video

Deeplink chỉ mở đúng trang. YouTube **không có tham số URL nào để điền sẵn metadata** — đó là lý
do mọi ô đều phải có nút copy.

---

## 8. Mô hình dữ liệu — migration v11

### 8.1 Nới `artifacts.kind`

Theo đúng khuôn migration v3 đã dùng với `artifacts_status_check`:

```sql
do $$ begin
  if not exists(select 1 from schema_migrations where version = 11) then
    alter table artifacts drop constraint if exists artifacts_kind_check;
    alter table artifacts add constraint artifacts_kind_check check (
      kind in ('SOURCE','CHECKPOINT','OUTPUT','TRANSCRIPT','THUMB_CANDIDATE')
    );
  end if;
end $$;
```

Index `artifacts_one_live_output_per_job_idx` lọc `where kind='OUTPUT'` nên nhiều
`THUMB_CANDIDATE` trên cùng một job không đụng gì.

### 8.2 `youtube_channels`

Một dòng mỗi kênh. Giữ cả credential lẫn bộ prompt của kênh đó.

- `id` uuid · `channel_id` text unique (dạng `UC…`) · `title` · `avatar_url`
- `status` ∈ `CONNECTED` | `REAUTH_REQUIRED` | `DISCONNECTED`
- `ciphertext` / `nonce` / `auth_tag` / `key_version` / `scope` — cùng khuôn CHECK như
  `oauth_credentials`: `CONNECTED` thì bốn trường phải có, `nonce` 12 byte, `auth_tag` 16 byte;
  `DISCONNECTED` thì phải null hết
- `title_prompt` · `description_prompt` · `description_template` · `default_tags` jsonb ·
  `thumbnail_prompt_template`
- `created_at` · `updated_at`

### 8.3 `youtube_channel_stats`

Snapshot mới nhất, một dòng mỗi kênh — không lưu chuỗi thời gian ở vòng này.

- `channel_id` PK → `youtube_channels(id)`
- `subscriber_count` · `view_count` · `video_count` · `watch_hours`
- `top_videos` jsonb (5 phần tử: videoId, title, thumbnailUrl, viewCount), giới hạn `pg_column_size`
- `observed_at` · `updated_at`

### 8.4 `publication_drafts`

Một dòng mỗi job đã render xong.

- `id` uuid · `job_id` unique → `jobs(id)` · `channel_id` → `youtube_channels(id)`
- `title` · `description` · `tags` jsonb · `thumbnail_prompt`
- `chosen_thumb_artifact_id` → `artifacts(id)`
- `status` ∈ `DRAFT` | `READY` | `PUBLISHED`
- `youtube_video_url` · `composed_at` · `published_marked_at`
- `created_at` · `updated_at`

Ràng buộc độ dài theo giới hạn YouTube ngay ở tầng DB: `title` ≤ 100, `description` ≤ 5000.

### 8.5 Áp lực lên Neon

`NEON_STORAGE_LIMIT_BYTES` đang đặt 512 MB. Ba bảng mới đều là hàng chục đến hàng trăm dòng, vài
KB mỗi dòng. Không đáng kể. Đây cũng là lý do chưa lưu chuỗi thời gian.

---

## 9. Biến môi trường

```
YOUTUBE_TOKEN_KEY_V1=<base64url 32 byte>   # khoá mã hoá refresh token YouTube, TÁCH khỏi Drive
GEMINI_API_KEY=<khoá Gemini API>            # chỉ server
```

Cả hai thêm vào `parseServerEnv` trong `lib/config/env.ts` với cùng kiểu kiểm tra đang có.

---

## 10. Giới hạn đã biết — phải hiển thị cho người dùng, không được giấu

**Số sub bị làm tròn.** Từ 09/2019 Data API làm tròn xuống 3 chữ số có nghĩa với mọi kênh trên
1000 sub: 123.456 sub → API trả về `123000`. Số thật chỉ có trong Studio. Không có đường vòng.
UI phải ghi rõ "đã làm tròn".

**CTR của thumbnail không lấy được.** Analytics API không có `impressions` và
`impressionClickThroughRate` — đó là metric độc quyền Studio. Metric tên `adImpressions` trong API
là impression *quảng cáo*, hoàn toàn khác. Muốn đo thumbnail nào ăn click vẫn phải mở Studio.

**Không có trường "tổng giờ xem toàn thời gian".** Analytics API luôn hỏi theo khoảng ngày; tổng
phải tự query từ ngày tạo kênh đến hôm nay.

**Hai nguồn số liệu không trộn được.** `viewCount` (Data API) là tổng view toàn thời gian, chính
xác. Giờ xem (Analytics API) theo khoảng ngày. Không cộng chéo, không suy ra nhau.

**Prompt sinh thumbnail không đảm bảo dấu tiếng Việt.** Mọi model sinh ảnh đều yếu ở dấu chồng
dấu (`ế`, `ữ`, `ộ`). Hệ thống chỉ soạn prompt và đưa frame; chất lượng chữ do người vận hành kiểm
tra bằng mắt.

---

## 11. Kiểm thử

| Đơn vị | Cách test |
|---|---|
| `pick_candidate_frames` | hàm thuần — fixture cue/blur, **không cần file video**; ca biên: không có khe sạch, cue phủ kín, video ngắn hơn vùng cắt |
| Adapter FFmpeg trích frame | clip fixture ngắn đã có trong `tests_v2/` |
| Adapter YouTube Data / Analytics | stub fetcher đúng khuôn `lib/adapters/google/oauth.test.ts` |
| Adapter Gemini | stub fetcher; khẳng định `responseSchema` được gửi và JSON sai thì báo lỗi rõ |
| `readTextFile` | khẳng định chặn cứng 2 MB |
| Migration v11 | pglite, chạy **hai lần** để xác nhận idempotent (đúng lệ dự án) |
| Route mới | đúng khuôn các route hiện có, gồm ca thiếu quyền và ca mất lease |
| Component | testing-library, đúng khuôn component hiện có |

---

## 12. Thứ tự thi công

Mỗi bước kết thúc bằng một trạng thái chạy được, test xanh, một commit.

1. **Migration v11 + domain constants** — ba bảng mới, nới `artifacts.kind`, hằng scope và giới hạn
   trường YouTube. Chưa có UI.
2. **OAuth read-only** — tham số hoá `scopes` cho `createGoogleOAuthAdapter`; route
   connect/callback/disconnect; lưu kênh. Kiểm chứng bằng một kênh thật.
3. **Surface YouTube, phần số liệu** — Data API + Analytics API, snapshot, nút làm mới, thẻ kênh,
   top 5 video.
4. **Tab Prompt theo kênh** — lưu và sửa bộ khuôn soạn thảo.
5. **Worker sinh nguyên liệu** — `pick_candidate_frames`, adapter trích frame, xuất bản dịch,
   endpoint `aux-session`.
6. **Composer + surface Publish** — `readTextFile`, adapter Gemini, route compose, giao diện biên
   soạn với đếm ký tự, chọn frame, nút copy, đánh dấu đã đăng.

Bước 1–4 và bước 5–6 độc lập nhau về file; có thể làm song song sau khi bước 1 xong.

---

## 13. Nguồn

- [videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert) — ràng buộc private với project chưa audit
- [Quota and Compliance Audits](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits)
- [channels.list](https://developers.google.com/youtube/v3/docs/channels/list)
- [Analytics metrics](https://developers.google.com/youtube/analytics/metrics) · [Analytics dimensions](https://developers.google.com/youtube/analytics/dimensions)
- [OAuth 2.0 — hết hạn refresh token](https://developers.google.com/identity/protocols/oauth2)
- [Gemini models](https://ai.google.dev/gemini-api/docs/models) · [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)
