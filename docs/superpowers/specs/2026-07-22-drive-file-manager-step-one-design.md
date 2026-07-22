# Bước 1 — Drive File Manager

**Trạng thái:** thiết kế được duyệt qua mockup ngày 22/07/2026  
**Phạm vi:** thay giao diện và luồng dữ liệu của bước 1 trong YTB VPS Studio

## 1. Mục tiêu

Biến bước 1 thành một trình quản lý file Drive gọn, quen thuộc và đủ thông tin để:

- theo dõi file nguồn trong `input` và file render trong `output`;
- thêm video bằng nút chọn file hoặc kéo thả;
- theo dõi, tạm dừng, tiếp tục hoặc huỷ lượt tải;
- xem metadata của video sau khi mở rộng hàng file;
- mở video trong Google Drive khi Drive đã xử lý xong;
- tải xuống hoặc xoá video ngay tại màn hình này.

Không hiển thị các mô tả dài, thống kê quota hoặc nội dung “Kho video riêng tư”. Video không được proxy qua Vercel.

## 2. Bố cục đã duyệt

### Header Drive

- Logo Google Drive, nhãn `Drive` và trạng thái kết nối nằm trên một hàng nhỏ.
- Khi chưa kết nối, trạng thái được thay bằng nút `Kết nối` hoặc `Kết nối lại`.
- Khi đã kết nối, có thể hiển thị account hint đã che bớt; thao tác ngắt kết nối nằm trong menu phụ, không chiếm diện tích chính.

### Hai cây thư mục

Bên dưới header là hai cột bằng nhau:

- `Input`: cây `YTB-VPS/input`, nút `+ Thêm video` và vùng nhận kéo thả.
- `Output`: cây `YTB-VPS/output`, trong đó mỗi phim là một folder và các part render là file con.

Desktop hiển thị hai cột. Mobile xếp `Input` trên `Output`.

Folder và file phải nhìn khác nhau ngay lập tức:

- folder dùng icon folder màu vàng và chevron mở/đóng;
- video dùng icon file-video màu xanh/tím;
- không dùng cùng một hình dạng hoặc chỉ dựa vào màu sắc để phân biệt;
- icon có nhãn truy cập phù hợp, còn icon trang trí bị ẩn khỏi screen reader.

### Hàng file đóng

Mặc định mỗi video chỉ hiện:

- chevron;
- icon file-video;
- tên file;
- dung lượng đã đổi sang MB hoặc GB, không hiện byte.

Click vào hàng hoặc nhấn Enter/Space sẽ mở rộng. Mỗi cây chỉ cần giữ trạng thái mở/đóng theo `fileId`; cho phép nhiều file mở đồng thời.

### Hàng file mở rộng — phương án B

Vùng mở rộng có chiều cao nhỏ, dùng ba stat icon:

1. thời gian hệ thống xác nhận upload hoàn tất;
2. thời lượng video;
3. độ phân giải, ví dụ `1920 × 1080`.

Phía dưới là trạng thái ngắn:

- `Drive đang xử lý` khi upload đã hoàn tất nhưng `videoMediaMetadata` chưa xuất hiện;
- `Sẵn sàng xem` khi có đủ `durationMillis`, `width`, `height` và `webViewLink`;
- `Chưa xác định` khi Drive chưa trả metadata sau thời gian chờ hoặc kiểm tra gặp lỗi tạm thời.

Góc phải có các nút icon kèm tooltip và accessible name:

- `Xem trước`: disabled khi chưa sẵn sàng; khi enabled mở `webViewLink` trong tab mới với `noopener,noreferrer`;
- `Tải xuống`: dùng link download do Drive cung cấp và không proxy byte qua Vercel;
- `Xoá video`: icon thùng rác, dùng màu cảnh báo khi hover/focus.

Thao tác xoá luôn yêu cầu xác nhận có tên file. UI khoá nút trong lúc gửi yêu cầu, chỉ bỏ file khỏi cây sau khi Drive xác nhận thành công. Không hỗ trợ xoá cả folder output trong phạm vi này; người dùng xoá từng file video để tránh xoá hàng loạt ngoài ý muốn.

## 3. Hàng đợi tải lên

Hàng đợi nằm trọn chiều ngang dưới hai cây và chỉ xuất hiện khi có mục đang chờ, đang tải, tạm dừng, lỗi hoặc vừa hoàn tất.

Header hiển thị `Hàng đợi tải lên` và tổng số video. Mỗi mục hiển thị:

- tên video;
- dung lượng MB/GB;
- thời lượng nếu browser đọc được metadata local;
- thời gian ước tính còn lại khi có tốc độ đủ ổn định;
- progress bar và phần trăm;
- lượng đã tải / tổng dung lượng ở đơn vị MB/GB.

Hành động của từng mục:

- `Tạm dừng` khi đang upload;
- `Tiếp tục` khi đã tạm dừng;
- `Dừng và huỷ` để huỷ hẳn phiên upload, có xác nhận khi đã tải được dữ liệu;
- `Thử lại` khi lỗi có thể phục hồi.

Nút phải có icon, tooltip và accessible name rõ ràng. Không chỉ dùng ký hiệu `Ⅱ` hoặc `■` mà thiếu giải thích. Huỷ upload phải gọi cleanup hiện có để không để artifact ở trạng thái `UPLOADING`.

## 4. Dữ liệu Drive và trạng thái xử lý

Drive file adapter được mở rộng để lấy metadata theo phạm vi các file do ứng dụng quản lý:

- `id`, `name`, `mimeType`, `size`, `parents`;
- `createdTime`, `modifiedTime`;
- `videoMediaMetadata(width,height,durationMillis)`;
- `webViewLink`, `webContentLink`;
- `trashed` và `appProperties` để kiểm tra file thuộc workspace.

Danh sách cây được trả từ một endpoint metadata đã xác thực. Endpoint chỉ trả các trường public cần cho UI, không trả access token, folder ID nội bộ không cần thiết hoặc app properties nhạy cảm.

Thời gian hiển thị cho video nguồn ưu tiên timestamp `uploadCompletedAt` do control plane lưu khi xác nhận đủ byte. `createdTime` của Drive chỉ là fallback vì hệ thống tạo file rỗng trước khi upload nội dung.

Google Drive API không cung cấp trạng thái video processing chính thức. UI dùng quy tắc suy luận:

1. Upload chưa hoàn tất: trạng thái thuộc hàng đợi, chưa đưa vào nhóm sẵn sàng.
2. Upload hoàn tất nhưng thiếu `videoMediaMetadata`: `Drive đang xử lý`.
3. Có đủ video metadata và `webViewLink`: `Sẵn sàng xem`.
4. Lỗi poll hoặc chờ quá lâu: giữ file, hiện `Chưa xác định` và cho phép kiểm tra lại.

Client chỉ poll khi trang đang visible và còn file ở trạng thái processing. Dùng backoff có giới hạn thay vì poll liên tục; refresh cây ngay sau upload, xoá hoặc khi người dùng bấm thử lại.

## 5. Ranh giới component

- `DriveWorkspace`: quản lý header, trạng thái kết nối và ghép các vùng của bước 1.
- `DriveFileTree`: render một cây Input hoặc Output và điều khiển folder/file expansion.
- `DriveFileRow`: hàng file đóng/mở, metadata và ba hành động file.
- `VideoDropzone`: nút chọn nhiều video và drag/drop, chuyển file cho upload queue hiện có.
- `UploadQueue`: giữ state machine upload hiện tại và bổ sung presentation gọn, pause/resume/cancel/retry rõ ràng.
- `DriveWorkspaceService`: lấy tree metadata, kiểm tra processing readiness và xoá file qua các port hiện có.

Component giao diện không nhận access token và không tự gọi Google API trực tiếp. Mọi thao tác metadata/xoá đi qua endpoint cùng origin đã xác thực; upload byte vẫn đi thẳng từ browser tới resumable session của Drive.

## 6. Trạng thái lỗi và rỗng

- Drive chưa kết nối: giữ khung hai cột ở trạng thái disabled gọn và tập trung vào nút `Kết nối`.
- Folder rỗng: hiện một dòng empty state ngắn; Input vẫn nhận drag/drop.
- Lỗi tải cây: giữ layout, hiện retry trong đúng cột lỗi; không làm mất hàng đợi local.
- Lỗi xoá: file vẫn ở cây, mở lại nút và hiện thông báo tại hàng file.
- File bị xoá ngoài ứng dụng: lần refresh tiếp theo bỏ file khỏi cây.
- Link xem/tải không còn hợp lệ: refresh metadata một lần rồi yêu cầu thử lại; không log URL chứa capability nhạy cảm.
- Drive xử lý lâu: không biến thành lỗi upload; trạng thái vẫn là processing/unknown và tải xuống vẫn khả dụng sau khi upload đã được xác minh.

## 7. Khả năng truy cập và responsive

- Cây dùng button/ARIA phù hợp cho chevron và `aria-expanded` trên hàng có thể mở.
- Mọi icon hành động có tooltip lẫn accessible name.
- Trạng thái không chỉ phân biệt bằng màu; luôn có text ngắn.
- Focus ring rõ ràng và hỗ trợ bàn phím.
- Trên màn hình hẹp, hai cây xếp dọc; stat tự wrap; tên file ellipsis nhưng có tooltip/title đầy đủ.
- Vùng drag/drop không phải con đường duy nhất; nút chọn file luôn hoạt động bằng bàn phím.

## 8. Kiểm thử

### Unit/application

- Parse và giới hạn metadata Drive, bao gồm int64 duration/size.
- Phân loại `PROCESSING`, `READY` và `UNKNOWN`.
- Chỉ trả file thuộc root/app properties được quản lý.
- Xoá đúng file, xử lý idempotent khi file đã biến mất và từ chối ID ngoài workspace.
- Download/view URLs được lọc đúng host/protocol trước khi trả cho client.

### Component

- Hàng đóng chỉ có tên và dung lượng.
- Click hoặc bàn phím mở phương án B và render đúng stat.
- Folder/video có icon và semantic khác nhau.
- Nút xem disabled khi processing, enabled khi ready.
- Xoá có confirm, loading, success và failure state.
- Drag/drop và file picker cùng enqueue đúng nhiều video.
- Pause, resume, cancel và retry gọi đúng upload state machine.
- Queue hiển thị MB/GB, phần trăm và ETA; không hiển thị byte thô.
- Layout mobile vẫn giữ đủ hành động và không tràn ngang.

### Route/security

- Endpoint tree/delete yêu cầu admin session và từ chối request không hợp lệ.
- Response không lộ OAuth token, internal folder IDs hoặc app properties không cần thiết.
- Delete không được dùng để xoá folder hoặc file ngoài workspace quản lý.

## 9. Tiêu chí nghiệm thu

- Bước 1 chỉ còn header Drive, hai cây file và hàng đợi; không còn card mô tả/quota cũ.
- Input và Output hiển thị đúng tree thật từ Google Drive.
- Folder và video không thể bị nhầm lẫn bằng cả icon lẫn cấu trúc cây.
- File đóng chỉ hiện tên và dung lượng MB/GB.
- File mở đúng layout phương án B với upload time, duration, resolution, processing state và các nút icon.
- Preview chỉ mở được khi video metadata và `webViewLink` đã sẵn sàng.
- Download không proxy video qua Vercel.
- Người dùng xoá được từng video sau bước xác nhận và không thể xoá nhầm folder.
- Người dùng kéo thả hoặc chọn nhiều video, xem progress/%/ETA và tạm dừng, tiếp tục hoặc huỷ từng lượt.
- Tất cả trạng thái quan trọng dùng được bằng bàn phím và rõ ràng trên mobile.

## 10. Ngoài phạm vi

- Preview video trực tiếp bên trong YTB VPS Studio.
- Xoá hàng loạt hoặc xoá cả folder output.
- Di chuyển, đổi tên hoặc tạo folder thủ công.
- Proxy thumbnail hoặc video byte qua Vercel.
- Cam kết tuyệt đối trạng thái encode nội bộ của Drive ngoài các metadata được API công bố.
