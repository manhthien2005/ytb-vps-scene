# 05 — Học từ repo cộng đồng (8 repo/nguồn, 3 vòng nghiên cứu — đã thẩm định)

Vòng 1: pyvideotrans (18k⭐), KrillinAI. Vòng 2: VideoLingo (~13k⭐), VideoCaptioner,
video-subtitle-extractor, video-subtitle-remover (YaoFANGUK). Vòng 3 (đào sâu 2 chuyên đề):
gpt-subtrans (batching/context cho dịch sub LLM), nghiên cứu dịch-cho-lồng-tiếng
(SSPO ACL 2025, VideoDubber AAAI 2023) — kết quả vòng 3 nằm trong 2 file chuyên đề
[09-DICH-THUAT-CHAT-LUONG.md](09-DICH-THUAT-CHAT-LUONG.md) và
[10-BLUR-LOGO-VITRI-SUB.md](10-BLUR-LOGO-VITRI-SUB.md).
Chia 3 nhóm: **lấy ngay / cân nhắc / KHÔNG lấy** — kèm lý do gắn với ràng buộc của mình
(VPS 2 core, 2.9GB RAM, GPU Pascal, ưu tiên resume).

## Các repo làm gì khác mình

| | pyvideotrans | KrillinAI | VideoLingo | Mình |
|---|---|---|---|---|
| Lấy thoại từ đâu | ASR (faster-whisper) | ASR (Whisper word-level) | ASR (WhisperX) | **OCR hardsub** |
| Vì sao khác | Video nguồn không có sub | Như trên | Như trên | Hardsub là kịch bản chuẩn do người viết — chính xác hơn ASR với phim Trung (tên riêng, đồng âm, nhạc nền) |
| Resume | Không (chỉ cache dịch) | Không có checkpoint bền | Cache bước trong output/ | **SQLite checkpoint** — mạnh nhất |

→ Kết luận nền tảng giữ nguyên sau 2 vòng: **giữ OCR làm nguồn text, giữ kiến trúc resume.**
Cái đáng học nằm ở **fit audio vào timeline**, **prompt dịch cho lồng tiếng**, và **OCR theo sự kiện**.

---

## NHÓM A — Lấy ngay (chi phí thấp, code mình đã có sẵn phần lớn)

### A1. Thang fit audio của pyvideotrans (SpeedRate)
(1) nới slot vào khoảng lặng phía sau; (2) tăng tốc ≤1.2x coi như miễn phí (không nghe ra);
(3) vượt mới xử lý mạnh. Số đo của họ: gap-folding giảm speedup cần thiết 1.75x → 1.4x.
**Trạng thái ở mình:** cơ chế có đủ trong `tts.py` nhưng bị config tắt **và** tầng cứu hộ là
code chết → **[02-NANG-CAP-TTS.md](02-NANG-CAP-TTS.md) mục 2.1 + 2.2.**

### A2. Chuỗi "ước lượng → viết ngắn → fit" của KrillinAI
Ước lượng thời lượng TTS **trước khi gọi TTS** (thống kê ký tự/giây, tự hiệu chỉnh EMA từ kết quả
thật); câu dự đoán quá dài thì nhờ LLM viết ngắn **trước**, khỏi tốn request TTS cho audio sẽ vứt.
**Việc cần làm:** `estimate_tts_seconds(text)` cho tiếng Việt (âm tiết/giây + phạt dấu câu),
gọi trước `synthesize`; nếu ước lượng > slot × hard_fit_speed → shorten trước. Hiệu chỉnh hệ số
bằng trung bình trượt từ các group đã xong trong chính job (SQLite có sẵn duration thật).
**Lợi ích:** bớt một vòng request CapCut cho mọi câu dài (nhanh hơn + đỡ đốt quota pool).

### A3. Prompt dịch "cho lồng tiếng" (pyvideotrans + KrillinAI + VideoLingo đồng thuận)
Bổ sung vào prompt Codex (đã có duration budget mỗi cue):
- **Mục tiêu nén:** chỉ định tốc độ đọc đích (~4 âm tiết/giây tiếng Việt) để bản dịch vừa slot
  **ngay từ lúc dịch** — rẻ hơn mọi lớp sửa phía sau.
- **Câu tiếp diễn kết bằng "…"** để TTS giữ ngữ điệu chưa dứt.
- **Hợp đồng đủ-số-dòng + self-verify** (đếm lại entry trước khi trả) — mình đã validate ID-set
  trong code, thêm câu lệnh này giảm tỷ lệ retry.
**Lưu ý:** đổi prompt = tăng `PROMPT_REVISION` (`translation.py:79`).

### A4. Không cache kết quả rỗng + thêm engine vào cache key (pyvideotrans)
Chỉ áp dụng khi làm lại đường OpenAI API trực tiếp — [01-SUA-NGAY.md](01-SUA-NGAY.md) mục 1.2.

### A5. Fail mềm cho TTS (pyvideotrans) → [02](02-NANG-CAP-TTS.md) mục 2.4.

### A6. edge-tts làm kênh dự phòng (cả 3 repo dubbing đều có) → [02](02-NANG-CAP-TTS.md) mục 2.3.

### A7. (Vòng 2) Bản đồ sửa lỗi OCR tĩnh — `typoMap.json` của video-subtitle-extractor
Họ duy trì file map thay thế tĩnh hậu-OCR: lỗi nhận dạng phổ biến → chữ đúng, và
watermark/quảng cáo → chuỗi rỗng. Mình đang hardcode pattern trong `clean_ocr_text`
(`subtitles.py:27-41` — regex bilibili, 照月君...).
**Việc cần làm:** chuyển pattern ra file data `config/ocr-cleanup.json` (mục `replace` + `drop`),
`clean_ocr_text` đọc từ đó (lru_cache). Gặp watermark mới chỉ thêm 1 dòng JSON, không sửa code.
Nhớ đưa nội dung file vào cue/translation fingerprint để đổi map → re-track đúng.

---

## NHÓM B — Cân nhắc (giá trị thật nhưng cần công sức/thử nghiệm)

### B1. OCR theo sự kiện (VideoSubFinder-style; 2 nguồn độc lập xác nhận)
Ý tưởng runtime giá trị nhất toàn bộ nghiên cứu — giảm ~10 lần khối lượng OCR.
→ **File riêng: [03-NANG-CAP-OCR.md](03-NANG-CAP-OCR.md).** Vòng 2 nâng độ tin cậy: repo chuyên
trích hardsub (video-subtitle-extractor) gọi chế độ per-frame của chính họ là "rất chậm,
không khuyến nghị" — đó chính là chế độ mình đang chạy.

### B2. VAD — lấy thời điểm nói THẬT thay vì thời gian hiển thị phụ đề
Hardsub thường hiện sớm/muộn 100–500ms so với lúc diễn viên nói → giọng đọc lệch nhịp cảnh.
Chạy silero VAD (ONNX, model nhỏ, CPU no-AVX chạy tốt) trên audio gốc một lượt, lưu các khoảng
"có tiếng nói"; khi fit TTS, neo điểm bắt đầu vào speech onset gần nhất trong cửa sổ cue.
~90% lợi ích của ASR với ~5% độ phức tạp. Chạy theo chunk, checkpoint như các stage khác.
Làm sau khi Nhóm A ổn định.

### B3. Cắt chunk tại điểm "im lặng nhất" (KrillinAI `getQuietestTimePoint`)
Stream PCM mono 3kHz qua FFmpeg, trượt cửa sổ năng lượng 1.5s, chọn điểm lặng nhất trong ±8s
quanh điểm cắt dự kiến. ~100 dòng, CPU không đáng kể. Polish chất lượng nghe; sau B1/B2.

### B4. Giữ nhạc nền bằng tách vocal (pyvideotrans, UVR-MDX-NET CPU)
Trộn TTS đè audio gốc (volume 0.2 + ducking) vẫn còn thoại Trung văng vẳng. Tách instrumental
rồi trộn TTS lên nền sạch là khoảng cách chất lượng lớn nhất so với lồng tiếng chuyên nghiệp.
**Cảnh báo:** 2 core/2.9GB → tách 6h audio thêm nhiều giờ, RAM phải test kỹ, crossfade ranh giới
chunk không tầm thường. **Opt-in, gate sau soak test.** Hạng mục lớn nhất nhóm B.

### B5. Báo cáo audit chất lượng per-job (KrillinAI dubbing_report)
JSON cuối job: mỗi cue — duration ước tính vs thật, speed áp, số lần rút gọn, group bị cắt/degraded.
Thuần bookkeeping trên SQLite đã có. Giá trị: trả lời "đoạn phút 47 vì sao nhanh" không cần chạy lại;
mở đường lệnh "redo N group tệ nhất". **Vòng 2 nâng hạng: làm sớm, cùng lúc với 02** — vì 02 §2.2
thêm metadata `truncated`/`degraded`/`overflow_seconds` nên report gần như miễn phí, và nó là
công cụ nghiệm thu chất lượng cho thị trường ([08](08-LO-TRINH-SAN-PHAM.md)).

### B6. (Vòng 2) Dịch 2 bước "trung thành → trau chuốt" (VideoLingo 3-step, VideoCaptioner reflect)
Cả hai repo dịch LLM đời mới đều chạy ≥2 lượt: dịch sát nghĩa → lượt "phản tư" sửa cho tự nhiên.
Với mình: thêm lượt Codex thứ hai **chỉ cho cue nghi vấn** thay vì 100% cue.
**Vòng 3 đã nâng thành thiết kế đầy đủ** (tiêu chí chọn cue, prompt reflect, vị trí trong
kiến trúc gộp-câu): xem [09-DICH-THUAT-CHAT-LUONG.md](09-DICH-THUAT-CHAT-LUONG.md) §9.2 T4.

---

## NHÓM C — KHÔNG lấy (ghi lại để khỏi bàn lại)

| Thứ | Của ai | Vì sao không |
|---|---|---|
| ASR đầy đủ (faster-whisper/WhisperX) thay/kèm OCR | cả 3 repo dubbing | Hardsub chính xác hơn cho phim Trung; thêm runtime GPU thứ 3 cạnh Paddle legacy; RAM/VRAM không đủ. Chỉ xét lại nếu nguồn không còn hardsub. |
| TTS voice-cloning local (F5-TTS/CosyVoice/GPT-SoVITS/fish-tts) | cả 3 | VRAM/RAM vượt xa máy; tiếng Việt yếu. |
| Diarization đa giọng | VideoLingo có nhắc | Chính VideoLingo tắt vì "không đáng tin"; kéo cả stack PyTorch cho nice-to-have. |
| Làm chậm video chứa audio dài | pyvideotrans | Phá timeline CFR-30 (xương sống resume/render) và phá nhịp phim. |
| **Inpainting xoá hardsub (STTN/LAMA/ProPainter)** | video-subtitle-remover | **Thẩm định vòng 2 để đóng hồ sơ:** STTN — mode nhẹ nhất — vẫn giữ cửa sổ ~30 frame trên GPU (`STTN_MAX_LOAD_NUM=30`); ProPainter bị chính docs của họ cảnh báo "ngốn VRAM"; 6h phim trên Pascal cũ = nhiều **ngày** GPU, VRAM 2-4GB không chắc đủ, artifact trên nền động. Boxblur band + cải tiến [06](06-RENDER-AUDIT.md) §6.3 (blur chỉ hiện khi có chữ) là điểm cân bằng đúng cho máy này. Chỉ xét lại khi đổi GPU. |
| Kiến trúc queue in-memory | cả 3 | SQLite checkpoint của mình mạnh hơn cho job nhiều ngày. |
| Single-line subtitle "chuẩn Netflix" | VideoLingo | Chuẩn phụ đề chiếu rạp; sub 2 dòng phù hợp video YouTube dài, `wrap_two_lines` đang ổn. |

---

## Lộ trình tổng hợp → [08-LO-TRINH-SAN-PHAM.md](08-LO-TRINH-SAN-PHAM.md)

Lộ trình tuần-theo-tuần cũ trong file này đã được thay bằng lộ trình sản phẩm đầy đủ ở file 08 —
sau audit vòng 2, thứ tự ưu tiên đổi: **khôi phục khả năng chạy** đứng trước mọi nâng cấp.
