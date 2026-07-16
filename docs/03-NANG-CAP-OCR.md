# 03 — Nâng cấp OCR (giảm ~10 lần khối lượng OCR)

## Bối cảnh cần hiểu trước

- OCR là bước **chậm nhất** của pipeline trên GPU Pascal yếu.
- Hiện tại: FFmpeg decode video → crop dải phụ đề + downscale về `scan_width: 640`
  (`ocr.py:89-115` — phần crop/scale này đã làm tốt) → đưa **từng frame đã sample** vào PaddleOCR
  (`containers/*/worker.py` vòng lặp đọc frame → OCR).
- `sample_fps: 2.0` (config) → video 6h = 21.600s × 2 = **43.200 lần det+rec đầy đủ**.

## Vấn đề gốc rễ: OCR theo frame, trong khi phụ đề thay đổi theo "sự kiện"

Một câu thoại phim đứng yên trên màn hình 1–5 giây. Với sample 2fps, cùng một câu bị OCR
2–10 lần, kết quả giống hệt nhau. Ước tính **60–90% call OCR là thừa**.
Sau đó `build_cues` (`subtitles.py:212-286`) lại phải "gom ngược" các detection trùng lặp
thành cue bằng text similarity (0.72) — trả thêm chi phí để khử cái thừa vừa tạo ra.

**Cộng đồng xác nhận hướng này (2 nguồn độc lập, vòng research 2):** cả pyvideotrans lẫn
**video-subtitle-extractor** (YaoFANGUK — repo tham chiếu cho trích hardsub phim Trung) đều dùng
VideoSubFinder-style detection: mode "Fast/Auto" của họ chỉ OCR frame ứng viên do so sánh ảnh
chọn ra; mode "Accurate" (per-frame như mình đang làm) bị chính họ gắn nhãn "rất chậm,
không khuyến nghị". Cách hiện tại của mình là cách mà repo tham chiếu **khuyên tránh**.

## Giải pháp: change-detection trước, OCR sau

Sửa trong worker (`containers/ocr-legacy/worker.py` và `containers/ocr-onnx/worker.py`) —
vòng lặp đọc frame đã có sẵn, chỉ chèn một bước so sánh trước khi gọi OCR:

```
frame mới (đã crop dải phụ đề, đã downscale)
  → tính khác biệt so với frame OCR gần nhất
    (mean absolute difference trên ảnh xám, hoặc đếm pixel "trắng như chữ" thay đổi)
  → nếu khác biệt < ngưỡng: BỎ QUA OCR, frame thuộc cùng sự kiện phụ đề
  → nếu khác biệt ≥ ngưỡng: OCR frame này (bắt đầu sự kiện mới)
```

**Con số kỳ vọng:** phim 6h có ~3.000–6.000 sự kiện phụ đề → từ 43.200 call xuống
~4.000–8.000 call (kể cả OCR xác nhận 2 frame/sự kiện) = **giảm 5–10 lần thời gian GPU**,
bớt nhiều giờ đến cả ngày wall-clock cho một phim.

**Bonus chất lượng:** ranh giới thời gian từ pixel-diff chính xác hơn so sánh text OCR nhiễu
→ cue start/end sát hơn → blur và TTS timing tốt hơn.

## Ràng buộc phải giữ (rất quan trọng cho resume)

1. **Định dạng output JSONL không đổi** (mỗi detection có `frame_index`, `box`, `text`,
   `confidence`) — `build_cues` và `build_blur_regions` đọc format này, không cần sửa.
2. Khi bỏ qua OCR một frame, **không được để trống**: nếu một sự kiện 5s chỉ có frame đầu
   có detection, `build_cues` sẽ kết thúc cue sớm sau `max_gap_frames` (15).
   → Cách xử lý đúng: **phát lại (re-emit) detection của frame OCR gần nhất với `frame_index`
   hiện tại** (copy kết quả, không OCR lại). Downstream không thấy khác biệt gì so với
   per-frame OCR, còn GPU thì tiết kiệm.
3. Ngưỡng là **config key mới** (`ocr.change_detection: true`, `ocr.change_threshold: ...`)
   có trong cả `config.py` DEFAULTS lẫn `config.example.yaml`, tắt được — video nền động
   sau chữ (hiếm) có thể quay về per-frame.
4. Progress log `OCR_PROGRESS n total detections` giữ nguyên semantics (đếm frame đã xử lý,
   kể cả frame skip) — `run_ocr_chunk` parse đúng 4 token (`ocr.py:216-225`), không cần sửa.
5. Chunk boundary: frame đầu mỗi chunk **luôn OCR** (không có "frame trước" để so) — tự nhiên
   đúng vì mỗi chunk là một tiến trình worker mới.

## Việc phụ cùng chủ đề: hai script thử nghiệm ở root

`hybrid-ocr-test.py` và `paddleocr-hpi-benchmark.py` là script khảo sát backend OCR (di sản
giai đoạn chọn công nghệ). Sau khi làm change-detection: chuyển vào `tools/experiments/`
hoặc xoá (có git rồi thì lịch sử giữ lại); ghi kết luận của chúng vào một dòng trong DESIGN.md.

## Kiểm tra

1. Unit test worker với chuỗi frame giả: 90 frame, text đổi 3 lần → đúng 3(+xác nhận) lần gọi
   OCR engine, nhưng JSONL vẫn có detection cho mọi frame có chữ.
2. Fixture 30s chạy 2 chế độ (bật/tắt change-detection) → `build_cues` cho ra **cùng số cue,
   cùng text**, timing lệch ≤ 1 frame sample.
3. Clip 10 phút: kỳ vọng giảm ≥ 5 lần thời gian OCR.
