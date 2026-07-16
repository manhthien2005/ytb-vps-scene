# Tổng quan cải thiện — đọc file này trước

> Bộ docs này liệt kê những gì cần sửa/nâng cấp trong `ytb-vps-scene`, xếp theo độ ưu tiên.
> Mỗi vấn đề có: **triệu chứng → gốc rễ (file:dòng) → tại sao quan trọng → cách sửa → cách kiểm tra**.
> Viết cho cả người đọc lẫn AI agent thực thi.
> Số dòng chốt tại **2026-07-16** (audit vòng 2). Agent phải đọc file gốc trước khi sửa.

## ⚠️ Trạng thái hiện tại của code (phát hiện quan trọng nhất vòng 2)

**Cây code đang dở dang giữa một đợt refactor và KHÔNG CHẠY ĐƯỢC end-to-end:**

- `pipeline.py:22` import hàm `run_static_ocr_samples` — hàm này **không tồn tại** trong `ocr.py`
  → `import ytb_vps.pipeline` chết ngay bằng `ImportError` → toàn bộ daemon/queue chết.
- `translation.py` gọi `store.translation_prepass(...)` / `store.set_translation_prepass(...)` —
  hai method này **không tồn tại** trong `JobStore` (`state.py`), và cũng không có bảng SQLite cho nó.
- File prompt nguồn `prompt_dich_sub_trung_ke_chuyen.txt` (bắt buộc lúc dịch, `translation.py:84-94`)
  **không có trong cây**.
- Test suite: **unittest báo "Ran 62 tests: 8 FAIL + 9 ERROR"** — 1 ERROR là pseudo-test của loader
  cho module `test_pipeline_resume` không import nổi (chi tiết: [07-KIEM-THU.md](07-KIEM-THU.md)).
- (Cross-review bổ sung) Worker OCR **Docker legacy** không nhận 4 tham số scale mà runner luôn
  truyền → backend `docker` chết ở argparse ngay chunk đầu ([01 §1.0e](01-SUA-NGAY.md));
  **không có backup tự động nào** (input, `job.sqlite`, checkpoint đều chỉ backup qua lệnh thủ công)
  trong khi cleanup xóa nguồn cả local lẫn Drive, và nhánh verify khi local Part đã bị dọn chỉ
  so chuỗi đường dẫn ([01 §1.8](01-SUA-NGAY.md)); blur mất ~20% cuối phim với nguồn 24fps do
  lệch timeline FPS ([11 H-03](11-DOI-CHIEU-CROSS-REVIEW.md)).

Chi tiết + cách khôi phục: **[01-SUA-NGAY.md](01-SUA-NGAY.md) mục 1.0** (làm trước mọi thứ khác).
Đây là hậu quả trực tiếp của việc không có git (mục 1.1): refactor nửa chừng, không diff được ai đổi gì.

## Dự án làm gì (1 đoạn)

Tool queue chạy trên VPS NVIDIA yếu (2 core, ~2.9GB RAM, GPU Pascal, có thể không có AVX).
Đầu vào: phim Trung Quốc có phụ đề tiếng Trung "cứng" (burned-in, in thẳng vào hình).
Đầu ra: video đã làm mờ phụ đề gốc, chèn phụ đề tiếng Việt + giọng đọc tiếng Việt (TTS).
Luồng: `INGEST → OCR (đọc phụ đề cứng) → TRACK (gom thành cue) → TRANSLATE (Codex CLI dịch Trung→Việt)
→ TTS (CapCut đọc tiếng Việt) → RENDER (blur + vẽ sub + ghép audio) → PUBLISH → BACKUP (Google Drive)`.
Mọi bước checkpoint vào SQLite để tắt máy giữa chừng vẫn chạy tiếp được (resume).

## Điểm mạnh nhất — KHÔNG được phá vỡ khi sửa

Hệ thống **resume/checkpoint** (SQLite WAL + synchronous=FULL + checksum + ghi file `.part` rồi rename)
là thứ giá trị nhất của dự án — mạnh hơn cả pyvideotrans (18k sao) và KrillinAI. Mọi cải tiến bên dưới
phải giữ nguyên nguyên tắc: *bước nào xong phải ghi lại được, chạy lại không làm lại việc đã xong*.

## Thứ tự ưu tiên (đã cập nhật sau audit vòng 3 + đối chiếu cross-review)

| # | File | Nội dung | Mức độ | Công sức |
|---|------|----------|--------|----------|
| 0 | [01-SUA-NGAY.md](01-SUA-NGAY.md) §1.0 | **Khôi phục khả năng chạy**: import hỏng, JobStore thiếu method, prompt file mất, worker Docker vỡ giao ước args (§1.0e) | 🔴 Blocker | Trung bình |
| 1 | [01-SUA-NGAY.md](01-SUA-NGAY.md) §1.1–1.8 | git, credential (96 file), story bible 4h, context đứng hình, **backup tự động không tồn tại (input + checkpoint) — cleanup có thể xóa trắng (§1.8)** | 🔴 Nghiêm trọng | Thấp–TB |
| 2 | [06-RENDER-AUDIT.md](06-RENDER-AUDIT.md) | Audit render sâu: bug boxblur (test đang chứng minh), đĩa đầy giữa job, các rủi ro ranh giới chunk | 🔴/🟠 | Thấp–TB |
| 3 | [07-KIEM-THU.md](07-KIEM-THU.md) | Đưa test suite về xanh — từng test fail đã chẩn đoán sẵn nguyên nhân | 🟠 Cao | Trung bình |
| 4 | [02-NANG-CAP-TTS.md](02-NANG-CAP-TTS.md) | Config đang TẮT các tầng chất lượng TTS; tầng "viết ngắn" hiện là **code chết** (không bao giờ chạy) | 🟠 Cao | Thấp |
| 5 | [03-NANG-CAP-OCR.md](03-NANG-CAP-OCR.md) | OCR theo sự kiện thay vì theo frame (~10x nhanh hơn) — repo cộng đồng xác nhận hướng này | 🟠 Cao | Trung bình |
| 6 | [09-DICH-THUAT-CHAT-LUONG.md](09-DICH-THUAT-CHAT-LUONG.md) | **Chuyên đề dịch thuật**: gộp câu → dịch → phân bổ lại; phản tư chọn lọc; nhịp đọc — bản thiết kế cho chất lượng "có hồn" | 🟠 Cao | TB–Cao |
| 7 | [10-BLUR-LOGO-VITRI-SUB.md](10-BLUR-LOGO-VITRI-SUB.md) | **Chuyên đề che logo/định vị sub per-video**: sidecar chọn tay + auto tích luỹ biên + band theo chunk | 🟠 Cao | Trung bình |
| 8 | [04-HIEU-NANG.md](04-HIEU-NANG.md) | Hash lặp O(N²), decode 3 lần, quản lý dung lượng đĩa | 🟡 Trung bình | Thấp |
| 9 | [05-HOC-TU-REPO-KHAC.md](05-HOC-TU-REPO-KHAC.md) | Ý tưởng đã thẩm định từ 8 repo/nguồn (3 vòng research) | 🟢 Tham khảo | — |
| 10 | [08-LO-TRINH-SAN-PHAM.md](08-LO-TRINH-SAN-PHAM.md) | Lộ trình gộp toàn bộ → sản phẩm vận hành được cho thị trường | 🟢 Kế hoạch | — |
| 11 | [11-DOI-CHIEU-CROSS-REVIEW.md](11-DOI-CHIEU-CROSS-REVIEW.md) | Phân xử từng phát hiện của review độc lập (GPT/Codex): cái nhận, cái hiệu chỉnh, cái bác — kèm bằng chứng file:dòng | 🟢 Đối chiếu | — |

## Quy tắc chung cho agent khi sửa

1. **Đọc file gốc trước khi sửa** — số dòng trong docs là tại thời điểm 2026-07-16, có thể lệch.
2. **Gặp hàm/method không tồn tại thì đừng tự bịa** — đọc [01-SUA-NGAY.md](01-SUA-NGAY.md) §1.0 trước;
   đó là mảnh refactor dở, đã có spec khôi phục.
3. **Không đổi schema SQLite** trừ khi vấn đề yêu cầu; nếu đổi phải theo pattern migration có sẵn
   (xem `state.py:195-199` — check `PRAGMA table_info` rồi `ALTER TABLE`).
4. Chạy test bằng: `PYTHONPATH="app;." python -m unittest discover -s tests -t .`
   (pytest **chưa được cài** trong môi trường này — đừng giả định có).
   Trạng thái suite hiện tại: xem [07-KIEM-THU.md](07-KIEM-THU.md) — **suite đang đỏ**;
   sửa mục nào phải làm xanh cụm test của mục đó, không được làm đỏ thêm.
5. Config mới phải thêm vào `config/config.example.yaml` kèm comment. Lưu ý: default "thật"
   nằm ở `config.py` (`DEFAULTS`, dòng 12-180) — sửa default phải sửa **cả hai chỗ**.
6. Fingerprint/signature (dấu vân tay cache): nếu sửa logic dịch/TTS thì phải tăng
   `PROMPT_REVISION` / version tương ứng để cache cũ tự vô hiệu — **không** xoá cache bằng tay.

## Lưu ý ngoài kỹ thuật (1 dòng, không nhắc lại)

Đầu ra là phim của bên khác được chỉnh sửa (mirror, đổi tiếng) — rủi ro bản quyền/Content ID là
rủi ro cấu trúc của dự án, không sửa được bằng code. Cân nhắc ở tầng quyết định kinh doanh.
