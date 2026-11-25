# SmartCitizen Đồng Nai

> **Cổng Trực tuyến:** [https://smartcitizen-dongnai.onrender.com/](https://smartcitizen-dongnai.onrender.com/)  
> **Truy cập nhanh:** [Trang chủ](https://smartcitizen-dongnai.onrender.com/) · [Bản đồ 95 Phường/Xã](https://smartcitizen-dongnai.onrender.com/map) · [Gửi phản ánh](https://smartcitizen-dongnai.onrender.com/report) · [Tra cứu hồ sơ](https://smartcitizen-dongnai.onrender.com/mine) · [Giới thiệu](https://smartcitizen-dongnai.onrender.com/gioi-thieu)

Nền tảng **SmartCitizen Đồng Nai** (**Phản ánh hiện trường & Đô thị thông minh TP. Đồng Nai**) do **Team Victer** phát triển, phục vụ **95 Phường/Xã** (**33 Phường**, **62 Xã**) trên kiến trúc **Local-First AI**, **Rust CV/ONNX Engine**, **MongoDB Atlas**, **Multi-Key Gemini Rotation Pool** và **Xác thực OTP Email / SMS (+84)**.

---

## 1. Cấu trúc Thư mục

```text
SmartCitizen_DongNai/
├── backend/                 # Express + TypeScript API, MongoDB Atlas & SQLite/JSON persistence, Local RAG, KeyPool, OTP, RBAC
│   ├── src/
│   │   ├── config/          # Nạp env, kết nối MongoDB Atlas & graceful shutdown
│   │   ├── controllers/     # REST controllers (báo cáo, AI, cảnh báo, điều phối, quản trị)
│   │   ├── middleware/      # Auth JWT/Cookie, PoW/anti-bot, rate limit, multer upload, Zod validate
│   │   ├── models/          # Mongoose schemas & immutable audit log
│   │   ├── repositories/    # Tầng truy xuất dữ liệu (MongoDB Atlas + SQLite/JSON local persistence)
│   │   ├── routes/          # Khai báo endpoints (/api/*, /api/auth/*, /api/admin/api-keys/*)
│   │   ├── scripts/         # CLI seed, verifyDb, migrateIndexes, purgeDemo
│   │   ├── seed/            # Dữ liệu khởi tạo chuẩn 95 Phường/Xã & tài khoản quản trị
│   │   ├── services/        # Nghiệp vụ AI, Rust CV client, KeyPool AES-256-GCM, OTP/SMS, Staff/Rescue
│   │   ├── shared/          # Hằng số, tọa độ, 95 Phường/Xã, types dùng chung
│   │   └── utils/           # Crypto, nén Brotli/Gzip, LRU cache, sanitize, SSR/SEO
│   └── tests/               # Bộ kiểm thử tích hợp & E2E (Vitest)
├── frontend/                # React 18 + Vite + TypeScript + Tailwind CSS + Dexie IndexedDB + Google Maps/MapLibre
│   ├── public/              # Tài nguyên tĩnh, manifest PWA, Service Worker, Google verification
│   └── src/
│       ├── components/      # UI components, bản đồ GIS, xác thực OTP, điều hướng cứu hộ
│       ├── db/              # IndexedDB (Dexie) & Outbox đồng bộ
│       ├── hooks/           # GPS & định vị trực tiếp
│       ├── i18n/            # Song ngữ Việt / Anh
│       ├── lib/             # API client, local CV/vision, navigation engine, SEO meta
│       ├── pages/           # Trang công dân, cổng cứu hộ (/rescue) & IOC Admin (/ioc, /admin)
│       ├── shared/          # Hằng số, địa giới 95 Phường/Xã & types đồng bộ với backend
│       ├── state/           # Providers (AuthGate, Settings, Toast)
│       ├── tests/           # Unit tests Frontend (Vitest)
│       └── workers/         # Web Workers xử lý ảnh & edge CV
├── engine/                  # Rust High-Speed CV & ONNX Engine (127.0.0.1:8001)
├── models/                  # Thư mục lưu trọng số ONNX cục bộ (tạo bởi scripts/download_models.*)
├── scripts/                 # download_models.ps1/.sh, start_all.ps1, render-compat.mjs
├── client/ & server/        # Compatibility shims cho cấu hình build/start cũ trên Render
├── .github/workflows/       # keepalive.yml giữ Render Free Service luôn ấm
├── .env.example             # Mẫu biến môi trường tổng hợp
├── render.yaml              # Blueprint cấu hình deploy Single-Service trên Render
└── package.json             # Scripts điều phối toàn workspace
```

> Tài liệu chi tiết API xem tại [`backend/API_DOCS.md`](backend/API_DOCS.md).

---

## 2. Hướng dẫn Chạy Local

**Yêu cầu:** Node.js `>= 20`, npm `>= 10`, Rust `cargo >= 1.75` (tùy chọn cài thêm `Ollama` cho Local LLM).

```powershell
# 1. Cài dependencies cho Backend & Frontend
npm run install:all

# 2. Tạo file cấu hình môi trường từ mẫu và điền thông số (MONGODB_URI, JWT_SECRET, ...)
Copy-Item .env.example .env

# 3. Biên dịch Rust CV Engine (release) & khởi tạo model ONNX cục bộ vào models/
powershell -ExecutionPolicy Bypass -File scripts/download_models.ps1

# 4. Nạp dữ liệu chuẩn Idempotent (tài khoản khởi tạo + 95 Phường/Xã)
npm run seed

# 5. Khởi chạy đồng thời Backend (:8080 + Rust CV :8001) và Frontend (:5173)
powershell -ExecutionPolicy Bypass -File scripts/start_all.ps1
```

Hoặc chạy từng dịch vụ riêng biệt:

```bash
npm run dev:engine    # Rust CV Engine (:8001)
npm run dev:backend   # Backend API (:8080)
npm run dev:frontend  # Frontend Vite (:5173)
```

*(Tùy chọn bật Local LLM tiếng Việt với Ollama: `ollama pull qwen2.5:3b && ollama serve`.)*

---

## 3. Kiểm thử & Build Production

```bash
# Kiểm tra kiểu tĩnh TypeScript (Backend + Frontend)
npm run typecheck

# Chạy toàn bộ bộ kiểm thử (Backend + Frontend)
npm test

# Kiểm tra Unit Test của Rust CV Engine
npm run test:engine

# Build bản Production hoàn chỉnh (Backend + Frontend + Render Compat Bridge)
npm run build
```

---

## 4. Hướng dẫn Deploy trên Render

Dự án cấu hình theo mô hình **Single Web Service** trong [`render.yaml`](render.yaml) (Backend phục vụ API và `frontend/dist` tĩnh):

- **Build Command:**
  ```bash
  npm install --include=dev --prefix backend && npm install --include=dev --prefix frontend && npm run build
  ```
- **Start Command:**
  ```bash
  npm start
  ```
- **Health Check Path:** `/healthz`
- **Biến môi trường chính trên Render Dashboard:**
  - Tự sinh qua `render.yaml`: `JWT_SECRET`, `OTP_PEPPER`, `KEY_ENCRYPTION_SECRET`
  - Bắt buộc cấu hình bảo mật trên Dashboard: `MONGODB_URI`, `SUPER_ADMIN_PASSWORD`, `INITIAL_STAFF_PASSWORD`
  - Tùy chọn AI / Maps / OTP: `GEMINI_API_KEYS` (hoặc `GEMINI_API_KEY`), `VITE_GOOGLE_MAPS_API_KEY`, `RESEND_API_KEY` / `BREVO_API_KEY` / `SMTP_*`, `TEXTBEE_*` / `FIREBASE_*` / `VONAGE_*`.

---

*Phát triển bởi **Team Victer** — Thành phố Đồng Nai.*
