# 08 — Lộ trình đưa dự án thành sản phẩm vận hành cho thị trường

Gộp toàn bộ audit (docs 01–07) thành một kế hoạch thi công có thứ tự, có gate nghiệm thu.
Nguyên tắc xuyên suốt: **mỗi giai đoạn kết thúc bằng một trạng thái chạy được + test xanh + commit git**
— không bao giờ lặp lại thảm hoạ "refactor dở không dấu vết" đã tạo ra §1.0.

## Định nghĩa "sản phẩm" cho dự án này

Một hệ thống mà người vận hành (không phải người viết code) có thể:
1. Thả phim vào Drive input → nhận về các Part hoàn chỉnh trên Drive output, không cần can thiệp.
2. Khi có sự cố: đọc một báo cáo rõ ràng (job nào, stage nào, vì sao), chạy một lệnh để retry.
3. Đánh giá chất lượng đầu ra bằng report (bao nhiêu câu bị nén/cắt/degraded) thay vì xem lại 6h phim.
4. Cài đặt lại từ đầu trên VPS mới trong <30 phút bằng tài liệu + doctor.

## Giai đoạn 0 — Cấp cứu (docs 01 §1.0–1.3) — ~1-2 ngày công

| Việc | Nguồn | Gate nghiệm thu |
|---|---|---|
| Di dời credential ra khỏi cây | [01](01-SUA-NGAY.md) §1.3 | root sạch credential |
| `git init` + commit trạng thái hiện tại | [01](01-SUA-NGAY.md) §1.1 | có lịch sử để diff mọi sửa chữa sau |
| Sửa import `run_static_ocr_samples` (phương án A) | [01](01-SUA-NGAY.md) §1.0a | `import ytb_vps.pipeline` sạch |
| Khôi phục `translation_prepasses` trong JobStore | [01](01-SUA-NGAY.md) §1.0b | stage TRANSLATE chạy được |
| Tìm/tái tạo `prompt_dich_sub_trung_ke_chuyen.txt` | [01](01-SUA-NGAY.md) §1.0c | 3 test translation xanh |
| Xoá/xử lý `.patch`, `patch1.txt` | [01](01-SUA-NGAY.md) §1.2 | không còn patch mồ côi |
| Guard mode `scene_voiceover` chưa nối dây | [01](01-SUA-NGAY.md) §1.0d | config sai → lỗi rõ thay vì chạy sai |
| Đồng bộ args + scale tọa độ worker Docker legacy | [01](01-SUA-NGAY.md) §1.0e | smoke contract test 2 worker cùng pass |
| Chốt an toàn dữ liệu: default `cleanup_after_upload: false` | [01](01-SUA-NGAY.md) §1.8 | không job nào xóa nguồn khi chưa có inbox backup |

**Gate G0: pipeline import được, một clip 30s chạy hết INGEST→PUBLISH ở chế độ local.**

## Giai đoạn 1 — Suite xanh + đúng đắn cốt lõi (docs 07, 06 §6.1-6.2-6.4, 01 §1.4-1.7) — ~3-5 ngày

Theo đúng thứ tự trong [07-KIEM-THU.md](07-KIEM-THU.md):
boxblur off-by-one (§6.1) → config invalidation (§1.7) → band padding (§6.4) →
audio-less input (§6.2) → story bible 6h + FALLBACK sticky (§1.4) → context đứng hình (§1.5) →
persist skip (§1.6) → quyết định §7.2 (phụ đề theo bản rút gọn).
Kèm 2 việc từ cross-review ([11](11-DOI-CHIEU-CROSS-REVIEW.md) §11.5): **thống nhất timeline FPS**
— `build_cues`/`build_blur_regions`/`build_static_blur_regions` dùng `target_fps` settings thay vì
`media.fps`; với nguồn 24fps, clamp `duration_frames` theo fps nguồn đang làm **mất blur ~20% cuối
phim** (`subtitles.py:304,326` — H-03), fixture 24/25/29.97/30fps + assert `start_frame ≤ end_frame`;
và stderr các subprocess FFmpeg không drain (M-05).

**Gate G1: toàn bộ test được discover chạy 0 fail / 0 error (con số tuyệt đối sẽ tăng khi thêm
regression test — không neo vào "62"); clip fixture có video-không-audio và band mỏng đều pass.**

## Giai đoạn 2 — Chất lượng nghe được ngay (docs 02 + 09 bước D1 + 10 bước 1-2 + B5) — ~1,5 tuần

1. Khôi phục `TtsFitError` + thang 4 bậc + `overlong_policy` ([02](02-NANG-CAP-TTS.md) §2.2).
2. Bật config chất lượng ([02](02-NANG-CAP-TTS.md) §2.1) + sửa 2 regression micro-cue (§2.5).
3. Ước lượng duration trước TTS ([05](05-HOC-TU-REPO-KHAC.md) A2) — giảm request CapCut.
4. **Dịch bước D1** ([09](09-DICH-THUAT-CHAT-LUONG.md) §9.3): batch 150→30, tóm tắt lăn,
   forward context, budget âm tiết, giọng kể chuyện — thay thế mục "prompt A3" cũ.
5. **Blur/logo bước 1+2** ([10](10-BLUR-LOGO-VITRI-SUB.md) §10.3): sidecar per-video +
   sửa band padding/guard/per-chunk — giải quyết logo góc ngẫu nhiên + sub lệch độ cao.
6. edge-tts fallback + degraded mode ([02](02-NANG-CAP-TTS.md) §2.3, §2.4).
7. **Báo cáo chất lượng per-job** ([05](05-HOC-TU-REPO-KHAC.md) B5) — đây là công cụ nghiệm thu
   của chính giai đoạn này: so sánh trước/sau trên cùng 1 tập phim bằng số liệu
   (tỷ lệ cue bị nén >1.2x, bị cắt, bị degraded).

**Gate G2: cùng 1 tập phim, report cho thấy tỷ lệ cue vượt 1.2x giảm rõ; không group nào bị
cắt cụt âm thầm; 3 video có logo/sub vị trí khác nhau đều che đúng không cần chỉnh config
toàn cục (mốc đo [10](10-BLUR-LOGO-VITRI-SUB.md) §10.3).**

## Giai đoạn 3 — Tốc độ & chi phí máy (docs 03 + 04 + 06 §6.8) — ~1 tuần

1. OCR change-detection ([03](03-NANG-CAP-OCR.md)) — kỳ vọng giảm ≥5x thời gian OCR.
2. `cached_sha256` ([04](04-HIEU-NANG.md) §4.1) + bỏ decode trùng (§4.2).
3. Guard dung lượng đĩa + dọn trung gian sớm ([06](06-RENDER-AUDIT.md) §6.8).
4. OCR cleanup map ra file data ([05](05-HOC-TU-REPO-KHAC.md) A7).

**Gate G3: đo trên clip 10 phút — thời gian OCR giảm ≥5x, tổng wall-clock job giảm ≥30%;
kịch bản đĩa gần đầy cho lỗi rõ ràng thay vì lỗi FFmpeg mơ hồ.**

## Giai đoạn 4 — Vận hành như sản phẩm — ~1 tuần

1. **Packaging phục hồi**: `pyproject.toml` (console script + deps pin — xem [04](04-HIEU-NANG.md)
   §4.4), README cài đặt từ số 0 trên VPS mới, kèm cả nhánh supervisor lẫn systemd.
2. **Doctor mở rộng**: check edge-tts, check dung lượng theo *cỡ job dự kiến* (không phải hằng số),
   check pool device còn ≥N device sống, check prompt source tồn tại (bài học §1.0c).
3. **CLI vận hành**: `ytb-vps inspect <job>` (in summary + lỗi gần nhất + report chất lượng),
   `ytb-vps redo-group <job> <n>` (đánh PENDING lại 1 group TTS tệ), `ytb-vps requeue <job> --stage X`.
4. **Config example đầy đủ key** + validate cảnh báo key lạ (typo → cảnh báo thay vì im lặng
   dùng default).
5. Blur chỉ hiện khi có chữ ([06](06-RENDER-AUDIT.md) §6.3) — nâng cấp hình ảnh nhìn thấy rõ nhất
   đối với người xem cuối.
6. **An toàn dữ liệu + bảo mật vận hành** (từ cross-review, [11](11-DOI-CHIEU-CROSS-REVIEW.md)):
   inbox backup input tự động rồi mới bật lại cleanup ([01](01-SUA-NGAY.md) §1.8 bước 1+3);
   siết tải audio TTS (HTTPS + allowlist + chặn IP private — [02](02-NANG-CAP-TTS.md) cuối file);
   systemd user riêng **không thuộc group docker** + hardening (group docker ≈ root — chọn 1 trong
   3 phương án ở [11 §11.3 M-06](11-DOI-CHIEU-CROSS-REVIEW.md), rẻ nhất: production chỉ dùng backend
   ONNX); doctor hash lại model thật + smoke request đúng model dịch.

**Gate G4: một người chưa từng đụng repo cài được hệ thống trên VPS mới trong 30 phút
chỉ bằng README + doctor; xử lý được 1 job fail giả lập chỉ bằng CLI.**

## Giai đoạn 5 — Chất lượng cạnh tranh — liên tục

Theo giá trị/công sức:
1. **Dịch bước D2 rồi D3** ([09](09-DICH-THUAT-CHAT-LUONG.md) §9.3): sentence units →
   TTS theo câu + display sync + reflect chọn lọc — nâng cấp chất lượng dịch lớn nhất.
2. **Blur/logo bước 3** ([10](10-BLUR-LOGO-VITRI-SUB.md) §10.3): auto phát hiện logo đồ hoạ
   bằng tích luỹ biên.
3. B2 VAD (khớp nhịp nói) → B3 cắt chunk chỗ lặng → B4 tách vocal (opt-in, chỉ khi RAM chịu được).

Mỗi mục một nhánh git + soak test 1 tập phim + so sánh report G2 trước khi merge.

## Việc chạy nền xuyên suốt (không chờ giai đoạn)

- Mỗi bugfix có test đi kèm (danh sách lỗ hổng coverage: [07](07-KIEM-THU.md) cuối file).
- Mỗi lần đổi prompt/logic dịch/TTS: tăng revision/signature version tương ứng.
- DESIGN.md cập nhật theo code mỗi khi hành vi đổi (drift hiện có: [04](04-HIEU-NANG.md) §4.4).
- Soak test định kỳ trên 1 tập phim thật trước khi lên VPS production.

## Rủi ro còn lại ở tầng sản phẩm (ngoài phạm vi code — nhắc một lần)

1. **Bản quyền/Content ID**: rủi ro cấu trúc của mô hình kinh doanh (đã ghi ở [00](00-TONG-QUAN.md)).
2. **CapCut protocol không chính thức**: có thể đứt bất kỳ lúc nào — edge-tts fallback (G2)
   là giảm nhẹ, không phải loại bỏ; sản phẩm thương mại nghiêm túc cần đường TTS có hợp đồng
   (Azure/Google với giọng Việt) như một provider thứ ba sau interface đã dựng ở §2.3.
3. **Codex CLI phụ thuộc quota/subscription**: đường `_responses_api_call` (nếu làm lại đúng —
   [01](01-SUA-NGAY.md) §1.2) là phương án B cho dịch.
