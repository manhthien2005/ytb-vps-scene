# 09 — Dịch thuật chất lượng cao (chuyên đề vòng 3)

Mục tiêu: bản dịch **có hồn, ngắt câu tự nhiên, nhịp độ khớp giọng đọc** — thứ quyết định
người xem ở lại hay lướt đi. File này là bản thiết kế đầy đủ cho stage TRANSLATE,
tổng hợp từ audit code + đối chiếu 3 pipeline dịch sub mã nguồn mở mạnh nhất
(VideoLingo ~13k⭐, gpt-subtrans, VideoCaptioner) và nghiên cứu dịch-cho-lồng-tiếng
(SSPO ACL 2025, VideoDubber AAAI 2023).

Điều kiện tiên quyết: [01](01-SUA-NGAY.md) §1.0b (JobStore), §1.0c (prompt file),
§1.4 (story bible 6h), §1.5 (context đứng hình) phải xong trước — không có chúng thì
mọi nâng cấp dưới đây không chạy hoặc không đo được.

---

## 9.1. Vì sao bản dịch hiện tại "chưa có hồn" — 6 nguyên nhân gốc, xếp theo tác động

| # | Nguyên nhân | Bằng chứng code | Repo khác làm gì |
|---|---|---|---|
| 1 | **Dịch theo mảnh hiển thị, không theo câu.** Prompt ép "mỗi cue thành một câu Việt hoàn chỉnh; không nối cue trước/sau" — trong khi cue OCR là *dòng hiển thị*, một câu Trung dài thường trải 2–3 cue và hardsub thường không có dấu kết câu. Ép mỗi mảnh thành câu trọn vẹn → văn vụn, giọng kể rời rạc | `translation.py:149-151` | **Cả 3 repo đều gộp thành câu trước khi dịch** rồi mới chia lại theo timing: VideoLingo `_3_1/_3_2` (spaCy + LLM chèn `[br]`, chỉ-chèn-không-sửa, verify SequenceMatcher ≥0.9), VideoCaptioner `semantic.md` (`不增删改，仅插入<br>`, verify ≥0.96), gpt-subtrans cắt batch tại khoảng lặng |
| 2 | **Batch 150 cue/lần** — quá lớn để giữ mạch văn và quá đắt khi retry (1 cue hỏng → chẻ đôi đệ quy cả trăm cue) | `config.py:93` `batch_size: 150` | VideoLingo: 600 ký tự/10 câu; gpt-subtrans: max 30 min 10, **cắt tại khoảng lặng lớn nhất** giữa 2 dòng; VideoCaptioner: ~10 |
| 3 | **Không có ngữ cảnh xuôi dòng đúng nghĩa**: context 12 cue bị đứng hình trong 1 lần chạy ([01](01-SUA-NGAY.md) §1.5), story bible tắt với phim >4h (§1.4) → phim 6h chạy tươi có **zero** cơ chế nhất quán xưng hô/tên riêng | `translation.py:1004` | gpt-subtrans: model **tự viết** `<summary>`/`<scene>` cuối mỗi response, được nạp lại cho batch sau (10 summary gần nhất); VideoLingo: 3 dòng trước + **2 dòng SAU** (forward context) |
| 4 | **Một lượt dịch duy nhất, không có lượt phản tư** | `_call` một pass | VideoLingo bước 2 expressiveness (reflect: "chỗ nào wordy, chỗ nào lệch giọng" → free translation); VideoCaptioner reflect 7-checkpoint phát hiện "giọng máy dịch" + câu hỏi chốt *"người bản xứ sẽ diễn đạt ý này bằng từ nào?"* |
| 5 | **Không quản độ dài ở tầng text.** Prompt nói rõ "`seconds` không được dùng để bỏ ý — TTS xử lý sau", nhưng tầng TTS shorten là code chết ([02](02-NANG-CAP-TTS.md) §2.2) → thực tế không tầng nào quản → kéo 1.35x rồi cắt cụt | `translation.py:147-148` | Đồng thuận nghiên cứu (SSPO): **sửa độ dài trong TEXT, không phải audio** — chỉ bù tốc độ audio ≤1.2x; quá nữa gây "speaking-rate dissonance" giữa các câu liền nhau |
| 6 | **Sub hiển thị không khớp giọng đọc**: `schedule_cue_subtitles` (`render.py:50-127`) — engine phân bổ lại thời gian hiển thị cue theo cửa sổ audio TTS thật — **đã viết xong, có test xanh, nhưng pipeline không gọi** (grep: chỉ định nghĩa + test import). Một mảnh refactor mồ côi nữa, cùng họ với §1.0 | `render.py:50`, `tests/test_render_integration.py:16,32` | VideoLingo `_6_gen_sub`: timestamp lấy lại từ khớp chuỗi con với đơn vị gốc |

## 9.2. Kiến trúc đích: gộp câu → dịch → phân bổ lại

Mẫu chung cả 3 repo (đã kiểm chứng tận file nguồn):

```
cue OCR (mảnh hiển thị, có timing)
  → [T1] ghép thành CÂU hoàn chỉnh (đơn vị dịch)     ← chỉ chèn ranh giới, không sửa chữ nguồn
  → [T2] story bible + glossary CHỈ chứa term xuất hiện trong batch
  → [T3] dịch theo câu, batch nhỏ, context = tóm tắt lăn + 2 câu sau
  → [T4] phản tư chọn lọc cho câu nghi vấn
  → [T5] chia bản dịch về lại các cue thành viên (theo tỉ trọng thời lượng)
  → [T6] TTS đọc theo CÂU (group = câu), budget âm tiết
  → [T7] thời gian hiển thị sub bám theo audio thật (schedule_cue_subtitles)
```

Chi tiết từng tầng — mọi cơ chế đều có nguồn tham chiếu:

**T1 — Ghép câu (sentence assembly).** Heuristic rẻ trước: ranh giới câu khi (a) cue kết bằng
`。？！…`, (b) khoảng lặng tới cue sau > ~1.0s, (c) vượt trần ~30 chữ Hán/câu. Đoạn mơ hồ mới
hỏi Codex theo đúng hợp đồng của VideoCaptioner: *chỉ được chèn marker ranh giới, cấm thêm/bớt/sửa
chữ*, validate bằng SequenceMatcher ≥0.96 so với nguồn ghép lại, sai thì trả feedback diff và
thử lại ≤2 lần, bí quá giữ nguyên. Kết quả: bảng `sentence_units(unit_index, cue_indices,
source_text)` trong SQLite, fingerprint theo cues (pattern như `translation_prepasses` §1.0b).

**T2 — Glossary có chủ đích.** Story bible giữ nguyên (sau khi sửa §1.4), nhưng lúc dựng prompt
chỉ tiêm **những term thực sự xuất hiện trong batch** (VideoLingo `search_things_to_note_in_prompt`)
thay vì nguyên cả bible — prompt ngắn hơn, model chú ý đúng chỗ. Thêm rolling terminology map:
cho phép model trả cặp `nguồn::dịch` mới mỗi batch, chỉ nhận khi term nguồn **có mặt trong batch**
(guard chống bịa của gpt-subtrans `_update_terminology_map`).

**T3 — Dịch theo câu.** Batch 20–40 câu, **cắt batch tại khoảng lặng lớn nhất** (thuật
`_split_lines` của gpt-subtrans — ranh giới batch rơi vào chỗ ngừng hội thoại, không cắt ngang
mạch). Context gửi kèm: tóm tắt lăn do model tự viết batch trước (`<summary>`-style, cap ~240 ký
tự, giữ ≤10 cái gần nhất) + 3 câu trước đã dịch + **2 câu sau chưa dịch** (forward context).
Budget mỗi câu: `seconds × 4 âm tiết/giây` ghi thẳng vào payload (tiếng Việt ≈ 0.21–0.25s/âm
tiết — đồng hệ số với bảng của VideoLingo cho zh/ja/ko = 0.21). Giữ nguyên hợp đồng schema
per-cue hiện tại ở tầng ngoài (xem T5) để downstream không đổi.

**T4 — Phản tư chọn lọc** (nâng cấp từ [05](05-HOC-TU-REPO-KHAC.md) B6). Tiêu chí chọn: vượt
budget âm tiết >20%; chứa tên riêng chưa có trong bible; câu đầu/cuối scene. Prompt reflect theo
VideoCaptioner: soi 7 lỗi giọng-máy-dịch (bám trật tự từ nguồn, chọn từ word-by-word, lệch
register, thiếu mạch với câu quanh...) rồi trả `native_translation` với câu hỏi dẫn *"nếu người
kể chuyện bản xứ nói ý này, họ dùng đúng những từ nào?"*; cho phép thành ngữ/tục ngữ Việt khi tự
nhiên. KHÔNG reflect 100% cue (phim 6h = gấp đôi chi phí Codex) — đo bằng report B5 trước/sau.

**T5 — Phân bổ lại về cue.** Bản dịch câu chia về các cue thành viên theo tỉ trọng **thời lượng
cue** (không phải đếm chữ nguồn), ưu tiên cắt tại ranh giới từ/cụm; trường hợp khó → 1 call align
(VideoLingo `get_align_prompt`, được phép "viết lại nhẹ cho khớp"). Quy ước hiển thị: cue chưa
kết câu **không** thêm "…" (quy tắc VideoCaptioner — cue sau nối tiếp tự nhiên; "…" chỉ dành cho
câu bị bỏ lửng thật trong nguồn). Sau T5, mỗi cue vẫn có đúng một `target_text` — schema, SRT,
blur, checkpoint đều nguyên vẹn.

**T6 — TTS theo câu.** `group_cues` nhận thêm ranh giới sentence_units: group không được cắt
ngang câu (hard boundary), budget group = tổng slot cue thành viên + `min(gap sau, slot_borrow)`.
Ước lượng `estimate_tts_seconds = âm_tiết × 0.21 + dấu_câu × 0.1` **trước khi** gọi CapCut
([05](05-HOC-TU-REPO-KHAC.md) A2); dự đoán vượt `hard_fit_speed` → shorten trước, khỏi đốt
request. Thang fit + `TtsFitError` ([02](02-NANG-CAP-TTS.md) §2.2) là lưới an toàn cuối.

**T7 — Hiển thị khớp audio.** Nối `schedule_cue_subtitles` vào `_render_ready_chunks`
(hiện pipeline dùng thẳng frame OCR — đúng khi mix window == slot, **sai dần khi bật
overflow/spill** [06](06-RENDER-AUDIT.md) §6.9). Kèm quyết định `display_shortened_text: true`
([07](07-KIEM-THU.md) §7.2): chữ trên hình luôn là chữ TTS đang đọc.

## 9.3. Lộ trình 3 bước — mỗi bước tự đứng được, đo được

| Bước | Gồm | Đổi code | Nghiệm thu |
|---|---|---|---|
| **D1 — Prompt & batch** (làm ngay sau Phase 1 của [08](08-LO-TRINH-SAN-PHAM.md)) | Sửa §1.4+§1.5; `batch_size` 150→30; context thêm tóm tắt lăn + forward 2 cue; bỏ rule "mỗi cue một câu hoàn chỉnh" → "dịch theo mạch câu; cue giữa câu viết thành vế tự nhiên, không tự chế câu trọn vẹn"; budget `âm tiết ≈ seconds × 4`/cue; chỉ thị giọng kể chuyện + license thành ngữ; giữ rule sửa lỗi OCR theo ngữ cảnh (đã có, khớp bài instructions-OCR của gpt-subtrans). `PROMPT_REVISION` 10→11 | chỉ `translation.py` + config | Report B5 trên cùng 1 tập: tỷ lệ cue cần >1.2x giảm; đọc mù 20 cue liên tiếp: bản mới mạch lạc hơn bản cũ (đánh giá tay 1 lần) |
| **D2 — Sentence units** | T1 + T3 + T5 (bảng `sentence_units`, batch cắt theo khoảng lặng, phân bổ lại) | `translation.py` + `state.py` (1 bảng mới) | Suite xanh; số câu bị "vụn" (cue 1 câu cụt <4 từ) giảm rõ trong report; fixture 30s: text ghép lại == text nguồn (invariant T1) |
| **D3 — TTS theo câu + display sync** | T6 + T7 + reflect chọn lọc T4 | `tts.py` `group_cues`, `pipeline.py` nối `schedule_cue_subtitles` | Nghe mù 3 đoạn 2 phút: nhịp đọc tự nhiên, không câu nào đứt giữa; sub đổi đúng lúc giọng đọc sang câu mới |

## 9.4. Những thứ KHÔNG làm (đã cân nhắc, ghi lại để khỏi bàn lại)

- **Reflect 100% cue** — gấp đôi chi phí Codex cho phim 6h; chọn lọc đủ (T4).
- **Bỏ per-cue schema chuyển hẳn sang dịch tự do theo đoạn** — đó chính là mode
  `scene_voiceover` đã có sẵn trong cây ([01](01-SUA-NGAY.md) §1.0d): một sản phẩm KHÁC
  (video kể lại tự do), không phải nâng cấp của mode dịch sub. Nối dây nó riêng, đừng trộn.
- **Dịch 2 chiều (back-translation) để tự chấm điểm** — đắt, tín hiệu yếu hơn reflect trực tiếp.
- **Đổi model dịch giữa job** — model nằm trong cache signature, đổi giữa chừng = dịch lại từ đầu.

## 9.5. Ràng buộc chung

1. Mỗi thay đổi prompt/logic → tăng `PROMPT_REVISION` (`translation.py:79`); D2 thêm
   fingerprint bảng `sentence_units` vào signature dịch.
2. Batch nhỏ hơn = nhiều call Codex hơn (~5x số call, cùng tổng token) — theo dõi quota;
   nếu chạm trần, `batch_size: 50` là điểm lùi đầu tiên.
3. Giữ nguyên bất biến resume: mọi bảng mới đều có fingerprint nguồn; đổi cues → tự vô hiệu.
4. Mọi số đo "hay hơn" phải đi qua report B5 ([05](05-HOC-TU-REPO-KHAC.md)) trên **cùng một tập
   phim** — không nghiệm thu bằng cảm giác trên các video khác nhau.
