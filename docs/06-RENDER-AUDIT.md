# 06 — Audit sâu quy trình RENDER (vòng 2, ultrathink)

Kết quả soi từng bước của đường render: decode → blur → vẽ sub → encode → ghép audio → mux →
concat → validate → publish. Mỗi mục ghi rõ **mức tin cậy** (đã chứng minh bằng test / đọc code
chắc chắn / nghi vấn cần A-B test). Có cả mục "đã soi và KHÔNG có vấn đề" để agent sau khỏi soi lại.

## Bối cảnh cần hiểu trước

- Mỗi render chunk: FFmpeg decode (kèm blur band trong filter graph) → pipe rawvideo BGR24 vào
  Python → Python vẽ sub/logo/blur-box từng frame → pipe sang FFmpeg encode (NVENC/libx264).
- Audio ghép riêng per-chunk (`compose_audio_chunk`) rồi mux `-c copy`, cuối cùng concat các chunk
  `-c copy` thành Part 30 phút.
- "Band" = dải chữ nhật mờ đè lên vùng phụ đề gốc, hình học tính từ cluster cue (`_subtitle_band_geometry`).

---

## 6.1. 🔴 Bug boxblur: radius chạm đúng giới hạn → FFmpeg từ chối cả filter graph
**Tin cậy: ĐÃ CHỨNG MINH — 2 test đang fail vì chính lỗi này.**

**Triệu chứng:** `test_bounded_render_audio_mux_and_decode` và `test_mirror_video_flips_frame_before_output`
fail với lỗi FFmpeg: `Invalid luma_param radius value 17, must be >= 0 and < 17` → decode 0 frame → chunk fail.

**Gốc rễ:** `render.py:420-436` (`_blur_rect_filter`):
```python
radius = max(1, int(render["blur_kernel"]) // 2)
radius = min(radius, max(1, min(w, h) // 2))            # luma: cho phép radius == min(w,h)//2
chroma_limit = max(0, ((min(w, h) // 2) - 1) // 2)      # chroma: sai công thức (xem dưới)
chroma_radius = max(0, min(radius // 2, chroma_limit))
```
FFmpeg yêu cầu **radius < plane_dim_nhỏ_nhất / 2 (chặt, cho TỪNG plane)**. Boxblur chạy trong
decode graph **trước mọi chuyển đổi format** (`render.py:585-593` — graph không có `format=`),
tức trên yuv420p nguồn → plane chroma chỉ bằng nửa band. Kiểm chứng thực tế (band h=10):

```
ffmpeg -f lavfi -i color=size=64x10:d=0.1 -vf "boxblur=5:1"     → Invalid luma_param radius value 5, must be >= 0 and < 5
ffmpeg -f lavfi -i color=size=64x10:d=0.1 -vf "boxblur=4:1"     → Invalid chroma_param radius value 4, must be >= 0 and < 2
ffmpeg -f lavfi -i color=size=64x10:d=0.1 -vf "boxblur=4:1:1:1" → OK
```

Vậy có **hai** off-by-one:
- **Luma:** clamp cho phép `radius == min(w,h)//2` — giá trị bị cấm. Với `blur_kernel: 41`
  (radius 20), mọi band cao ≤ 40px chết; band tự động 1 dòng thường cao 44–56px —
  **sát ranh giới fail trong production**.
- **Chroma:** công thức đúng là `(min(w,h)//2)//2 - 1` (nửa kích thước plane chroma, trừ 1 vì chặt).
  Công thức hiện tại `((min(w,h)//2)-1)//2` cho kết quả **vượt giới hạn 1 đơn vị khi
  `min(w,h) ≡ 2 (mod 4)`** — ví dụ h=10 cho 2 (FFmpeg đòi <2), h=34 cho 8 (FFmpeg đòi <8).

**Cách sửa (khuyến nghị — giữ boxblur, sửa 2 clamp):**
```python
luma_limit = (min(w, h) // 2) - 1
chroma_limit = ((min(w, h) // 2) // 2) - 1
radius = max(1, min(radius, luma_limit))
chroma_radius = max(0, min(radius // 2, chroma_limit))
```
kèm guard: `min(w, h) < 4` → bỏ blur rect này (band ≤ 3px không có gì để che; hiện `max(1, ...)`
sẽ ép radius=1 trên band 2px → vẫn fail).

**Phương án B (triệt để, đổi hành vi ảnh):** thay `boxblur` bằng `gblur=sigma=<kernel/3>` —
gblur không có ràng buộc kích thước plane, xoá cả lớp bug này; đổi lại tốn CPU hơn một chút và
**mọi chunk render lại** (checksum filter đổi). Chỉ cân nhắc khi đã có git + suite xanh.

**Kiểm tra:** 2 test trên xanh lại; thêm unit test band h=10 và h=34 với kernel=41 →
filter string hợp lệ (chạy được qua `ffmpeg -f lavfi`).

---

## 6.2. 🔴 Video không có audio stream → crash toàn bộ RENDER (điều kiện bị ngược)
**Tin cậy: chắc chắn (đọc code), chưa có test.**

**Gốc rễ:** `pipeline.py:592-594`:
```python
video_result = render_video_chunk(
    settings=self.settings,
    input_path=self.input_path if bool(media.get("has_audio")) else None,  # SAI CHỖ
```
Decoder **video** cần `input_path` vô điều kiện; điều kiện `has_audio` đúng ra thuộc về
`compose_audio_chunk` (dòng 603-617 — đang truyền `input_path` vô điều kiện, cũng sai nốt:
input không có audio stream thì filter `[0:a]` fail).

**Hậu quả:** input không có tiếng (hiếm nhưng có thật) đi qua INGEST/OCR/TRANSLATE/TTS hàng giờ
rồi **chết ở RENDER** với lỗi FFmpeg khó hiểu (`-i None`).

**Cách sửa:** đảo lại — `render_video_chunk(input_path=self.input_path, ...)` luôn luôn;
`compose_audio_chunk(input_path=self.input_path if has_audio else None, ...)`.

**Kiểm tra:** fixture video không audio chạy hết pipeline (dub trên nền im lặng).

---

## 6.3. 🟠 Băng mờ hiện 100% thời lượng — kể cả cảnh không có thoại
**Tin cậy: chắc chắn (đọc filter graph).**

`_decoder_filter_arguments` (`render.py:573-597`) đặt blur band **tĩnh cho cả chunk** — cảnh
không phụ đề vẫn bị dải mờ che 14% màn hình dưới. Đây là khoảng cách chất lượng nhìn thấy rõ nhất
so với video lồng tiếng thủ công.

**Cách sửa (không cần kiến trúc mới):** overlay của FFmpeg hỗ trợ `enable=`. Chunk chỉ có ~10-40 cue
→ dựng biểu thức `enable='between(t,a1,b1)+between(t,a2,b2)+...'` từ cue times (đã có sẵn khi
dựng filter) gắn vào bước overlay của `_blur_rect_filter`. Blur chỉ hiện khi có chữ cần che.
- Cẩn thận: cộng thêm lề ±0.2s quanh mỗi cue (OCR timing lệch nhẹ).
- Config mới: `render.blur_only_during_cues: true|false` (default false để không đổi hành vi cũ,
  bật sau khi soak test).

**Kiểm tra:** render fixture có đoạn 5s không thoại → frame giữa đoạn đó không có blur;
frame trong cue có blur.

---

## 6.4. 🟠 Band tự động ôm sát bbox chữ, mất padding (regression — 3 test fail)
**Tin cậy: test chứng minh hành vi cũ; code hiện tại rõ ràng không pad.**

`_subtitle_band_geometry` (`render.py:496-536`) khi auto-detect từ cues trả về đúng
`y = min(ymin)`, `bottom = max(ymax)` — **không cộng padding**. Ba test
(`test_subtitle_band_auto_uses_bottom_cjk_cues`, `..._chooses_stable_bottom_cluster`,
`..._uses_full_width_auto_ocr_region`) kỳ vọng band mở rộng ra ngoài bbox
(`y ≤ ymin - box_padding_y`, đáy vượt ymax ≥ 8px). Test cũng truyền key
`subtitle_band_y_percentile` mà code hiện tại **không đọc** — bằng chứng thuật toán cũ bị thay.

**Vì sao quan trọng:** chữ có outline/anti-alias tràn ra ngoài bbox OCR — band ôm sát sẽ để
**viền chữ gốc lộ ra quanh mép band**.

**Cách sửa:** pad band: `y -= box_padding_y`, `bottom += max(8, box_padding_y)` (clamp trong khung);
acceptance = 3 test trên xanh. (Đừng cố phục dựng nguyên thuật toán percentile nếu không tìm lại
được bản cũ — pad đủ thoả spec test.)

---

## 6.5. 🟠 Phụ đề dài quá khổ bị **bỏ vẽ im lặng**
**Tin cậy: chắc chắn (đọc code).**

`_overlay_subtitle` (`render.py:210-219`): nếu layer to hơn vùng frame cắt được →
`if target.shape != bgr.shape: return` — **không vẽ, không log**. Xảy ra khi text 1 dòng
không wrap được (từ đơn dài, `wrap_two_lines` max 38 ký tự/dòng nhưng 1 từ đơn thì chịu)
render ở font 42 vượt bề ngang frame.

**Cách sửa:** dùng `_overlay_layer` (dòng 222-238, đã biết clip đúng) cho cả phụ đề,
hoặc log warning + tự giảm font khi đo được width > frame. Ưu tiên cách 1 (đơn giản, hàm có sẵn).

---

## 6.6. 🟡 Rủi ro lệch màu: pipe BGR24 không khai báo color matrix
**Tin cậy: NGHI VẤN — đúng theo lý thuyết swscale, cần A/B thực tế trước khi sửa.**

Decoder chuyển YUV(BT.709)→BGR24 rồi encoder chuyển BGR24→yuv420p **không chỉ định matrix**
ở cả hai đầu (`render.py:707-756`) — swscale mặc định có thể dùng BT.601 → màu lệch nhẹ
(da hơi đỏ/xanh) so với gốc, và output không gắn cờ colorspace.

**Cách kiểm tra trước:** render fixture màu chuẩn (colorbar) rồi so pixel với gốc.
Nếu lệch: thêm `-vf ...,scale=in_color_matrix=bt709` phía decode và
`-vf scale=out_color_matrix=bt709 -colorspace bt709 -color_primaries bt709 -color_trc bt709`
phía encode. **Đổi cái này = mọi chunk render lại** (checksum đổi) — chỉ làm giữa các job.

---

## 6.7. 🟡 Logo bị lọc theo đúng tên file `new-logo.png`
**Tin cậy: chắc chắn; có 1 test đặc tả một nửa hành vi này — đọc kỹ trước khi sửa.**

`_logo_layer` (`render.py:253-260`): candidate chỉ được nhận khi `candidate.name == "new-logo.png"`.
Người vận hành đặt `render.logo_path: /path/my-brand.png` → **logo im lặng biến mất**.

**Nuance (vòng 3):** test `test_logo_layer_uses_transparent_new_logo_when_legacy_logo_is_configured`
(`test_render_integration.py:367-382`) đặc tả rằng khi config trỏ tới file `logo.png` **cũ**
(bản nền trắng không alpha) thì phải bỏ qua nó và rơi về asset `new-logo.png` trong suốt —
tức là bộ lọc tên có chủ đích **chặn đúng 1 file legacy**, nhưng cách viết hiện tại chặn nhầm
**mọi tên khác** luôn.

**Cách sửa đúng spec test:** chấp nhận đường dẫn config trừ khi `candidate.name == "logo.png"`
(blacklist legacy), giữ so tên `new-logo.png` cho các candidate fallback mặc định. Test trên
phải vẫn xanh + thêm test mới: `logo_path: my-brand.png` → được dùng.

---

## 6.8. 🟡 Đĩa đầy giữa job: không có guard nào lúc runtime
**Tin cậy: chắc chắn (grep toàn repo — chỉ doctor check lúc khởi động).**

- `doctor` check `minimum_free_gib: 30` **một lần** trước khi chạy; job 6h ghi hàng trăm GB
  (video chunks + av chunks + publish candidate + Part).
- `_publish_local` (`pipeline.py:797-799`) còn **copy** candidate → cần trống ~2× cỡ Part
  tại thời điểm publish.
- Đầy đĩa giữa render → lỗi FFmpeg mơ hồ, retry vô ích cùng chỗ.

**Cách sửa:** hàm `ensure_free_space(path, need_bytes)` trong `util.py`
(`shutil.disk_usage`), gọi trước mỗi render chunk (need ≈ 3× cỡ chunk ước tính) và trước
concat/publish (need ≈ 2.5× cỡ part); lỗi rõ ràng `DiskSpaceError: cần X GiB, còn Y GiB`.
Kết hợp dọn sớm: sau khi Part N upload xong đã có `_remove_render_part` — đường local-publish
(`_publish_local`) hiện **không dọn gì** cho tới BACKUP; cân nhắc dọn video/audio trung gian
(giữ av chunk) ngay khi av chunk DONE — video/audio chỉ là bán thành phẩm của av.

---

## 6.9. 🟡 Tương tác "overflow TTS × render-ready" — ràng buộc khi bật lại spill
**Tin cậy: chắc chắn theo đọc code; hiện CHƯA kích hoạt (vì TTS đang cắt cụt).**

`_render_chunk_ready` (`pipeline.py:663-693`) chọn group liên quan theo **cửa sổ slot**
(`start_seconds/end_seconds`), còn `compose_audio_chunk` (`render.py:978-984`) chọn theo
**cửa sổ mix** (sau khi `_scheduled_tts_groups` xô đẩy vì audio tràn slot). Khi bật lại
overflow (xem [02-NANG-CAP-TTS.md](02-NANG-CAP-TTS.md) §2.2): group có slot nằm trước chunk
nhưng mix window tràn vào chunk sẽ **không được check DONE** → compose lọc `status == "DONE"`
âm thầm bỏ nó → **mất một mẩu tiếng ở đầu chunk**, chunk vẫn DONE với checksum, không bao giờ
render lại.

**Ràng buộc bắt buộc khi làm 02 §2.2:** `_render_chunk_ready` phải yêu cầu DONE cho mọi group
có `group_index ≤` group cuối liên quan (đơn giản nhất), hoặc mở rộng cửa sổ check lùi về trước
một khoảng = spill tối đa.

---

## 6.10. Những thứ ĐÃ SOI và KHÔNG cần sửa (đừng audit lại)

| Chỗ | Kết luận |
|---|---|
| A/V sync qua ranh giới chunk | Audio mỗi chunk dựng từ mốc thời gian **tuyệt đối** + `apad,atrim` đúng thời lượng video; sai số AAC frame (~23ms) **không tích luỹ** qua 180 chunk. OK. |
| Đệm frame cuối (`render.py:914-916`) | Decoder thiếu đúng 1 frame (rounding cuối phim) → lặp frame cuối; thiếu >1 → fail & retry. Hợp lý. |
| `concat -c copy` giữa các chunk | Cùng encoder/params/timebase trong 1 job → an toàn. Escaping tên file trong manifest chỉ sai với dấu `'` — đường dẫn workspace do mình kiểm soát (safe_stem). OK. |
| Overlap translate/TTS/render (`pipeline.py:390-525`) | Mỗi executor mở JobStore riêng (connection riêng), WAL + busy_timeout 30s; lỗi overlap chỉ log warning và stage cuối chạy lại — đúng thiết kế "overlap là tối ưu, stage là chân lý". OK. |
| `recover_stale` khi khởi động | RUNNING → PENDING cho stages/chunks/groups — đúng. |
| `_scheduled_tts_groups` xô đẩy micro-spill | Có test (`test_micro_spill_delays_following_tts_without_overlap`) — pass. OK. |
| SQLite durability | WAL + `synchronous=FULL` + transaction IMMEDIATE cho multi-row (`state.py:191-219`). Tốt. |

## Thứ tự làm trong file này

`6.1 → 6.2 → 6.4` (bug thật, sửa nhỏ, có test gate) → `6.8` (guard đĩa) → `6.5, 6.7` (nhỏ)
→ `6.3` (cải tiến chất lượng, sau khi suite xanh) → `6.6` (chỉ sau A/B) → `6.9` (ràng buộc, làm cùng 02 §2.2).
