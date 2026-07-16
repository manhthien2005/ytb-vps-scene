# 02 — Nâng cấp TTS (chất lượng giọng đọc + độ bền)

Ba vấn đề: (A) code có sẵn nhiều tầng xử lý chất lượng nhưng **config đang tắt gần hết**;
(B) tầng "viết ngắn lại" hiện là **code chết** — không config nào bật lại được (phát hiện vòng 2);
(C) CapCut là điểm hỏng duy nhất chưa có dự phòng.

## Bối cảnh cần hiểu trước

- Mỗi câu thoại (cue) có một "slot" thời gian = khoảng nó xuất hiện trên màn hình.
- Tiếng Việt đọc thường **dài hơn** tiếng Trung → audio TTS hay dài hơn slot.
- Khi audio dài hơn slot, `fit_audio` (`tts.py:505-623`) xử lý theo thang:
  1. Cắt khoảng lặng đầu/cuối (silence trim).
  2. Tăng tốc audio (atempo) tối đa `max_fit_speed`, trần cứng `hard_fit_speed`.
  3. Nếu vẫn dài → **CẮT CỤT** audio đúng tại slot (`tts.py:594-604`) — mất chữ cuối câu.
- Trên lý thuyết còn tầng cứu: nhờ Codex **viết ngắn lại** câu rồi TTS lại (`tts.py:845-902`).
  Thực tế tầng này KHÔNG BAO GIỜ chạy — xem 2.2.

---

## 2.1. Config đang vô hiệu hoá các tầng chất lượng

**Gốc rễ:** default trong `config.py` (DEFAULTS, dòng 105-129) — lưu ý default thật nằm ở đây,
`config.example.yaml` chỉ là override:

| Key | Giá trị hiện tại | Hệ quả |
|---|---|---|
| `shorten_attempts: 0` | tắt | Không bao giờ nhờ Codex rút gọn (kể cả khi sửa xong 2.2) |
| `slot_borrow_seconds: 0.0` | tắt | Không "mượn" khoảng lặng sau cue → slot ngắn hơn mức có thể |
| `allow_tts_spill: False` + `micro_spill_seconds: 0.0` | tắt | Câu chớp nhoáng (<0.8s) không được tràn nhẹ sang khoảng trống sau nó |
| `merge_adjacent_cues: False` (mặc định, không có trong yaml) | tắt | Cue ngắn liền kề không được gộp → nhiều request CapCut hơn, đọc ngắt quãng hơn. **Cảnh báo vòng 2:** cờ này còn khoá luôn cả nhánh gộp micro-cue cũ — xem 2.5 |
| `max_fit_speed: 1.35` == `hard_fit_speed: 1.35` | quá cao & bằng nhau | Mọi câu dài bị kéo thẳng lên 1.35x (nghe rõ bị nhanh — pyvideotrans đo ngưỡng "không nghe ra" là ≤1.2x); hai trần bằng nhau nên "vùng đệm" giữa tốc độ thường và trần cứng biến mất |

**Kịch bản thực tế hiện tại:** câu Việt dài → kéo 1.35x → vẫn dài → **cắt cụt giữa từ**, metadata
vẫn báo "thành công" (`trimmed_to_slot: true`).

**Giá trị đề xuất (sửa cả `config.py` DEFAULTS lẫn `config.example.yaml`, cần soak-test):**
```yaml
tts:
  shorten_attempts: 2
  slot_borrow_seconds: 1.5
  merge_adjacent_cues: true
  max_fit_speed: 1.15
  hard_fit_speed: 1.30
```
**Lưu ý cho agent:** các key này nằm trong TTS group signature v8 (`tts.py:71-91`) — đổi config
sẽ tự vô hiệu cache TTS cũ và tổng hợp lại. Đúng thiết kế, nhưng job đang dở sẽ tốn thêm request
CapCut. Áp dụng cho job mới.

---

## 2.2. Tầng "viết ngắn" là CODE CHẾT — `fit_audio` không bao giờ raise `TtsFitError`

**Phát hiện vòng 2 (nặng hơn nhận định vòng 1).** Vòng 1 mô tả "thứ tự thang fit chưa tối ưu";
sự thật tệ hơn: **toàn bộ chuỗi cứu hộ không thể kích hoạt.**

**Chứng minh:** caller bắt `TtsFitError` để gọi Codex shorten (`tts.py:845-902` — điều kiện
`isinstance(exc, TtsFitError)`), nhưng **không tồn tại điểm ném ban đầu**: `fit_audio` khi quá dài
thì tăng tốc đến trần rồi **cắt cụt và return thành công** (`tts.py:594-604`), không raise.
Lưu ý cho người kiểm tra lại: grep sẽ thấy `TtsFitError(` ở `tts.py:882` và `tts.py:904` —
cả hai đều nằm **bên trong nhánh `except` chỉ chạy khi `exc` đã là `TtsFitError`** (re-wrap),
tức vòng tròn không có lối vào; `raise last_error` ở dòng 925 vì thế không bao giờ ném được nó.
Bằng chứng thứ hai: test `test_fit_audio_preserves_overflow_at_speed_cap` ERROR vì thiếu key
`overflow_seconds` trong metadata — thiết kế cũ khi vượt trần là **giữ nguyên phần tràn**
(scheduler `_scheduled_tts_groups` vẫn còn nguyên logic xô đẩy ở `render.py:23-47`)
chứ không cắt. Ai đó đã thay bằng cắt-tại-slot giữa refactor.

**Cách sửa (khôi phục thang 4 bậc đúng):** trong `fit_audio`:
1. `required_speed <= max_speed` → tăng tốc bình thường (như hiện tại).
2. `required_speed <= hard_speed` → tăng tốc đến mức cần (như hiện tại).
3. `required_speed > hard_speed` → **raise `TtsFitError`** (đủ metadata: `raw_seconds`,
   `slot_seconds`, `required_speed`, `hard_speed`) để caller thử Codex shorten.
4. Caller hết `shorten_attempts` mà vẫn không vừa → chọn theo config
   `tts.overlong_policy: truncate | overflow` (default `truncate` cho an toàn hôm nay):
   - `truncate`: cắt tại slot như hiện tại **nhưng** ghi metadata `truncated: true` để query được
     "N group bị cắt" sau job.
   - `overflow`: giữ phần tràn + metadata `overflow_seconds` (phục hồi hành vi test cũ mô tả) —
     scheduler đã biết xô đẩy; **bắt buộc làm cùng ràng buộc [06-RENDER-AUDIT.md](06-RENDER-AUDIT.md)
     §6.9** (render-ready phải nhìn thấy mix window tràn, nếu không sẽ mất tiếng đầu chunk).

**Kiểm tra:** unit test audio cần 1.6x → raise TtsFitError; sau 2 lần shorten fail →
truncate + `truncated: true`; mode overflow → metadata có `overflow_seconds` (test cũ xanh lại).

---

## 2.3. Thêm kênh TTS dự phòng (edge-tts) — chuyển "chết job" thành "đổi giọng"

**Vấn đề:** CapCut client là protocol không chính thức (vendor/NOTICE.md tự ghi chưa rõ quyền
phân phối). Pool 96 device + cooldown khi bị chặn (`CapCutSharkBlock`, `tts.py:28-37`) cho thấy
đang chạy sát giới hạn anti-abuse. CapCut đổi API giữa một job 3 ngày → toàn pipeline đứng,
không có phương án B. VideoLingo/pyvideotrans/KrillinAI đều có nhiều backend TTS, đều kèm edge-tts.

**Cách làm (phác thảo):**
1. Interface: `synthesize(text, output_path) -> None` — `CapCutClient.synthesize` đã đúng dạng.
2. `EdgeTtsClient` mới (~50 dòng, pip `edge-tts`; giọng `vi-VN-HoaiMyNeural` / `vi-VN-NamMinhNeural`,
   miễn phí, không credential, chạy CPU).
3. Config: `tts.provider: capcut | edge | capcut_then_edge` (fallback khi pool cạn/bị chặn kéo dài).
4. **Quan trọng:** thêm `provider` + `voice` vào group signature (`tts.py:71-91`, version 8→9)
   để audio 2 kênh không dùng lẫn cache; ghi provider vào metadata group.
5. Chính sách trộn giọng: mặc định **không trộn trong một video** — fallback chỉ từ đầu job,
   hoặc có cảnh báo rõ; override bằng config khi chấp nhận đổi giọng giữa chừng.

**Kiểm tra:** doctor thêm check `edge-tts-live`; test chặn giả lập toàn pool CapCut →
job tiếp tục bằng edge thay vì treo vô hạn ở `acquire_client` (`tts.py:398-436`).

---

## 2.4. Chế độ suy giảm có kiểm soát cho group hỏng dai dẳng

**Vấn đề:** 1 group fail hết retry → cả job dừng (`tts.py:923-925` raise). Phim 6h (~4.000 cue),
một câu "độc" giữ con tin job nhiều ngày.

**Học từ pyvideotrans:** dòng lẻ hỏng → silence + báo cáo; chỉ fail job khi vượt ngưỡng.

**Cách làm:** config `tts.failed_group_policy: fail | silence` + `tts.max_silent_groups: 5`.
Khi `silence`: group hết retry commit bằng `synthesize_silence` (có sẵn, `tts.py:631-655`) +
metadata `degraded: true`; vượt ngưỡng mới fail job. Cuối job log "N group thay bằng silence" —
SQLite đủ dữ liệu để redo thủ công từng group sau.

**Kiểm tra:** group fail vĩnh viễn → job hoàn thành + silence + degraded; group thứ 6 → fail như cũ.

---

## 2.5. (Vòng 2) Hai regression gộp micro-cue — có test chứng minh

Hai test fail (xem [07-KIEM-THU.md](07-KIEM-THU.md)) chỉ ra hành vi cũ đã mất trong `group_cues`
(`tts.py:94-205`):

1. **Gộp micro-cue với cue kế** (`test_micro_cue_merges_with_nearby_successor_on_new_job`):
   cue chớp nhoáng ≤0.8s cách cue sau ≤0.6s từng được gộp **vô điều kiện** (tránh tốn 1 request
   CapCut cho một từ "Ừ."). Nay nhánh gộp nằm sau cờ `merge_adjacent_cues` (dòng 182-196 —
   `should_keep_short_group` bắt đầu bằng `merge_adjacent_cues and ...`, và nhánh else
   `if not merge_adjacent_cues: flush(...)`) mà default False → hành vi mất.
2. **Micro-cue mượn slot qua ranh giới chunk** (`test_pending_micro_cue_borrows_full_gap_across_render_boundary`):
   từng được mượn `micro_cue_borrow` (1.0s) kể cả qua chunk boundary khi nằm trong
   `micro_borrow_indices`; nay bị `allow_tts_spill=False` + `micro_spill_seconds: 0.0` khoá
   (dòng 133-143 — `allow_micro_borrow = allow_tts_spill and ...`).

**Cách sửa:** tách logic micro-cue khỏi 2 cờ lớn: micro-cue merge chạy khi `merge_micro_cues=True`
(tham số đã có sẵn) **bất kể** `merge_adjacent_cues`; micro borrow dùng `micro_spill_seconds`
default 1.0 như thiết kế cũ, không phụ thuộc `allow_tts_spill`. Lưu ý `micro_spill_seconds`
đã bị loại khỏi `processing_config` fingerprint (`config.py:206`) — đổi default không vô hiệu
checkpoint cũ. Acceptance = 2 test xanh.

---

## Ghi chú vận hành pool device (vòng 2, không cần sửa gấp)

- `device-pool-state.json` ghi file **mỗi lần** acquire/success/block (`tts.py:387-388`, `_save()`
  trong lock) — 5 worker × hàng nghìn group = hàng chục nghìn lần ghi JSON nhỏ. Chấp nhận được
  trên NVMe; nếu nghẽn I/O thì gom save theo chu kỳ (>1s).
- Cooldown cố định 100s: nếu CapCut khoá **vĩnh viễn** một device, pool vẫn thử lại mãi mỗi 100s.
  Nâng cấp nhẹ: backoff luỹ tiến theo `failures` (100s × 2^min(failures,6)) — ~10 dòng, làm cùng 2.3.

---

## Ghi chú bảo mật tải audio (vòng cross-review — làm cùng Giai đoạn 4)

`_download_audio` nhận URL đầu tiên tìm thấy khi quét đệ quy toàn payload JSON của CapCut
(`tts.py:285` — chấp nhận cả `http://`) rồi `urlopen` thẳng (`tts.py:299`) — không allowlist host,
không chặn IP private/link-local, không giới hạn kích thước. Service lại đang chạy root
(`systemd/ytb-vps.service`). Payload bị chèn/đổi → SSRF vào mạng nội bộ VPS.

**Sửa (rẻ, ~15 dòng):** chỉ nhận `https://`; allowlist đuôi hostname CDN CapCut/ByteDance quan sát
được từ log thật; resolve DNS và từ chối IP private/loopback/link-local; cap kích thước tải (ví dụ
50MB) + timeout hiện có. Kèm hạ quyền systemd (user riêng + hardening) — xem [11 §11.3 M-06](11-DOI-CHIEU-CROSS-REVIEW.md).
