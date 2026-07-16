# 04 — Hiệu năng (I/O, decode lặp, dung lượng đĩa)

Các vấn đề ở đây không sai về logic — chúng "chỉ" đốt thời gian và đĩa trên máy 2 core.
Sửa được bằng thay đổi nhỏ, không đụng kiến trúc.

## Bối cảnh cần hiểu trước

- Video 6h chia thành ~180 render chunk (120s/chunk), mỗi chunk vài trăm MB.
- Mỗi chunk và mỗi file audio TTS đều có SHA-256 checksum lưu trong SQLite — dùng để
  verify khi resume. Thiết kế đúng. Vấn đề là **tần suất** verify.

---

## 4.1. SHA-256 bị tính đi tính lại — O(N²) khi pipeline overlap chạy

**Gốc rễ 1:** `_chunk_artifact_valid` (`pipeline.py:191-197`) đọc và hash **toàn bộ file**
mỗi lần được hỏi "chunk này xong chưa?". Nó được hỏi trong `_ocr_valid`, `_render_valid`,
`_render_ready_chunks` — và `_render_ready_chunks` chạy **lặp lại nhiều lần** trong lúc
translate/TTS overlap (mỗi khi một batch dịch hoặc một group TTS xong —
`pipeline.py:395-411, 496-508`).

**Gốc rễ 2:** `_render_chunk_ready` (`pipeline.py:687-693`) hash **mọi file audio fitted
liên quan** mỗi lần poll. Với ~4.000 group và hàng trăm lần poll, tổng I/O chỉ để
"kiểm lại thứ đã kiểm" lên tới hàng chục GB đọc đĩa.

**Gốc rễ 3 (vòng 2):** `scene_voiceover.audio_groups` (`scene_voiceover.py:294`) hash lại
**mọi** segment audio mỗi lần được gọi — cùng bệnh, sẽ thành vấn đề khi nối dây mode này.

**Tại sao đáng sửa:** máy 2 core; SHA-256 vài trăm MB × hàng trăm lần = phút-đến-giờ CPU
bị lấy khỏi render/OCR, cộng bào đĩa.

**Cách sửa (giữ nguyên độ an toàn khi resume):**
- Cache trong RAM cho phiên chạy: `dict[path] = (size, mtime_ns, sha256)` — chỉ hash lại khi
  size/mtime đổi. Hash đầy đủ vẫn xảy ra **một lần mỗi lần khởi động process** — đúng lúc
  resume cần sự thật tuyệt đối; trong cùng phiên thì file mình vừa ghi xong không cần hash lần N.
- Điểm đặt gọn nhất: `cached_sha256(path)` trong `util.py` (dict module-level + `threading.Lock` —
  các executor overlap gọi từ nhiều thread), thay các call `sha256_file` bên trong
  `_chunk_artifact_valid` và `_render_chunk_ready` (KHÔNG thay ở chỗ ghi checksum lần đầu
  sau khi tạo file — chỗ đó phải hash thật).

**Kiểm tra:** đếm số lần hash thật trên job fixture: trước ~O(chunks × polls), sau ≤ 1 lần/file/phiên.
Test resume vẫn pass (xoá 1 chunk giữa chừng → phát hiện và re-render).

---

## 4.2. Mỗi frame video bị decode ~3 lần trong đời nó

**Hiện trạng, cho một render chunk:**
1. Decode để render (bắt buộc) — `render_video_chunk`.
2. `full_decode(output_path)` ngay trong `render_video_chunk` (`render.py:958`).
3. `full_decode(av)` lần nữa sau khi mux (`pipeline.py:620`).
4. Khi publish, `validate_final` **full_decode cả Part 30 phút** (`render.py:1204`) —
   lần 3 cho cùng những frame đó.

**Tại sao tồn tại:** "validate bằng decode toàn bộ" là gate an toàn có chủ đích (DESIGN.md §7.6).
Không bỏ gate — chỉ bỏ **trùng lặp**.

**Cách sửa (giữ nguyên chất lượng gate):**
- Bỏ `full_decode` ở bước (2) — chunk video-only sẽ được decode toàn bộ ở bước (3) ngay sau đó
  (file mux chứa chính stream đó, `-c copy`). Một gate là đủ.
- Ở `validate_final` (bước 4): Part được concat `-c copy` từ các chunk **đã** full-decode ở (3).
  Làm config `render.publish_validation: full | fast` (default `full` — không đổi hành vi;
  `fast` = probe duration + frame count + decode 60s đầu/cuối, lỗi concat biểu hiện ở ranh giới).
  Bật `fast` sau soak test.

**Kỳ vọng:** tiết kiệm ~1 lần decode toàn bộ phim mỗi job (nhiều giờ CPU trên máy này).

---

## 4.3. (Vòng 2) Dung lượng đĩa — không có guard runtime

Chi tiết và cách sửa: [06-RENDER-AUDIT.md](06-RENDER-AUDIT.md) §6.8 (guard trước render chunk +
trước concat/publish; dọn video/audio trung gian sớm). Nhắc ở đây vì thuộc nhóm hiệu năng-vận hành:
đĩa đầy giữa job 3 ngày là kịch bản chết thật trên VPS ephemeral.

---

## 4.4. Ghi chú các điểm nhỏ hơn (làm khi tiện)

| Vấn đề | Chỗ | Gợi ý |
|---|---|---|
| `probe_duration` gọi 2–3 lần cho cùng file trong `fit_audio` | `tts.py:519-604` | Chấp nhận được (file nhỏ) — không ưu tiên |
| `DESIGN.md` nói chunk OCR 300s giảm còn 120s khi fail — code không có logic giảm; default thật là 120s cả hai (`config.py:32-33`) | DESIGN.md | Sửa DESIGN.md khớp code (docs sai → agent sau sửa nhầm) |
| Nhiều config key chỉ tồn tại trong code (`story_bible_*`, `hook_*`, `merge_adjacent_cues`, `device_pool_dir`, `display_shortened_text`, render `parallel_chunks`, …) | `config.example.yaml` | Bổ sung đủ key + comment — file mẫu là "tài liệu API" của người vận hành |
| `pyproject.toml`/`README.md` từng tồn tại (egg-info `SOURCES.txt` ghi nhận) nhưng đã biến mất khỏi cây | root | Khôi phục packaging: `pyproject.toml` với console_script `ytb-vps = ytb_vps.cli:main` + deps pin theo `app/ytb_vps.egg-info/requires.txt` (numpy 1.26.4, opencv-python-headless 4.11.0.86, Pillow 11.1.0, PyYAML 6.0.2, requests 2.32.5; extra test: pytest 8.3.5) |
| Logging | `logging.py` | Đã soi vòng 2: RotatingFileHandler 20MB×5 (queue) + 20MB×3 (mỗi job) — đủ cho debug remote, không cần sửa |

## Thứ không nên "tối ưu"

- **Không** tăng số worker nặng song song (OCR/FFmpeg) — 2.9GB RAM, một-việc-một-lúc là đúng (DESIGN.md D7).
- **Không** bỏ checksum khi resume — chỉ bỏ tính lại *trong cùng phiên* (4.1).
- **Không** thay SQLite — WAL + `synchronous=FULL` đang là xương sống resume.
- **Không** đụng `source_fingerprint` (hash full file input) — chống nhầm identity job, đáng giá.
