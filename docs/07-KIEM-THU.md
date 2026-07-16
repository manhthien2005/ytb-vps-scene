# 07 — Kiểm thử: đưa suite về xanh (chẩn đoán sẵn từng test)

Trạng thái đo (lần cuối: vòng audit 3, 2026-07-16, máy dev Windows):
**unittest báo "Ran 62 tests: 8 FAIL + 9 ERROR"** — trong đó 1 "test" là pseudo-test của loader
cho module `test_pipeline_resume` không import nổi (tính là 1 ERROR), tức 61 test thật
+ 8 FAIL + 8 ERROR logic. Danh sách tên test đầy đủ đã đối chiếu đúng 1-1 với bảng dưới.

Cách chạy (pytest chưa cài; chú ý encoding console Windows):
```bash
PYTHONPATH="app;." PYTHONIOENCODING=utf-8 python -m unittest discover -s tests -t .
```

> Nguyên tắc quan trọng: **các test này là "đặc tả hành vi cũ còn sống sót" sau đợt refactor dở**
> (xem [01-SUA-NGAY.md](01-SUA-NGAY.md) §1.0). Mặc định tin TEST, sửa CODE. Chỉ sửa test khi
> có quyết định thiết kế rõ ràng (đánh dấu ⚖️ bên dưới).

## Bảng chẩn đoán

| Test | Loại | Nguyên nhân gốc | Sửa ở đâu |
|---|---|---|---|
| `test_pipeline_resume` (cả module) | ERROR import | `run_static_ocr_samples` không tồn tại | [01](01-SUA-NGAY.md) §1.0a |
| `test_config_queue.test_background_backup_*` (2 test) | ERROR | `patch("ytb_vps.pipeline...")` chết vì import pipeline fail | [01](01-SUA-NGAY.md) §1.0a (tự khỏi) |
| `test_translation.test_story_prompt_*` (2) + `test_second_shorten_pass_uses_current_text` | ERROR | Thiếu file `prompt_dich_sub_trung_ke_chuyen.txt` | [01](01-SUA-NGAY.md) §1.0c |
| `test_render_integration.test_bounded_render_audio_mux_and_decode` | ERROR | Bug boxblur radius == giới hạn | [06](06-RENDER-AUDIT.md) §6.1 |
| `test_render_integration.test_mirror_video_flips_frame_before_output` | ERROR | Cùng bug boxblur | [06](06-RENDER-AUDIT.md) §6.1 |
| `test_state.test_processing_config_change_invalidates_completed_work` | FAIL | `initialize_job` mất logic reset khi config đổi | [01](01-SUA-NGAY.md) §1.7 |
| `test_media_subtitles.test_subtitle_band_*` (3 test) | FAIL | Band auto mất padding + mất thuật toán percentile | [06](06-RENDER-AUDIT.md) §6.4 |
| `test_tts.test_fit_audio_preserves_overflow_at_speed_cap` | ERROR (KeyError `overflow_seconds`) | `fit_audio` đã bị đổi sang **cắt cụt tại slot**; thiết kế cũ giữ phần tràn + báo `overflow_seconds` | [02](02-NANG-CAP-TTS.md) §2.2 — test này chính là bằng chứng thiết kế cũ |
| `test_tts.test_micro_cue_merges_with_nearby_successor_on_new_job` | FAIL | Gộp micro-cue bị khoá sau cờ `merge_adjacent_cues` (default False) — trước đây độc lập | [02](02-NANG-CAP-TTS.md) §2.5 |
| `test_tts.test_pending_micro_cue_borrows_full_gap_across_render_boundary` | FAIL | Mượn slot qua ranh giới chunk cho micro-cue bị khoá sau `allow_tts_spill` (default False) | [02](02-NANG-CAP-TTS.md) §2.5 |
| `test_tts.test_fit_audio_preserves_internal_silence` | FAIL (1.130 < 1.15) | Silence trim ăn ~70ms **mép** audio thật (không phải khoảng lặng giữa) | xem §7.1 dưới |
| `test_tts.test_tts_text_override_updates_display_cues` | FAIL ⚖️ | Default `apply_tts_text_overrides(enabled=)` bị lật True→False giữa refactor | xem §7.2 dưới |

## §7.1 — Silence trim ăn mép audio (chẩn đoán thêm)

Fixture: 1.4s audio có khoảng lặng 0.1s đầu / 0.4s giữa / 0.1s cuối. Kỳ vọng sau trim ≥ 1.15s
(chỉ cắt 2 đầu → còn 1.2s); thực tế 1.1298s — cắt lẹm ~70ms vào sóng sin thật ở mép.
Nghi phạm: `silenceremove` với `start_duration 0.02` + ngưỡng -45dB cắt cả đoạn sóng
mở đầu còn nhỏ (fade-in tự nhiên của sine qua điểm 0). Có thể lệch theo phiên bản FFmpeg.
**Hướng sửa:** nới `silence_trim_threshold_db` xuống -50…-55 hoặc thêm lề giữ lại 30-50ms
(`silenceremove` không hỗ trợ trực tiếp — dùng `start_duration` dài hơn, ví dụ 0.1).
Với giọng nói thật, cắt lẹm 70ms phụ âm đầu là nghe được → đáng sửa, không phải "sửa test cho qua".

## §7.2 — ⚖️ Quyết định thiết kế: phụ đề hiển thị theo bản TTS rút gọn hay bản dịch gốc?

- Khi Codex rút gọn câu để TTS đọc vừa slot, phụ đề trên hình có nên đổi theo không?
- Test cũ nói **có** (default True); code hiện tại default **False** ở cả hàm
  (`tts.py:40-44`) lẫn pipeline (`display_shortened_text`, `pipeline.py:529/564`).
- **Khuyến nghị: True** — tiếng đọc và chữ hiện phải khớp nhau, lệch nhau người xem nhận ra ngay.
  Bằng chứng phụ: file `.patch` bỏ dở ở root (đã xoá trong vòng audit 3, nội dung ghi tại
  [01](01-SUA-NGAY.md) §1.2) cho thấy chính người refactor định đặt `enabled: bool = True`.
  Sửa default ở cả 2 chỗ + thêm `display_shortened_text` vào `config.example.yaml`.
  Nếu giữ False thì phải sửa test và ghi rõ lý do vào docs này.

## Lỗ hổng coverage nên bổ sung SAU khi xanh (không chặn)

1. **Resume giữa TTS** — kill process giữa `_synthesize_groups`, chạy lại, assert không gọi lại
   CapCut cho group DONE (mock client đếm call).
2. **Render chunk với band mỏng** (h < kernel) — gate cho §6.1 khỏi tái phát.
3. **Video không audio stream** đi hết pipeline — gate cho §6.2.
4. **Đổi config giữa job** (sau §1.7) — stage nào reset, stage nào giữ.
5. **`_render_chunk_ready` với group tràn slot** — gate cho §6.9 khi bật spill.

## Thứ tự thi công đề xuất

```
1. [01] §1.0a+1.0c (mở khoá 6 ERROR import/prompt)   → chạy lại suite
2. [06] §6.1 boxblur (2 ERROR render)                 → chạy lại suite
3. [01] §1.7 config invalidation (1 FAIL)
4. [06] §6.4 band padding (3 FAIL)
5. [02] §2.2 overflow + §2.5 micro-cue (3 FAIL/ERROR)
6. §7.1 silence trim (1 FAIL)  +  §7.2 quyết định rồi sửa (1 FAIL)
→ Suite xanh 100% = điều kiện để bắt đầu mọi nâng cấp lớn (03, 05, 08).
```
