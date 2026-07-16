# 01 — Sửa ngay (blocker + 8 lỗi nghiêm trọng)

Các lỗi này khiến **code không chạy được, mất dữ liệu, giảm chất lượng âm thầm, hoặc lộ credential**.
Sửa trước mọi thứ khác, theo đúng thứ tự trong file này.

---

## 1.0. 🔴 BLOCKER — Code hiện tại KHÔNG chạy được (refactor dở dang)

**Triệu chứng:** `python -c "import ytb_vps.pipeline"` chết ngay:
`ImportError: cannot import name 'run_static_ocr_samples' from 'ytb_vps.ocr'`.
Daemon/queue/pipeline đều không khởi động được. Test suite: 8 FAIL + 9 ERROR
(1 ERROR là module test không import nổi — xem [07-KIEM-THU.md](07-KIEM-THU.md)).

**Gốc rễ:** Ai đó đã refactor nhiều file cùng lúc nhưng chỉ commit... không, **không có git** —
nên chỉ còn lại một cây code nửa cũ nửa mới, không diff được. Có 5 mảnh vỡ độc lập:

### 1.0a. `run_static_ocr_samples` không tồn tại

- `pipeline.py:22` import nó từ `ocr.py`; `pipeline.py:337-351` gọi nó và truyền kết quả
  vào `build_static_blur_regions(..., static_detections=static_ocr["detections"])`.
- `ocr.py` **không có** hàm này; `subtitles.py:337` (`build_static_blur_regions`)
  **không nhận** tham số `static_detections` (signature thật: `store, job_id, *, media, ocr_config, tracking_config`).

**Hai cách khôi phục (chọn 1):**
- **A — Nhanh (khuyến nghị để chạy lại được ngay):** bỏ import ở `pipeline.py:22`,
  bỏ block `static_ocr = run_static_ocr_samples(...)` (dòng 337-343), bỏ kwarg `static_detections=`
  (dòng 350) và block record artifact `static-full-frame-ocr` (dòng 367-373).
  `build_static_blur_regions` bản trong `subtitles.py` tự đọc detections từ SQLite — vẫn phát hiện
  watermark tĩnh vì OCR mặc định quét full khung hình (`scan_min_y_ratio: 0.0`, `scan_max_y_ratio: 1.0`).
- **B — Hoàn thành đúng ý đồ refactor:** viết `run_static_ocr_samples` trong `ocr.py`:
  sample ~10 frame trải đều toàn phim, OCR **full frame** (không crop dải phụ đề), trả về
  `{"detections": [...], "path": Path|None, "checksum": str}` + ghi JSONL artifact;
  sửa `build_static_blur_regions` nhận `static_detections` thay vì đọc store.
  Ý đồ: bắt watermark ngoài dải quét khi người vận hành thu hẹp `scan_min/max_y_ratio` để OCR nhanh hơn.
  Chỉ làm B khi đã có git + test xanh.

### 1.0b. `JobStore` thiếu 4 method mà TRANSLATE gọi

- `translation.py` gọi `store.translation_prepass(job_id, name)` / `store.set_translation_prepass(...)`
  ở ~10 chỗ (dòng 796, 815, 828, 848, 871, 880, 904, 925, 933, 946, 976, 985, 1055),
  **và** `store.clear_translations(job_id, cue_indices)` (dòng 855, 983) +
  `store.invalidate_translation_outputs(job_id)` (dòng 984).
- `state.py` **không có cả 4 method** (kiểm chứng vòng 3 bằng `hasattr` trên JobStore),
  cũng không có bảng SQLite nào lưu prepass.
- Hậu quả: sau khi sửa 1.0a, stage TRANSLATE sẽ chết bằng `AttributeError` ngay lập tức.

**Spec khôi phục** (theo đúng cách caller đang dùng):
```sql
CREATE TABLE IF NOT EXISTS translation_prepasses (
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    name TEXT NOT NULL,                -- 'translation' | 'story-bible' | 'hook'
    source_fingerprint TEXT NOT NULL,
    prompt_revision INTEGER NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL,              -- 'RUNNING' | 'READY' | 'FALLBACK' | 'ORIGINAL'
    payload_json TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (job_id, name)
);
```
- `translation_prepass(job_id, name) -> dict | None` — trả dict có key
  `source_fingerprint, prompt_revision, model, status, payload` (payload = JSON đã parse, có thể None).
- `set_translation_prepass(job_id, name, *, source_fingerprint, prompt_revision, model, status, payload)`
  — UPSERT (`INSERT ... ON CONFLICT(job_id, name) DO UPDATE`), commit ngay (pattern như `record_artifact`).
- `clear_translations(job_id, cue_indices)` — `UPDATE cues SET target_text = NULL WHERE job_id = ?
  AND cue_index IN (...)`; nhận list rỗng thì no-op (caller dòng 855 truyền list rỗng khi hook
  không có replacement).
- `invalidate_translation_outputs(job_id)` — vô hiệu sản phẩm hạ nguồn của bản dịch khi dịch lại
  từ đầu: reset stage TTS/RENDER về PENDING + đánh dấu tts_groups PENDING (dùng `reset_stage`
  có sẵn; gọi khi fingerprint dịch đổi — dòng 984).
- Thêm `CREATE TABLE` vào biến `SCHEMA` — `executescript` với `IF NOT EXISTS` tự migrate DB cũ.

### 1.0c. File prompt nguồn bị mất

- `translation.py:84-94` (`_prompt_source_path`) bắt buộc tìm thấy
  `prompt_dich_sub_trung_ke_chuyen.txt` (ở root repo, CWD, hoặc đường dẫn config `translation.prompt_source`).
- File này **không có trong cây** → mọi lệnh dịch (kể cả `doctor --live` codex check) raise
  `TranslationError` ngay khi dựng prompt.
- Format bắt buộc (xem `_prompt_sections`, dòng 97-107): file text chứa 4 section bọc marker HTML comment:
  `<!-- VPS_ADAPTER_COMMON_START -->...<!-- VPS_ADAPTER_COMMON_END -->`, tương tự cho
  `BIBLE`, `HOOK`, `TRANSLATE`.
- **Cách sửa:** tìm lại file gốc (backup/Drive/máy khác). Nếu mất hẳn: viết lại 4 section
  (COMMON = vai trò + giọng văn dịch phim; TRANSLATE = quy tắc dịch cue; BIBLE = quy tắc rút story bible;
  HOOK = quy tắc viết hook mở đầu), đặt ở root, và **commit vào git** (nó là code, không phải secret).
  Sau khi có file, 3 test trong `test_translation` sẽ xanh lại — dùng chúng làm gate.

### 1.0d. Chế độ `scene_voiceover` không được nối dây

- Config validate mode này (`config.py:266-267`), queue lưu `pipeline_mode` vào DB (`queue.py:492`),
  module `scene_voiceover.py` (299 dòng) + test đầy đủ — nhưng `pipeline.py` **không có chữ nào**
  nhắc tới scene/voiceover/pipeline_mode. Đặt `mode: scene_voiceover` → hệ thống **im lặng chạy chế độ cũ**.
- **Cách sửa tối thiểu:** trong lúc chưa nối dây, thêm guard: nếu `pipeline_mode == "scene_voiceover"`
  thì raise lỗi rõ ràng "chưa được hỗ trợ trong pipeline" thay vì im lặng chạy sai chế độ.
  Nối dây thật (branch trong `_translate`/`_tts` gọi `scene_voiceover.write_scenes/synthesize_scenes/
  display_cues/audio_groups`) làm sau khi suite xanh.

### 1.0e. Backend OCR Docker vỡ giao ước tham số với runner (phát hiện vòng cross-review)

- `ocr.py:137-145` **luôn** truyền `--x-scale/--y-scale/--x-offset/--y-offset` cho mọi worker
  (đây là phần mới của refactor: OCR quét vùng crop+downscale rồi worker nhân/dịch tọa độ về khung nguồn).
- Worker ONNX (`containers/ocr-onnx/worker.py:116-119`) **có** khai báo 4 tham số này — khớp.
- Worker Docker legacy (`containers/ocr-legacy/worker.py:58-71`) **KHÔNG có** → argparse thoát ngay
  khi gặp `--x-scale`. Backend `docker` (mặc định khi không có ONNX, `ocr.py:29`) chết 100% ngay
  chunk OCR đầu tiên. Kể cả thêm 4 args vào parser, worker legacy vẫn thiếu bước **scale tọa độ
  về khung nguồn** mà worker ONNX đã làm — box sẽ sai vị trí (blur/cue lệch).
- **Cách sửa:** đồng bộ parser + phép biến đổi tọa độ của worker legacy theo đúng worker ONNX
  (copy phần đó — chúng cùng giao ước JSONL); thêm **contract test host↔container**: chạy cả hai
  worker ở chế độ `--smoke` với đủ bộ args mà `ocr.py` phát ra, so schema JSONL đầu ra.
  Docker image phải rebuild sau khi sửa `worker.py` (COPY vào image lúc build, không mount).

**Kiểm tra chung cho §1.0:** `python -c "import ytb_vps.pipeline"` chạy sạch;
`PYTHONPATH="app;." python -m unittest tests.test_pipeline_resume tests.test_translation` không còn ERROR
(failure logic riêng xử lý theo [07-KIEM-THU.md](07-KIEM-THU.md)).

---

## 1.1. Chưa có git repository

**Triệu chứng:** `git status` → "not a git repository". ~11.500 dòng code không có version control.

**Tại sao nghiêm trọng:** §1.0 chính là hậu quả trực tiếp — refactor nửa chừng mà không ai biết
đã đổi gì, mất gì, không rollback được. Đây là lỗi đắt nhất repo này đã phải trả.

**Cách sửa:**
1. Sửa mục 1.3 (credential) **trước** — không được để credential lọt vào lịch sử git.
2. `.gitignore` hiện đã có (`secrets/`, `.venv/`...) — thêm: `capcut-devices/`, `*.patch`, `patch*.txt`.
3. `git init` → `git add -A` → xem lại `git status` đảm bảo không có file credential → commit đầu tiên
   **ngay trạng thái hiện tại** (kể cả đang hỏng) — để mọi sửa chữa §1.0 có diff.

**Kiểm tra:** `git log` có commit; `git ls-files | grep -i capcut` trả về rỗng.

---

## 1.2. ~~File `.patch` hỏng ở root~~ — ĐÃ DỌN (vòng audit 3); giữ lại bài học

**Đã xử lý:** `.patch`, `patch1.txt` (patch mồ côi), `PROGRESS.md`, `IMPLEMENTATION.md`
(2 file status cũ ghi "implementation complete, 16 tests passed" — sai với thực tế §1.0,
gây nhiễu cho người/AI đọc sau) đã bị xoá khỏi root trong vòng audit 3. Root giờ chỉ còn
`DESIGN.md` + 2 script thử nghiệm OCR (xử lý theo [03](03-NANG-CAP-OCR.md) cuối file).

**Bài học giữ lại từ nội dung `.patch` (trước khi xoá):**
1. Nó gọi hàm `_responses_api_call(...)` **không tồn tại** — nếu đã apply sẽ gây `NameError`
   bị nuốt im lặng ở story-bible/hook (`translation.py:812-826` nuốt exception, ghi `FALLBACK`
   dính vĩnh viễn vì `_matching_prepass` không phân biệt READY/FALLBACK).
2. Ý định của nó — gọi thẳng OpenAI API khi có `OPENAI_BASE_URL`+`OPENAI_API_KEY` thay vì Codex CLI —
   là phương án B hợp lý cho dịch (xem [08](08-LO-TRINH-SAN-PHAM.md) rủi ro #3). Nếu làm lại:
   định nghĩa `_responses_api_call` hoàn chỉnh (retry/backoff, `timeout_seconds`), vá **cả**
   `_run_prompt` lẫn `_run_json`, thêm `"engine": "api"|"cli"` vào cache signature.
3. Hunk `tts.py` của nó đặt `apply_tts_text_overrides(..., enabled: bool = True)` — bằng chứng
   người refactor định để default True (dùng cho quyết định [07](07-KIEM-THU.md) §7.2).

---

## 1.3. 96 file credential CapCut nằm trong project root

**Triệu chứng:** `capcut-devices/` chứa `device-021.json` … `device-116.json` — **96 file**
(kiểm đếm lại vòng cross-review; con số 45 ở bản audit trước đã lỗi thời), mỗi file một bộ
định danh thiết bị CapCut (device_id, iid, tdid...). `.gitignore` hiện tại **không** có dòng
`capcut-devices/`.

**Gốc rễ:** `CapCutDevicePool._discover_paths` (`tts.py:338-360`) tự quét thư mục `capcut-devices/`
**cạnh file `device_json`** đã cấu hình. Ai đó đặt pool ngay trong project cho tiện.

**Tại sao nghiêm trọng:** Vi phạm chính DESIGN.md §11 của dự án (credential phải ngoài source tree,
mode 0700). Copy/zip/sync project là mang theo 96 credential. `git init` mà quên ignore → lộ vĩnh viễn.
Nếu thư mục này đã từng được copy/chia sẻ ra ngoài, coi như đã lộ → **rotate/thu hồi** các device
identity đó thay vì chỉ di chuyển.

**Cách sửa:**
1. Di chuyển ra cạnh secrets: `/root/.config/ytb-vps/secrets/capcut-devices/` (VPS),
   thư mục tương ứng ngoài project trên máy dev. Discovery tự tìm thư mục cạnh `device_json`,
   hoặc set tường minh `tts.device_pool_dir`.
2. Thêm `capcut-devices/` vào `.gitignore` như lớp bảo hiểm.

**Kiểm tra:** `ls capcut-devices/` ở root báo không tồn tại; TTS smoke (`doctor --live`) vẫn thấy pool.

---

## 1.4. Phim dài hơn 4 giờ mất "story bible" — trong khi mục tiêu là phim 6 giờ

**Gốc rễ:** `translation.py:807-811`:
```python
if (
    len(cues) <= int(config.get("story_bible_max_cues", 5000))
    and duration <= float(config.get("story_bible_max_seconds", 14400))   # 14400s = 4 giờ
):
```
Video 6h (21.600s) > 14400 → **bỏ qua** story bible, ghi `FALLBACK`. Vì `_matching_prepass`
khớp cả row FALLBACK → các lần chạy sau **không bao giờ thử lại**. Phim 6h cũng thường >5000 cue.

**Story bible là gì:** prepass Codex đọc toàn bộ thoại → tóm tắt + nhân vật + quan hệ + thuật ngữ +
quy tắc dịch. Là cơ chế **duy nhất** giữ tên nhân vật nhất quán xuyên phim (cơ chế thứ hai —
context trượt — đang hỏng, xem 1.5).

**Cách sửa:**
1. Nâng default (`story_bible_max_seconds: 25200`, `story_bible_max_cues: 9000`) — hoặc tốt hơn:
   vượt ngưỡng thì **sample cues đều theo thời lượng** xuống còn max_cues rồi vẫn build
   (code đã chunk 350 cue/lần).
2. Sửa tính "dính": row `FALLBACK` được phép thử lại ở lần chạy sau (chỉ `READY` là chốt).
3. Thêm 2 key vào `config/config.example.yaml` (hiện hoàn toàn ẩn).

**Kiểm tra:** job giả lập duration > 14400s tạo được story bible; row FALLBACK cũ tự thử lại → READY.

---

## 1.5. Context dịch bị "đứng hình" trong một lần chạy

**Triệu chứng:** Prompt dịch gửi kèm 12 cue lân cận **cùng bản dịch Việt đã có** để giữ nhất quán
xưng hô — nhưng trường tiếng Việt trong context luôn rỗng ở lần chạy đầu.

**Gốc rễ:** `translation.py:1004` — `cues = store.cues(job_id)` fetch MỘT LẦN trước vòng lặp batch;
`store.set_translation` (dòng ~1035) chỉ ghi SQLite, **không cập nhật list trong RAM** →
batch 2+ lấy context từ list cũ. Cơ chế chỉ hoạt động khi... job bị restart giữa chừng.

**Tại sao nghiêm trọng:** Cùng với 1.4 → phim 6h chạy một mạch có **zero** cơ chế nhất quán
giữa các batch — mỗi batch 150 cue dịch như tài liệu độc lập.

**Cách sửa (nhỏ, an toàn):**
```python
for cue_index, text in translated.items():
    store.set_translation(job_id, cue_index, text)
    cues[positions[int(cue_index)]]["target_text"] = text   # thêm dòng này
```
(`positions` đã có sẵn gần dòng 1011.) Lưu ý: `context_text` nằm trong cache signature —
cache batch cũ sẽ vô hiệu một cách **đúng đắn**, job đang dở sẽ dịch lại các batch chưa xong.

**Kiểm tra:** unit test 2 batch giả lập — prompt batch 2 phải chứa bản dịch Việt của batch 1.

---

## 1.6. Cue bị skip không được lưu trước khi abort

**Gốc rễ:** `translation.py:1039-1044` — vượt `max_skipped_cues` (default 3) là raise
`TranslationError` ngay, nhưng danh sách skip chỉ persist khi chạy **thành công đến cuối**
(dòng 1055-1072).

**Hậu quả:** restart quên sạch cue nào đã fail → trả lại toàn bộ chi phí retry + chẻ đôi batch
cho những cue độc đã biết.

**Cách sửa:** persist `skipped_errors` vào prepass row (status `PARTIAL`) **trước** khi raise;
`_skipped_translation_cues` đã tồn tại để đọc lại khi resume.

**Kiểm tra:** job fail vì skip limit → restart → không gọi lại Codex cho cue đã đánh dấu.

---

## 1.7. Đổi config không còn vô hiệu hoá công việc cũ (regression có test chứng minh)

**Triệu chứng:** test `test_processing_config_change_invalidates_completed_work`
(`tests/test_state.py:12-34`) FAIL: gọi `initialize_job` lần 2 với `config_signature` mới,
test kỳ vọng stage INGEST quay về `PENDING` + chunk plan bị xoá — thực tế vẫn `DONE`.

**Gốc rễ:** `state.py:221-274` (`initialize_job`) khi thấy `config_signature` đổi chỉ UPDATE
trường đó trong bảng `jobs` (dòng 239-243), **không reset** stages/chunks/tts_groups như trước.
Logic invalidation đã bị mất trong đợt refactor (cùng sự kiện với §1.0).

**Tại sao nghiêm trọng:** người vận hành đổi config (ví dụ blur mạnh hơn, voice khác) rồi chạy lại
→ hệ thống thấy checkpoint DONE + artifact checksum khớp → **giữ nguyên output theo config cũ**,
job "hoàn thành" với sản phẩm trộn lẫn hai config mà không ai biết.

**Cách sửa:** trong `initialize_job`, khi `existing["config_signature"] != config_signature`:
reset stages về PENDING (trừ INGEST có thể giữ media), xoá/PENDING chunks + tts_groups có signature
phụ thuộc config — hành vi đúng là hành vi test đang mô tả. Đối chiếu thêm `processing_config()`
(`config.py:183-207`) — những key cosmetic (logo, threads) đã được loại khỏi fingerprint, nên
reset là an toàn, không quá nhạy.

**Nuance từ cross-review ([11](11-DOI-CHIEU-CROSS-REVIEW.md) H-01):** logo bị loại khỏi fingerprint
nhưng lại được **nướng vào frame** lúc render (`render.py:896`) — đổi logo giữa job đang dở → chunk
cũ mang logo cũ, chunk mới logo mới, cùng một video. Trade-off có chủ đích (không re-render 6h phim
vì cosmetic) nhưng phải ghi cảnh báo trong config example: *đổi `render.logo_*` khi job đang dở →
output trộn lẫn; đổi trước khi enqueue hoặc chấp nhận re-render*.

**Kiểm tra:** test có sẵn — làm nó xanh.

---

## 1.8. Backup tự động KHÔNG tồn tại (input + checkpoint) — cleanup có thể xóa trắng (vòng cross-review, đã qua 2 lượt phản biện)

**Triệu chứng:** DESIGN.md §9 có thư mục Drive `inbox/` để lưu bản sao input; DESIGN §7.7 quy định
"cleanup chỉ được phép sau khi backup thành công". Thực tế:

- `_ingest` (`pipeline.py:189`) trả cứng `"input_backed_up": False` — không có code nào backup input.
- `backup_input` (`backup.py:220`, copy lên `inbox/`) chỉ được gọi từ `backup_all` (`backup.py:296`)
  — tức **lệnh thủ công** `ytb-vps backup`, pipeline/queue không bao giờ gọi.
- Sau khi publish + verify thành công, cleanup (`queue.py:308-330`) gọi `delete_processed_input`
  (`backup.py:239-252`) **xóa file nguồn trên Drive `input/`** rồi xóa local input + workspace.

**Kiểm chứng lại (vòng phản biện 2 — hiệu chỉnh chính bản audit này):** phiên bản trước của mục
này viết "cleanup có revalidate size+MD5 nên thành phẩm không thể mất" — **SAI trong luồng Drive
bình thường**. Nhánh `remote_file_matches` (`queue.py:282-287`) chỉ chạy khi **local Part còn tồn
tại**; nhưng `_publish_to_drive` đã **xóa local Part + validation ngay sau upload**
(`pipeline.py:981-982`, test xác nhận output folder chỉ còn manifest —
`tests/test_pipeline_resume.py:269`) và `report["output"]` ghi đường dẫn **remote**
(`pipeline.py:944`). Vậy lúc cleanup, code rơi vào nhánh `elif` (`queue.py:288`) — **chỉ so sánh
chuỗi đường dẫn với chính nó, không verify gì trên Drive**. Kịch bản mất trắng có thật: remote Part
bị xóa/hỏng sau lần upload → cleanup vẫn xóa nguồn (local + Drive `input/`) + workspace →
**không còn thành phẩm hợp lệ, cũng không còn dữ liệu để tái tạo**.

**Lỗ hổng thứ hai cùng cụm:** `restore_all` (`backup.py:315-324`) dùng `--ignore-existing` —
file local đã tồn tại nhưng **hỏng/cụt** sẽ được giữ nguyên, restore "thành công" mà dữ liệu sai.

**Lỗ hổng thứ ba cùng cụm:** đường resume của pipeline (`_artifact_remote_valid`, `pipeline.py:850-851`)
tin cờ `remote_verified` trong SQLite từ lần verify đầu, không kiểm lại — nếu file remote bị xóa/sửa
giữa hai lần chạy, pipeline skip re-upload, job báo DONE trong khi remote thiếu file. Kết hợp với
lỗ hổng cleanup ở trên (không verify được vì local Part đã bị xóa), chuỗi này dẫn thẳng đến kịch
bản mất trắng.

**Lỗ hổng thứ tư cùng cụm (phạm vi rộng hơn "input"):** không chỉ input — **`job.sqlite` và toàn bộ
checkpoint OCR/TTS/render cũng không được backup tự động**. `backup_job` (`backup.py:270-276`,
snapshot SQLite + upload `jobs/<id>/`) chỉ được `backup_all` thủ công gọi (`backup.py:300`).
Stage tên "BACKUP" của pipeline (`_backup`, `pipeline.py:1001`) thực chất chỉ upload publish
artifacts còn thiếu rồi **xóa intermediate** — ngược 180° với DESIGN §7.7 ("sau mỗi chunk/stage
thành công, copy artifact bền lên Drive; cleanup chỉ sau khi backup thành công"). VPS chết ổ đĩa
giữa job 3 ngày = mất toàn bộ tiến độ, không resume được từ Drive như DESIGN cam kết.

**Cách sửa (theo thứ tự):**
1. **NGAY (một dòng config):** đặt `queue.cleanup_after_upload: false` làm default — không job nào
   được xóa nguồn/workspace cho đến khi các bước dưới xong.
2. Gọi `backup_input` trong `_ingest` khi Drive bật; chỉ đặt `input_backed_up: True` khi
   `remote_file_matches` xác nhận bản `inbox/`. `delete_processed_input` **từ chối xóa** khi
   bản `inbox/` chưa tồn tại/không khớp.
3. Sửa nhánh cleanup không-còn-local (`queue.py:288`): thay so-sánh-chuỗi bằng verify thật trên
   Drive — `lsjson` từng Part remote, đối chiếu size (+ checksum đã lưu trong artifact record của
   SQLite lúc upload, `record_artifact` đã có sha256). Local không còn file thì **bằng chứng phải
   đến từ remote**, không phải từ manifest tự ghi.
4. Nối `backup_job` vào cuối mỗi stage (hoặc tối thiểu sau TRANSLATE/TTS/RENDER) như DESIGN §7.7 —
   hàm đã viết sẵn, chỉ thiếu dây; snapshot SQLite đã atomic (`_snapshot_database`).
5. `restore_all`: restore vào thư mục staging mới → checksum + `PRAGMA integrity_check` cho SQLite
   → atomic swap; bỏ `--ignore-existing`.
6. Resume: `_artifact_remote_valid` revalidate remote (size là đủ rẻ) thay vì chỉ tin cờ.

**Kiểm tra (fault-injection, phải pass trước khi bật lại cleanup):** (a) job hoàn chỉnh → Drive có
`inbox/<video>` + `jobs/<id>/job.sqlite`; (b) xoá tay 1 Part trên Drive **sau** publish → cleanup
từ chối + lỗi rõ, nguồn còn nguyên; (c) giết VPS giữa stage TTS → máy trống restore từ Drive →
job resume đúng chỗ; (d) restore đè lên workspace hỏng → nội dung đúng bản remote.
