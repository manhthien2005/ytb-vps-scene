# YTB VPS Studio — Workflow, Drive, VPS Connector và Review

**Status:** thiết kế đã được duyệt qua mockup, chờ duyệt đặc tả trước khi triển khai
**Ngày:** 2026-07-20

## 1. Mục tiêu

Biến dashboard hiện tại thành một workflow có thứ tự rõ ràng:

`Drive → VPS → Review → Render`

Người dùng chỉ cần:

1. Chọn/tải video nguồn vào Google Drive.
2. Dán chuỗi SSH từ CKEY và nhập mật khẩu trong trình duyệt.
3. Chờ Local VPS Connector setup và self-test.
4. Kéo các hình chữ nhật blur, nghe thử TTS, lưu cấu hình.
5. Bấm render; worker tải nguồn, render trên GPU và đưa kết quả vào Drive.

Vercel là control plane (giao diện, metadata, trạng thái, queue), không phải nơi trung chuyển video hoặc nơi lưu mật khẩu VPS.

## 2. Google Drive — chỉ hai thư mục quản lý

Trong thư mục gốc `YTB-VPS`, hệ thống chỉ tạo và duy trì hai thư mục con:

```text
YTB-VPS/
├── input/
│   └── <film-name>.mp4
└── output/
    └── <film-name>/
        ├── part-01-of-04.mp4
        ├── part-02-of-04.mp4
        ├── part-03-of-04.mp4
        └── part-04-of-04.mp4
```

- Không tạo `YTB-VPS/projects` hoặc thư mục project UUID trong Drive.
- File nguồn nằm trực tiếp dưới `input`.
- Mỗi phim có một thư mục con dưới `output`; đây là cấp nhóm duy nhất cần thêm để giữ output gọn.
- Tên hiển thị của phim được giữ trong giao diện; tên thư mục/file dùng slug an toàn, Unicode được chuẩn hóa và ký tự nguy hiểm bị loại bỏ.
- Project metadata, blur plan, voice plan và job state nằm trong Neon; Drive chỉ chứa media/folder cần quản lý.
- Migration phải giữ khả năng đọc các project cũ, sau đó chuyển dần file hợp lệ về layout mới và không xóa dữ liệu cũ nếu chưa có xác nhận.

### Drive adapter/API

- `ensureWorkspace()` đảm bảo root `YTB-VPS`, `input`, `output` tồn tại và có đúng app properties.
- `ensureSourceFile()` tạo/kiểm tra file nguồn dưới `input`.
- `ensureOutputProjectFolder()` tạo/kiểm tra `output/<film-slug>`.
- `ensureOutputFile()` dùng tên part xác định, app properties chứa project/job/part index và tổng số part.
- Dashboard chỉ gọi một endpoint metadata để lấy danh sách `input` và các film folders trong `output`; không proxy byte video qua Vercel.

## 3. Gắn VPS bằng Local VPS Connector

### Trải nghiệm người dùng

Ô nhập nhận chuỗi dạng:

```text
ssh root@n1.ckey.vn -p 1210
```

và một ô mật khẩu. Parser trích xuất `user`, `host`, `port`, chỉ cho phép cú pháp SSH hợp lệ và không truyền nguyên chuỗi vào shell.

### Ranh giới bảo mật

- Trình duyệt gửi thông tin VPS cho connector chạy trên `127.0.0.1`, không gửi mật khẩu lên Vercel.
- Connector giữ mật khẩu trong bộ nhớ trong thời gian setup, không ghi file/log và xóa reference sau khi xong.
- Vercel cấp một enrollment intent/token dùng một lần; token này không phải mật khẩu VPS.
- Connector chỉ bind loopback, yêu cầu nonce phiên và kiểm tra Origin để tránh trang khác gọi vào.
- Worker sau khi cài gọi ngược HTTPS về Vercel bằng worker key; Vercel chỉ lưu worker identity, capabilities, heartbeat và trạng thái.

### Các bước setup idempotent

1. `CONNECTING`: mở SSH và xác thực.
2. `CHECKING_GPU`: kiểm tra `nvidia-smi`, model, VRAM, CUDA, disk và network.
3. `INSTALLING_RUNTIME`: cài/kiểm tra Python venv, FFmpeg và runtime cần thiết; không dùng Docker.
4. `INSTALLING_WORKER`: tải worker release theo repository + commit đã pin, tạo config từ enrollment token.
5. `STARTING_SERVICE`: tạo service tự khởi động lại và giới hạn quyền cần thiết.
6. `SELF_TEST`: chạy render clip nhỏ, kiểm tra đọc/ghi Drive và báo checksum/bytes.
7. `READY`: worker nhận job; nếu lỗi, trạng thái là `FAILED` kèm thông báo đã làm sạch.

Mỗi bước có timestamp, phần trăm tương đối, thông điệp ngắn và nút thử lại. Setup chạy lại phải an toàn, không cài trùng hoặc làm mất worker đang hoạt động.

### Trạng thái hiển thị

`NOT_CONNECTED → CONNECTING → CHECKING_GPU → INSTALLING_RUNTIME → INSTALLING_WORKER → SELF_TEST → READY`
Nhánh lỗi: `FAILED` (có nguyên nhân và hành động tiếp theo), nhánh thu hồi: `REVOKED`.

## 4. Upload và xử lý lỗi hiện tại

Production đã tái hiện lỗi API `DRIVE_PROVIDER_REJECTED` khi tạo resumable session, dù OAuth Drive đã kết nối. Artifact của project test bị để ở trạng thái `UPLOADING`, khiến lần thử khác trả `UPLOAD_REMOTE_MISMATCH`.

Trong implementation:

- Khởi tạo resumable session theo đúng hợp đồng Google Drive: PATCH update, body rỗng có `Content-Length: 0` rõ ràng, header upload content type/length hợp lệ.
- Ở lỗi provider 4xx/5xx, giữ mã lỗi ổn định cho UI và đưa reservation/artifact về trạng thái retryable; không để artifact treo vô thời hạn ở `UPLOADING`.
- Thêm recovery cho artifact `UPLOADING` quá hạn và hiển thị lỗi cụ thể (Drive cần xác thực lại, provider từ chối, quota, hoặc phiên hết hạn).
- Không log access token, mật khẩu VPS hoặc nội dung video.

## 5. Review trước render

- Sau khi chọn file, browser tạo object URL và preview trực tiếp; video không đi qua Vercel.
- Vùng blur chỉ là hình chữ nhật, tọa độ lưu chuẩn hóa theo kích thước video (`x`, `y`, `width`, `height` trong khoảng 0–1).
- Có hai loại vùng: `logo` (blur) và `subtitle` (che subtitle gốc theo style đã chọn).
- TTS preview dùng voice có sẵn trong browser, không phát sinh API trả phí. Voice/rate/text được lưu trong `voicePlan`.
- Review lưu một `renderPlan` versioned gồm vùng, style, voice, part settings và source artifact.
- Khi mở lại project mà browser không còn file local, giao diện hiển thị cấu hình đã lưu và yêu cầu chọn lại nguồn để preview; không tải video lớn qua Vercel.

## 6. Render và output

- Job payload chỉ chứa IDs, `renderPlan`, part settings và output folder ID; worker tự lấy source từ Drive.
- Worker tạo `output/<film-slug>` nếu chưa có, render từng part và upload trực tiếp vào folder đó.
- Tên part xác định theo tổng số part: `part-01-of-04.mp4`, `part-02-of-04.mp4`, …; không ghi đè output của job khác nếu plan version khác.
- Dashboard hiển thị queue, worker, tiến độ từng part, link Drive và checksum/size sau khi xác minh.
- Job retry phải idempotent: part đã VERIFIED không render lại trừ khi người dùng tạo plan version mới.

## 7. Layout giao diện

Dashboard dùng stepper cố định và mỗi bước có một nhiệm vụ chính:

1. **Drive:** hai tile `input`/`output`, upload, chọn project và danh sách output theo phim.
2. **VPS:** SSH command + password local-only, progress setup, GPU facts, self-test, READY badge.
3. **Review:** video preview, kéo rectangle, TTS preview, lưu render plan.
4. **Render:** tóm tắt plan, chọn số part, nút render, queue/progress và output links.

Card trạng thái tổng hợp ở đầu trang luôn trả lời ba câu: nguồn đã sẵn sàng chưa, VPS đã READY chưa, output gần nhất ở đâu.

## 8. Acceptance criteria

- Google Drive root sau setup chỉ có `input` và `output` (ngoài các dữ liệu cũ đang chờ migration).
- Một project mới upload được file vào `input` và không còn lỗi generic khi provider từ chối; lỗi/retry có trạng thái rõ.
- Nhập SSH command + password khởi động Local Connector; mật khẩu không xuất hiện trong Network request tới Vercel, DB hoặc log.
- Connector báo được từng bước setup và kết thúc ở `READY` hoặc `FAILED` có nguyên nhân.
- Review blur/TTS chạy mượt với file local mà không upload bytes qua Vercel.
- Render một phim 4 part tạo đúng folder/file names trong `output/<film-slug>` và xác minh đủ bytes.
- Worker restart/reconnect không tạo duplicate output hoặc mất render plan.

## 9. Ngoài phạm vi bản đầu

- Tracking logo di chuyển hoặc blur theo chuyển động.
- Nhiều tài khoản Drive/người dùng cộng tác.
- Vercel SSH trực tiếp vào VPS.
- Docker runtime bắt buộc.
- Proxy video lớn qua Vercel.
