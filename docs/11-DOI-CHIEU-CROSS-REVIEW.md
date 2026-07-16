# 11 — Đối chiếu cross-review (GPT/Codex) — phân xử từng phát hiện

> Bản review độc lập (Codex) trả về 5 CRITICAL + 9 CAO + 7 TRUNG BÌNH + 3 THẤP.
> File này phân xử **từng mục** dựa trên đọc lại source (file:dòng kèm theo), để tránh
> vừa bỏ sót phát hiện thật, vừa nuốt phải phát hiện sai/quá tay. Kết luận tổng thể của
> Codex — **release gate = BLOCKED** — trùng với kết luận của bộ docs này từ vòng 1.

Quy ước cột "Phán quyết": ✅ xác nhận (mới) · ✅≡ xác nhận (đã có trong docs, ghi rõ mục) ·
🟡 đúng một phần (kèm hiệu chỉnh) · ❌ chưa đủ bằng chứng / sai.

## 11.1. Nhóm CRITICAL

| ID | Phán quyết | Chi tiết đối chiếu |
|---|---|---|
| C-01 backup/cleanup | ✅ **nhận toàn phần (sau 2 vòng phản biện)** | Vòng phản biện 1 của bộ docs này từng hạ mức C-01 xuống "chỉ mất video nguồn, thành phẩm không thể mất vì cleanup có revalidate MD5" — **vòng phản biện 2 chứng minh chính hiệu chỉnh đó SAI**. Nhánh `remote_file_matches` (`queue.py:282-287`) chỉ chạy khi local Part còn; nhưng luồng Drive bình thường đã xóa local Part+validation ngay sau upload (`pipeline.py:981-982`; test `tests/test_pipeline_resume.py:269` xác nhận output folder chỉ còn manifest) và `report["output"]` là đường dẫn remote (`pipeline.py:944`) → cleanup rơi vào nhánh `elif` (`queue.py:288`) **so chuỗi với chính nó, không verify Drive**. Kịch bản mất trắng có thật. Thêm nữa: không chỉ input — `job.sqlite` + checkpoint cũng không backup tự động (`backup_job` chỉ được lệnh thủ công gọi, `backup.py:300`; stage "BACKUP" `pipeline.py:1001` chỉ upload publish artifacts rồi xóa intermediate — ngược DESIGN §7.7). Toàn bộ đã ghi lại thành [01 §1.8](01-SUA-NGAY.md) (4 lỗ hổng + 6 bước sửa + 4 fault-injection test). |
| C-02 import `run_static_ocr_samples` | ✅≡ | Đã là blocker số 1 của bộ docs từ vòng 1 — [01 §1.0a](01-SUA-NGAY.md). |
| C-03 JobStore thiếu API + prompt mất | ✅≡ | [01 §1.0b](01-SUA-NGAY.md) (đủ **4** method — bản Codex liệt kê đúng 4) + [01 §1.0c](01-SUA-NGAY.md). |
| C-04 Docker OCR vỡ giao ước args | ✅ **mới — phát hiện giá trị nhất của cross-review** | Xác nhận: `ocr.py:137-145` luôn phát `--x-scale/--y-scale/--x-offset/--y-offset`; worker ONNX có (`ocr-onnx/worker.py:116-119`), worker legacy **không** (`ocr-legacy/worker.py:58-71`) → backend `docker` chết ở argparse ngay chunk đầu; thêm args thôi chưa đủ vì legacy còn thiếu phép scale tọa độ về khung nguồn. Vòng 1-3 của em chỉ soi worker ONNX (backend đang dùng trên máy dev) — sót nhánh Docker. Đã ghi thành [01 §1.0e](01-SUA-NGAY.md), nâng số "mảnh vỡ refactor" từ 4 lên 5. |
| C-05 credential CapCut | ✅≡ có hiệu chỉnh số liệu | Đã có [01 §1.3](01-SUA-NGAY.md) từ vòng 1, nhưng con số cũ (45) lỗi thời — kiểm đếm lại: **96 file** (`device-021` … `device-116`), `.gitignore` hiện chưa có `capcut-devices/`. Đã sửa §1.3 + thêm yêu cầu rotate nếu từng chia sẻ. |

## 11.2. Nhóm CAO

| ID | Phán quyết | Chi tiết đối chiếu |
|---|---|---|
| H-01 đổi config không invalidate | ✅≡ + 1 nuance mới | Regression chính đã có ở [01 §1.7](01-SUA-NGAY.md). Nuance Codex thêm **đúng**: `logo_*` bị loại khỏi fingerprint (`config.py:188-205`, có test `test_processing_config_ignores_logo_only_changes` bảo vệ) nhưng logo **được nướng vào frame** trong vòng lặp Python (`render.py:896`) — đổi logo giữa job → chunk cũ giữ logo cũ, chunk mới logo mới, không gì báo. Đây là quyết định thiết kế có chủ đích (đổi cosmetic không re-render 6h phim) nhưng cần **ghi rõ trade-off trong config.example + cảnh báo khi đổi các key này giữa job**, hoặc chuyển logo thành lớp overlay lúc publish. |
| H-02 scene_voiceover không nối dây | ✅≡ | [01 §1.0d](01-SUA-NGAY.md), cùng đề xuất guard-raise. |
| H-03 lệch FPS OCR vs subtitles | ✅ nhận, nặng hơn đánh giá vòng 1 | Phần đứng vững qua 2 vòng: SRT/render/plan đều dùng `target_fps` → **không có drift giây trên cue**. Nhưng vòng phản biện 2 chỉ ra hậu quả nặng bị bỏ sót ở **blur**: OCR đánh frame index trên timeline 30fps (`ocr.py:100`), còn `build_blur_regions` tính `duration_frames = duration × fps_NGUỒN` (`subtitles.py:304`) rồi clamp `end_frame = min(duration_frames, ...)` (`subtitles.py:326`) — video 24fps thì `duration_frames` chỉ bằng 80% chỉ số frame thật, nên **mọi detection ở ~20% cuối phim cho ra `start_frame > end_frame` → vùng blur bị vô hiệu/mất ở cuối phim**. `build_static_blur_regions` (`subtitles.py:348,358-363`) lặp cùng lỗi: `duration_frames` và target sample tính trên timeline nguồn nhưng so với frame index 30fps → 10 frame mẫu dồn hết vào 80% đầu phim, không mẫu nào ở đoạn cuối. Không phải "vá 2 dòng sample_step" như đánh giá vòng 1 — là **3 consumer phải dùng chung một timeline** (`build_cues`, `build_blur_regions`, `build_static_blur_regions` đều nhận `target_fps` từ settings thay vì `media.fps`). Fixture 24/25/29.97/30fps + assert `start_frame ≤ end_frame` cho mọi region. Vẫn xếp Giai đoạn 1, nhưng là bugfix đúng đắn, không phải tinh chỉnh. |
| H-04 boxblur + no-audio | ✅≡ | Cả hai đã có, chi tiết hơn bản Codex: [06 §6.1](06-RENDER-AUDIT.md) (double off-by-one cả chroma, có transcript ffmpeg chứng minh) + [06 §6.2](06-RENDER-AUDIT.md) (điều kiện `has_audio` đặt sai chỗ — `pipeline.py:594`). |
| H-05 fit_audio cắt cụt âm thầm | ✅≡ | [02 §2.2](02-NANG-CAP-TTS.md) — đúng đến từng dòng (`tts.py:594-604` truncate rồi return thành công). |
| H-06 tin `remote_verified` cũ / restore `--ignore-existing` | ✅ nhận toàn phần | Gộp vào [01 §1.8](01-SUA-NGAY.md). Hiệu chỉnh vòng 1 ("cleanup tự re-verify nên không mất dữ liệu trực tiếp") đã bị rút lại cùng C-01: trong luồng Drive, local Part không còn để verify → chuỗi `remote_verified` cũ + cleanup so-chuỗi = mất dữ liệu thật. |
| H-07 không có disk guard runtime | ✅≡ | [06 §6.8](06-RENDER-AUDIT.md) — cùng giải pháp guard trước stage/chunk. |
| H-08 không git/packaging/CI | ✅≡ | [01 §1.1](01-SUA-NGAY.md) + [08 Giai đoạn 4](08-LO-TRINH-SAN-PHAM.md). Chi tiết Python pin `>=3.10,<3.11` (PKG-INFO) vs Python 3.12 trên host: đúng, đã nằm trong phạm vi "packaging phục hồi" G4 — CI chạy đúng 3.10. |
| H-09 SSRF khi tải audio TTS | ✅ **mới** | Xác nhận: `tts.py:285` chấp nhận **mọi** URL `http://`/`https://` đầu tiên tìm thấy (đệ quy toàn payload JSON) rồi `urlopen` thẳng (`tts.py:299`), không allowlist host, không chặn IP private, cho phép cả HTTP thường. Server CapCut trả payload → nếu bị chèn/đổi, VPS (đang chạy **root** — xem M-06) tải từ URL nội bộ tùy ý. Đã thêm ghi chú vào [02](02-NANG-CAP-TTS.md) cuối file. |

## 11.3. Nhóm TRUNG BÌNH + THẤP

| ID | Phán quyết | Chi tiết đối chiếu |
|---|---|---|
| M-01 chia part dùng floor | ✅ mới, nhỏ | `publish_part_count` (`pipeline.py:53-54`) = `duration // 1800` → video 31–59 phút thành **1 part 31–59 phút**; part có thể dài tới ~60 phút. Nếu ý đồ là part ≤ ~30 phút thì đổi thành `ceil`. Lưu ý DESIGN.md không ghi tường minh trần 30 phút — cần anh chốt ý đồ trước khi sửa (đổi công thức làm thay đổi số part của job đang dở). `validate_final` (`render.py:1182-1205`) check fps/duration/audio/full-decode nhưng chưa check resolution/codec — bổ sung rẻ. |
| M-02 band thiếu padding / overlay bỏ vẽ | ✅≡ | [06 §6.4](06-RENDER-AUDIT.md) + [06 §6.5](06-RENDER-AUDIT.md). |
| M-03 `fallback_chunk_seconds` chết + OCR per-frame | ✅≡ | Key chỉ tồn tại ở `config.py:33`, không nơi nào đọc — đúng; OCR theo sự kiện là toàn bộ [03](03-NANG-CAP-OCR.md). |
| M-04 model chỉ check marker, không hash lại | ✅ mới, nhỏ | `models.py:57-61`: marker `.ytb-vps-model.json` khớp `archive_sha256` là coi như "present", không hash lại file model thật → model corrupt/xóa tay vẫn qua doctor. Sửa: doctor `--live` hash lại file trong target dir (hoặc tối thiểu check tồn tại + size). Pin digest Docker base image: hợp lý, gộp vào G4. |
| M-05 stderr pipe không drain | ✅ mới, xác suất thấp | Xác nhận 2 chỗ: `ocr.py:196` (ffmpeg `stderr=PIPE` không bao giờ đọc trong lúc chạy) và `render.py:795-796` (decoder/encoder stderr chỉ đọc **sau** vòng lặp). Cả hai chạy `-loglevel error` nên bình thường stderr im lặng; nhưng khi lỗi tràn >64KB buffer → child block → treo. Sửa rẻ: `stderr=DEVNULL` cho ffmpeg OCR (đã có tail stdout của worker để chẩn đoán) hoặc drain bằng thread. Gộp vào Giai đoạn 1. |
| M-06 systemd chạy root không hardening | ✅ mới (cách sửa đã hiệu chỉnh vòng 2) | `systemd/ytb-vps.service:9-10` `User=root` + không có `NoNewPrivileges/ProtectSystem/ProtectHome...`. Kết hợp H-09 (SSRF) thì blast radius là toàn VPS. **Lưu ý vòng 2 (đúng):** đề xuất ban đầu "user riêng + group `docker`" gần như vô nghĩa về bảo mật — thành viên group docker điều khiển được Docker daemon (chạy root) nên tương đương root. Sửa đúng: user riêng **không** vào group docker + một trong ba: (a) rootless Docker cho worker OCR, (b) chuyển hẳn sang backend ONNX (không cần daemon) trên VPS production, (c) wrapper `docker run` cố định tham số qua sudoers/systemd socket riêng. Phương án (b) rẻ nhất vì ONNX đã là backend chính. |
| M-07 model slug `cx/gpt-5.5` | 🟡 ngoài khả năng kiểm chứng từ repo | Slug nằm ở `config.py:91` + `config/config.example.yaml:76`. Là alias provider riêng qua Codex CLI của anh — repo không chứng minh được nó sống. Đề xuất đúng: doctor `--live` bắn 1 smoke request đúng model trước khi nhận job. |
| L-01 docs lệch inventory | ✅ đã sửa các chỗ chỉ ra | Số credential 45→96 (sửa xong). Các mục khác của bộ docs đã tự hiệu chỉnh ở vòng 3. |
| L-02 script thử nghiệm ở root | ✅≡ | [03](03-NANG-CAP-OCR.md) cuối file — chuyển `tools/experiments/`. |
| L-03 module >1000 dòng | ✅≡ tinh thần | Đồng ý cả hai chiều: cần tách **nhưng không refactor lớn trước khi CRITICAL xanh** — trùng nguyên tắc xuyên suốt [08](08-LO-TRINH-SAN-PHAM.md). |

## 11.4. Những gì cross-review KHÔNG bắt được (đối chiếu ngược)

Để công bằng hai chiều — các phát hiện quan trọng của bộ docs này mà bản Codex không nhắc:

- Bug boxblur là **double** off-by-one (cả chroma plane, chứng minh bằng ffmpeg thật) — [06 §6.1](06-RENDER-AUDIT.md).
- `schedule_cue_subtitles` viết xong + có test nhưng không được gọi (mảnh mồ côi thứ 5, chìa khóa sync sub↔audio) — [09 §9.1](09-DICH-THUAT-CHAT-LUONG.md).
- Toàn bộ chuyên đề chất lượng dịch (gộp câu trước khi dịch, context đứng hình, story bible tắt) — [09](09-DICH-THUAT-CHAT-LUONG.md).
- Toàn bộ chuyên đề blur/logo per-video (sidecar chọn tay + tích luỹ biên) — [10](10-BLUR-LOGO-VITRI-SUB.md).
- 2 regression gộp micro-cue có test chứng minh — [02 §2.5](02-NANG-CAP-TTS.md).

## 11.5. Điều chỉnh lộ trình sau cross-review

Ba việc **thăng hạng** vào Giai đoạn 0/1 của [08](08-LO-TRINH-SAN-PHAM.md):

1. **§1.0e** (Docker OCR contract) — vào Giai đoạn 0 cùng cụm §1.0 (nếu VPS đích dùng backend docker thì đây là blocker ngang §1.0a).
2. **§1.8 bước 2** (default `cleanup_after_upload: false` cho đến khi có inbox backup) — một dòng config, làm ngay Giai đoạn 0 như "chốt an toàn dữ liệu".
3. **H-03 timeline thống nhất** (3 consumer trong `subtitles.py` dùng `target_fps` settings thay vì
   `media.fps` — sửa cả clamp `duration_frames` làm mất blur 20% cuối phim với nguồn 24fps)
   + **M-05 stderr** — gộp Giai đoạn 1, kèm fixture 24/25/29.97/30fps.

Còn lại giữ nguyên thứ tự: H-09/M-06 (bảo mật vận hành) vào Giai đoạn 4 vì chỉ phát tác trên VPS
production; M-01 chờ anh chốt ý đồ độ dài part.

## 11.6. Vòng phản biện 2 — các hiệu chỉnh của chính file này

Review độc lập phản biện lại bản phân xử đầu; kiểm chứng lại trên source xác nhận **bên review đúng
ở cả 3 điểm nặng**, và các bảng trên đã được sửa tương ứng:

1. **C-01/H-06:** khẳng định "cleanup luôn revalidate MD5" của bản phân xử đầu chỉ đúng ở mode
   local-publish; luồng Drive xóa local Part ngay sau upload (`pipeline.py:981-982`) nên cleanup
   rơi vào nhánh so-chuỗi (`queue.py:288`) — kịch bản mất trắng có thật. §1.8 đã viết lại
   (4 lỗ hổng, thêm cả `job.sqlite`/checkpoint không được backup tự động — `backup_job` chỉ có
   trong lệnh thủ công, `backup.py:300`).
2. **H-03:** đánh giá đầu ("chỉ lệch sample_step vài frame") bỏ sót clamp `duration_frames` theo
   fps nguồn (`subtitles.py:304,326,355-357`) → **mất blur ~20% cuối phim** với nguồn 24fps.
3. **M-06:** "user riêng + group docker" không giảm blast radius (group docker ≈ root) — đã thay
   bằng 3 phương án thật ở bảng trên.
4. Vặt: "Pool 45 device" còn sót trong [02](02-NANG-CAP-TTS.md) → đã sửa 96; gate G1 đổi từ
   "61+ test xanh" sang "**toàn bộ test được discover: 0 fail, 0 error**" (con số tuyệt đối sẽ
   tăng khi thêm regression test).

Bài học ghi lại cho mọi vòng sau: *mỗi khẳng định "an toàn vì có cơ chế X" phải chỉ ra được đường
chạy THẬT đi qua X trong cấu hình mặc định* — cơ chế tồn tại trong code nhưng nằm ngoài luồng
mặc định (như `remote_file_matches` chỉ chạy khi local còn file) không được tính là lưới an toàn.
