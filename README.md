<div align="center">

<h1>⚡ Zeus MMO</h1>

**Resumable video localization control plane** · *sản xuất · dịch · quản lý file · render trên GPU VPS thuê theo giờ*

![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs)
![React](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.10–3.12-3776AB?logo=python&logoColor=white)
![Neon](https://img.shields.io/badge/Neon-Postgres-00E599?logo=postgresql&logoColor=white)
![Status](https://img.shields.io/badge/status-rebuild%2Fv2-blue)

</div>

---

## 📑 Table of Contents

- [✨ Overview](#-overview)
- [🎯 Highlights](#-highlights)
- [🧭 Surfaces](#-surfaces)
- [🛠 Tech Stack](#-tech-stack)
- [🚀 Getting Started](#-getting-started)
- [📂 Project Structure](#-project-structure)
- [📚 Documentation](#-documentation)
- [🔒 Security Model](#-security-model)
- [📄 License](#-license)

---

## ✨ Overview

**Zeus MMO** điều phối một pipeline bản địa hóa video: từ video nguồn trên Google Drive → OCR phụ đề gốc → sửa timing → dịch tiếng Việt → tạo giọng đọc (CapCut TTS) → thay phụ đề → render NVENC → kiểm tra → sao lưu lại Drive.

Kiến trúc tách làm hai phần độc lập:

> **Control plane** (thư mục `web/`) chỉ giữ **metadata ngắn** trong Neon/Postgres và điều phối job. Nó **không bao giờ** nhận byte video: chunk video đi thẳng từ trình duyệt đã đăng nhập tới endpoint resumable của Google Drive. GPU VPS render là một **worker** riêng, gắn vào qua Local VPS Connector.

Toàn bộ trải nghiệm người dùng là một **cockpit** dày đặc: mỗi dự án đi qua các trạng thái sẵn sàng rõ ràng (Nguồn → Scene → Worker → Job → Output) trong một giao diện duy nhất.

---

## 🎯 Highlights

- 📼 **Direct-to-Drive upload** — tải video resumable theo chunk 8 MiB thẳng lên Drive, khôi phục qua IndexedDB, hỗ trợ pause / resume / cancel / retry.
- 🧩 **Project-centric workflow** — mỗi video là một dự án; nguồn, scene, worker, job và output được theo dõi trong một inspector.
- ✂️ **Scene review** — chọn vùng blur cho phụ đề gốc và logo, cấu hình giọng cố định `BV074_streaming` với tốc độ 0.80×–1.20×, nghe thử TTS trước khi render.
- 🖥️ **GPU VPS workers** — gắn VPS thuê theo giờ qua lệnh SSH; mật khẩu chỉ đi tới Local VPS Connector trên máy bạn, không lên cloud.
- 🔁 **Resumable job state machine** — máy trạng thái job đầy đủ (`DRAFT` → … → `COMPLETED`), tự tạm dừng khi hết quota / mất worker và khôi phục lại.
- 🩺 **Free-tier health** — giám sát dung lượng Drive/Neon, tự chuyển chế độ chỉ đọc khi chạm ngưỡng an toàn.

---

## 🧭 Surfaces

Giao diện chia thành năm bề mặt, điều hướng từ sidebar:

| Surface | Vai trò |
|---|---|
| **Workspace** | Cockpit chính: hero, thẻ sẵn sàng, bảng dự án, inspector, review scene |
| **Files** | Quản lý Google Drive: cây Input/Output, upload, hàng đợi tải lên |
| **Jobs** | Theo dõi queue, worker lease, tiến trình render và upload output |
| **Workers** | Setup connector, tạo lệnh gắn VPS, kiểm tra và thu hồi worker |
| **Settings** | Kết nối, dung lượng, cấu hình scene/voice, đăng xuất phiên admin |

---

## 🛠 Tech Stack

| Layer | Technology |
|---|---|
| Web UI | Next.js 16 (App Router), React 19, TypeScript |
| Data | Neon serverless Postgres (`@neondatabase/serverless`), Zod |
| Auth | Admin key (scrypt hash) + HTTP-only session cookie |
| Storage | Google Drive OAuth (`drive.file`), resumable upload |
| Pipeline | Python 3.10–3.12, kiến trúc hexagonal (`domain`/`application`/`ports`/`adapters`) |
| Media | FFmpeg NVENC, OCR phụ đề, CapCut TTS |
| Deploy | Vercel (root `web/`), GPU VPS Ubuntu cho worker |

---

## 🚀 Getting Started

### Control plane (`web/`)

```bash
cd web
cp .env.example .env.local   # điền DATABASE_URL, ADMIN_KEY_HASH, SESSION_SECRET, OAuth…
npm ci
npm run db:migrate           # chạy 2 lần để xác nhận migration idempotent
npm run dev                  # http://localhost:3000
```

Kiểm thử & chất lượng:

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run lint      # eslint
npm run build     # next build
```

> Xem `web/README.md` để biết đầy đủ cách tạo `ADMIN_KEY_HASH`, `SESSION_SECRET`, OAuth client và credential CapCut. Các giá trị trong repo cố tình không dùng được.

### Pipeline (`src/ytb_vps_v2`)

```bash
python -m pip install -e .
ytb-vps-v2 --help   # CLI entrypoint
pytest              # tests/ và tests_v2/
```

---

## 📂 Project Structure

```
ytb-vps-scene/
├── web/                      # Next.js control plane (metadata-only, deploy lên Vercel)
│   └── src/
│       ├── app/              # App Router routes + API v1
│       ├── components/       # Zeus MMO shell + Drive/Worker/Scene/Upload UI
│       └── lib/              # domain, repositories, adapters, security
├── src/ytb_vps_v2/           # Pipeline v2 (hexagonal)
│   ├── domain/               # entities, job state machine
│   ├── application/          # use-cases điều phối
│   ├── ports/                # interface với thế giới ngoài
│   ├── adapters/             # Drive, OCR, TTS, FFmpeg…
│   └── interfaces/           # CLI
├── tests/ · tests_v2/        # pytest
├── docs/                     # tài liệu thiết kế & lộ trình (tiếng Việt)
├── DESIGN.md                 # thiết kế VPS video queue
└── CLAUDE.md                 # hướng dẫn cho Claude Code
```

---

## 📚 Documentation

| Doc | Nội dung |
|---|---|
| [`DESIGN.md`](DESIGN.md) | Thiết kế standalone VPS video queue |
| [`docs/00-TONG-QUAN.md`](docs/00-TONG-QUAN.md) | Tổng quan hệ thống |
| [`docs/08-LO-TRINH-SAN-PHAM.md`](docs/08-LO-TRINH-SAN-PHAM.md) | Lộ trình sản phẩm |
| [`docs/09-DICH-THUAT-CHAT-LUONG.md`](docs/09-DICH-THUAT-CHAT-LUONG.md) | Chất lượng dịch thuật |
| [`docs/10-BLUR-LOGO-VITRI-SUB.md`](docs/10-BLUR-LOGO-VITRI-SUB.md) | Blur logo & vị trí phụ đề |
| [`web/README.md`](web/README.md) | Cấu hình & vận hành control plane |

---

## 🔒 Security Model

- Control plane **chỉ lưu metadata**; byte video đi thẳng browser → Google Drive, Vercel không nhận video.
- Mật khẩu VPS **chỉ** gửi tới Local VPS Connector (`127.0.0.1:55871`), không lên cloud.
- Phiên admin dùng cookie HTTP-only; secret (OAuth, `DRIVE_TOKEN_KEY_V1`, CapCut device) chỉ đặt trong `.env.local` hoặc Vercel Environment Variables — không commit.
- Phạm vi OAuth giới hạn `https://www.googleapis.com/auth/drive.file`.

---

## 📄 License

Private project — không có giấy phép công khai. Mọi quyền được bảo lưu.

---

<div align="center"><sub>⚡ Zeus MMO — video localization cockpit · 2026</sub></div>
