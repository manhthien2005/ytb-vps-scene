# 10 — Che logo & định vị sub theo từng video (chuyên đề vòng 3)

Bài toán người vận hành nêu: video Trung đầu vào có **3 lớp cần che, vị trí thay đổi theo video**:
1. Logo bilibili — nằm góc **ngẫu nhiên** (có video còn đổi góc giữa chừng).
2. Logo kênh Trung (nếu có) — thường 1 góc cố định suốt phim.
3. Sub Trung cứng — dải phụ đề mỗi video một độ cao khác nhau.

Yêu cầu đầu ra: blur đẹp, đúng vị trí, **cho phép chọn thủ công hoặc tự động**.
File này soi những gì code đã có, chỗ nào hỏng, và thiết kế phần còn thiếu —
đối chiếu cách VideoSubFinder / video-subtitle-extractor / video-subtitle-remover (VSR) làm.

---

## 10.1. Hiện trạng: 3 cơ chế đã có, 1 mảnh vỡ, 2 lỗ hổng

**Đã có trong cây (nhiều hơn vòng 1 tưởng):**

| Cơ chế | Ở đâu | Che được gì |
|---|---|---|
| Band mờ dải phụ đề, auto theo cluster cue CJK đáy màn (`subtitle_band_auto`) + fallback ratio tay | `render.py:496-536` | Sub Trung — **đây là đường chính, đúng hướng** (VideoSubFinder cũng dùng search-band có bound; PaddleOCR-det-rồi-cluster đúng là cách VSE auto hoá) |
| `build_static_blur_regions`: cluster detection **ổn định vị trí** qua ≥5/10 frame mẫu trải đều phim, loại vùng trùng dải sub → blur suốt phim | `subtitles.py:337-475` | Logo bilibili + logo kênh **dạng text** (PaddleOCR đọc được "bilibili") |
| `clean_ocr_text` regex lọc biến thể "bilibili/bili/照月君" khỏi text cue | `subtitles.py:27-41` | Chống watermark lọt vào bản dịch (không che hình) |

**Mảnh vỡ:** đường nạp dữ liệu cho static blur đang đứt — `run_static_ocr_samples` không tồn tại
([01](01-SUA-NGAY.md) §1.0a). Lưu ý khi khôi phục theo phương án A: `build_static_blur_regions`
đọc detections từ store, tức chỉ thấy vùng **trong dải crop OCR** — hôm nay crop mặc định là
full-frame (`scan_min/max_y_ratio: 0.0/1.0`) nên vẫn bắt được logo góc trên; nhưng nếu làm
[03](03-NANG-CAP-OCR.md) rồi thu hẹp dải quét để tăng tốc thì **mất luôn mắt nhìn logo** —
đó chính là lý do tồn tại của `run_static_ocr_samples` (phương án B: OCR full-frame ~10 frame mẫu
riêng). **Ràng buộc mới: khi thu hẹp `scan_*_y_ratio`, bắt buộc làm B.**

**Mảnh vỡ thứ hai (cross-review, [11 H-03](11-DOI-CHIEU-CROSS-REVIEW.md)):** với video nguồn
24/25fps, `build_blur_regions`/`build_static_blur_regions` clamp và lấy mẫu theo timeline fps
**nguồn** trong khi frame index của OCR nằm trên timeline 30fps (`subtitles.py:304,326,348`) →
**blur biến mất ở ~20% cuối phim** và static blur không có frame mẫu nào ở đoạn cuối. Phải sửa
(Giai đoạn 1 của [08](08-LO-TRINH-SAN-PHAM.md)) trước khi đo bất kỳ gate blur nào ở file này.

**Hai lỗ hổng thật với yêu cầu của anh:**

1. **Logo đồ hoạ không chữ**: static blur dựa trên OCR — logo kênh dạng icon/hình PaddleOCR
   không detect → không có gì che. (Logo bilibili chuẩn có chữ nên thường bắt được;
   logo tự chế của kênh thì hên xui.)
2. **Không có đường chọn thủ công nào**: mọi thứ auto; auto trượt thì người vận hành bó tay
   (chỉ chỉnh được các ratio toàn cục trong config, áp cho MỌI video trong queue).

## 10.2. Thiết kế bổ sung — nguyên tắc "auto trước, tay đè lên"

Cách VSR/VSE cấu trúc: auto-detect mặc định, GUI cho user kéo box; box tay **thắng** auto.
Mình headless trên VPS → "GUI" của mình là **file sidecar cạnh video input**:

### a) Sidecar per-video `\<tên-video\>.regions.json` (cơ chế tay — làm TRƯỚC, rẻ nhất)

```json
{
  "subtitle_band": {"y_ratio": 0.80, "height_ratio": 0.15},      // đè auto band
  "blur_boxes": [
    {"x": 0.86, "y": 0.04, "w": 0.12, "h": 0.07, "label": "logo bilibili"},
    {"x": 0.02, "y": 0.04, "w": 0.10, "h": 0.06, "label": "logo kênh",
     "start_seconds": 0, "end_seconds": 3600}                     // optional: theo thời gian
  ],
  "disable_static_auto": false
}
```

- Toạ độ **ratio 0–1** (không phải pixel) — video bị scale về 1080p vẫn đúng.
- Queue đọc sidecar lúc `initialize_job`, ghi vào bảng job (cột JSON mới) và đưa vào
  `config_signature` → đổi sidecar = job tự re-render đúng phần liên quan
  (điều kiện: [01](01-SUA-NGAY.md) §1.7 phải sửa xong).
- `_track` nối các box tay vào `blur-plan.json` với `kind: "static_blur"` — **render không cần
  sửa dòng nào**, đường vẽ static blur (`render.py:816-838`) dùng lại nguyên vẹn, kể cả xử lý
  mirror (đã flip x đúng, `render.py:824-825`).
- Workflow người vận hành: mở video 10 giây, ước lượng box theo phần trăm màn hình, viết JSON,
  thả cạnh video. Đơn giản, không cần tool. (Sau này muốn sướng hơn: lệnh
  `ytb-vps regions <video>` xuất 3 frame PNG có lưới % để nhìn — 30 dòng code, làm ở
  Phase 4 [08](08-LO-TRINH-SAN-PHAM.md).)

### b) Auto-detect logo đồ hoạ bằng tích luỹ biên (cơ chế auto cho lỗ hổng 1)

Kỹ thuật kinh điển cho watermark tĩnh (gốc: thuật toán delogo tự động — median/tích luỹ gradient
qua thời gian; logo đứng yên trong khi nội dung đổi):

```
lấy ~24 frame trải đều phim (tái dùng chính các frame của run_static_ocr_samples)
→ Sobel edge từng frame (ảnh xám)
→ mask = pixel có biên ở ≥85% số frame        # nội dung phim không bao giờ ổn định vậy
→ morphology close + bỏ blob < 0.02% diện tích khung
→ bbox các blob còn lại, LOẠI blob giao dải sub (đã có logic tương tự trong
  build_static_blur_regions:410) → append blur-plan kind="static_blur"
```

- ~60 dòng numpy/OpenCV, chạy 1 lần/job trong TRACK, vài giây CPU — hợp máy 2 core.
- Bắt được logo **bất kể có chữ hay không**, bổ khuyết đúng chỗ OCR mù.
- Hạn chế thật (ghi rõ để khỏi kỳ vọng nhầm): logo bán-trong-suốt mờ có thể lọt lưới;
  logo **đổi góc giữa phim** sẽ ra 2 cluster — mỗi cluster hiện diện ~50% frame → cần
  hạ ngưỡng theo **đoạn**: chạy tích luỹ trên từng nửa/phần ba phim thay vì cả phim
  (3 lượt × 8 frame), region nào chỉ có ở đoạn nào thì `start/end_frame` theo đoạn đó —
  khớp luôn schema `start_frame/end_frame` sẵn có của blur region.
- Config: `tracking.edge_watermark_enabled: true`, `edge_watermark_presence: 0.85`,
  `edge_watermark_segments: 3`. Sidecar `disable_static_auto: true` tắt được per-video.

### c) Sub band per-video: sửa 2 bug đã biết + thêm 1 nấc chất lượng

Đường auto band từ cue cluster **đúng kiến trúc rồi** (đây chính là điều VSE làm bằng tay GUI,
mình làm bằng OCR stats) — chỉ cần:
1. Sửa padding regression + percentile ([06](06-RENDER-AUDIT.md) §6.4) — band ôm sát bbox làm
   lộ viền chữ, 3 test đang chứng minh.
2. Band theo **chunk** thay vì một hình chữ nhật cho cả phim: `_subtitle_band_geometry` đã nhận
   `cues` — truyền cues của riêng chunk (call site `render.py:687` đang truyền toàn bộ) →
   video có sub đổi độ cao giữa phim (hiếm nhưng anh đã gặp) tự khớp. Đổi này rẻ (1 dòng lọc)
   nhưng đổi checksum mọi chunk → làm giữa 2 job.
3. Guard chất lượng: nếu band auto cao > `0.30 × height` (cluster nhiễu nuốt cả logo/tựa đề)
   → log warning + rơi về ratio config; hôm nay nó im lặng che nửa màn hình.

### d) Thứ đã cân nhắc và KHÔNG làm

| Thứ | Vì sao không |
|---|---|
| FFmpeg `delogo`/`removelogo` thay boxblur | `delogo` nội suy từ viền — đẹp hơn blur với logo nhỏ, nhưng thêm nhánh filter graph mới + đòi box **nằm lọt hẳn trong khung** (fail cứng nếu chạm mép — logo góc thường chạm mép); boxblur đã có temporal alpha mượt. Không đáng 2 đường code song song. Ghi lại: nếu sau này muốn "đẹp hơn blur", `delogo` với box thu 2px khỏi mép là ứng viên đầu tiên, thử A/B 1 video. |
| Inpainting (STTN/LAMA/ProPainter) | Đã đóng hồ sơ với số liệu VRAM — [05](05-HOC-TU-REPO-KHAC.md) nhóm C. |
| Detector logo học máy (LOGO-Net v.v.) | Tích luỹ biên + OCR + sidecar tay phủ ≥95% ca thật với 0 model mới trên máy 2.9GB RAM. |
| GUI chọn box | VPS headless; sidecar JSON + (sau này) lệnh xuất frame PNG là đủ cho 1 người vận hành. |

## 10.3. Thứ tự làm & nghiệm thu

| Bước | Phụ thuộc | Gate |
|---|---|---|
| 1. Sidecar per-video (a) | §1.0a, §1.7 | Video có logo góc lạ: thêm 1 file JSON → box được blur đúng chỗ, resume không hỏng, đổi sidecar → tự re-render |
| 2. Sửa band: padding + guard + per-chunk (c) | §6.4 | 3 test band xanh; fixture sub đổi độ cao giữa video → cả 2 vị trí được che |
| 3. Tích luỹ biên (b) | 1, 2 xong | Fixture chèn logo PNG không chữ ở góc ngẫu nhiên → tự phát hiện; logo đổi góc giữa phim → 2 region đúng khoảng thời gian |

Mốc đo cuối (đưa vào Gate G2 của [08](08-LO-TRINH-SAN-PHAM.md)): trên 3 video thật khác nhau
(logo góc khác nhau, sub độ cao khác nhau) — **không chỉnh config toàn cục nào**, cả 3 ra
thành phẩm che đúng: sub band + mọi logo, kiểm bằng mắt 3 frame đầu/giữa/cuối mỗi video.
