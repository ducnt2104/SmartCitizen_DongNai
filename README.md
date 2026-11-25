# SmartCitizen Đồng Nai 2.0 — Phản ánh Hiện trường & Đô thị Thông minh (Team Victer)

> 🌐 **Cổng Trực tuyến Chính thức:** [https://smartcitizen-dongnai.onrender.com/](https://smartcitizen-dongnai.onrender.com/)  
> 🔗 Truy cập nhanh: [Trang chủ](https://smartcitizen-dongnai.onrender.com/) · [Bản đồ sự cố 95 Phường/Xã](https://smartcitizen-dongnai.onrender.com/map) · [Gửi phản ánh 3 bước](https://smartcitizen-dongnai.onrender.com/report) · [Tra cứu hồ sơ](https://smartcitizen-dongnai.onrender.com/mine) · [Giới thiệu & Team Victer](https://smartcitizen-dongnai.onrender.com/gioi-thieu)

Nền tảng **SmartCitizen Đồng Nai** (**Phản ánh hiện trường Đồng Nai** & **Đô thị thông minh Đồng Nai**) do **Team Victer** phát triển, phục vụ toàn bộ **95 Phường/Xã Thành phố Đồng Nai** (**33 Phường** và **62 Xã**) trên kiến trúc **Hybrid Local-First AI**, **Rust/Sharp + ONNX CV**, **SMS OTP thật (+84)** và **MongoDB Atlas**.

---

## 1. Kiến trúc Nâng cấp Toàn diện

1. **Rust High-Speed Computer Vision & ONNX Engine (`engine/` — cổng `127.0.0.1:8001`):**
   - **Kiểm định ảnh thật / Chặn ảnh chụp màn hình 3 tầng (`POST /cv/check-authenticity`):** Kết hợp EXIF Forensics (`kamadak-exif` + bảng độ phân giải màn hình thiết bị), phân tích dải thanh trạng thái/điều hướng UI 8% đầu–cuối + phổ **2D FFT Moiré** (`rustfft`) phát hiện chụp lại màn hình, và mô hình **ONNX Neural Classifier** cục bộ (`models/authenticity_defect_v1.onnx`).
   - **Phát hiện Ảnh Cắt (Crop Sub-image) & Trùng lặp (`POST /cv/check-duplicate`):** Lưới băm đa tỷ lệ (`dHash`, `2D-DCT pHash`, `3×3 Grid`, `Center-Crop`) kết hợp trích xuất đặc trưng góc đa tầng **5-Octave ORB + kiểm chứng hình học RANSAC (`>= 15` inliers)** song song bằng `rayon` POPCNT (< 20ms).
   - **Nghiệm thu Trước – Sau bất biến ánh sáng & góc chụp (`POST /cv/verify-resolution`):** Tách bạch **Điểm đúng hiện trường (`scene_match_score` ≥ 65%)** dùng chuẩn hóa sáng **8×8 CLAHE + RANSAC Alignment** và **Điểm khắc phục sự cố (`resolution_score` ≥ 75%)** trên vùng ROI đã căn chỉnh.

2. **Local-First LLM Router, Streaming SSE & BM25 Local RAG (`backend/`):**
   - Kết nối trực tiếp **Ollama** (`http://127.0.0.1:11434`, mặc định `qwen2.5:3b`) hoặc **llama.cpp** với **Streaming SSE (`text/event-stream`)**.
   - Tích hợp **Okapi BM25 Local RAG** đánh chỉ mục toàn bộ **95 Phường/Xã TP. Đồng Nai**, quy trình xử lý 5 nhóm sự cố (gồm cả **`khac` / `OTHER`** kèm `aiSuggestedLabel`) và bộ nhớ đệm `LruCache` (< 3ms).
   - Chỉ gọi Cloud Gemini khi Quản trị viên bật tường minh `ALLOW_CLOUD_AI_FALLBACK=true`.

3. **MongoDB Atlas Real Persistence (`backend/src/repositories/` & `models/`):**
   - Nạp `.env` đa đường dẫn (`root/.env` & `backend/.env`), kết nối `MONGODB_URI` với cơ chế retry 3 lần và **chặn hoàn toàn việc âm thầm rơi về mock/RAM giả** (`ALLOW_JSON_FALLBACK=false`).
   - Lưu bền vững đầy đủ các collection: `reports` (GeoJSON `2dsphere`), `app_users`, `image_fingerprints`, `ai_evaluations`, `ai_configs`, `audit_logs` (chuỗi băm SHA-256 bất biến).

4. **Hệ thống Super Admin, RBAC 5 Cấp & Admin Console (`backend/` + `frontend/`):**
   - 5 cấp vai trò: `SUPER_ADMIN`, `ADMIN` (`city_admin`), `OFFICER` (`ward_officer` gắn với 1 trong 95 Phường/Xã), `YOUTH_UNION` (`volunteer`), `CITIZEN`.
   - Giao diện **Quản trị Hệ thống** trên IOC Command Center: CRUD tài khoản, đổi quyền, khóa/mở khóa tức thì, reset mật khẩu, theo dõi ping/số bản ghi thực tế của MongoDB + Rust CV + Local LLM và thanh trượt tinh chỉnh ngưỡng AI động không cần restart server.

---

## 2. Khởi chạy Nhanh (1 Lệnh cho Toàn bộ Hệ thống)

**Yêu cầu:** Node.js `>= 20`, npm `>= 10`, Rust `cargo >= 1.75` (tùy chọn cài thêm `Ollama` cho Local LLM).

```powershell
# 1. Cài dependencies cho Backend & Frontend
npm run install:all

# 2. Tạo file cấu hình môi trường và điền MONGODB_URI, SUPER_ADMIN_PASSWORD, INITIAL_STAFF_PASSWORD
Copy-Item .env.example .env

# 3. Biên dịch Rust CV Engine (release) & khởi tạo model ONNX cục bộ vào thư mục models/
powershell -ExecutionPolicy Bypass -File scripts/download_models.ps1

# 4. Nạp dữ liệu chuẩn Idempotent (Super Admin + 95 Phường/Xã + Hồ sơ mẫu Đồng Nai)
npm run seed

# 5. Khởi chạy đồng thời toàn bộ hệ thống (Rust CV :8001 + Backend :8080 + Frontend :5173)
powershell -ExecutionPolicy Bypass -File scripts/start_all.ps1
```

*(Hoặc chạy từng dịch vụ riêng biệt: `npm run dev:engine`, `npm run dev:backend`, `npm run dev:frontend`).*

### Tùy chọn bật Local LLM tiếng Việt với Ollama:
```bash
ollama pull qwen2.5:3b
ollama serve
```

---

## 3. Kiểm thử & Xác minh Chất lượng

```bash
# Kiểm tra kiểu tĩnh TypeScript (Backend + Frontend)
npm run typecheck

# Chạy Unit Test của Rust CV & ONNX Engine
npm run test:engine

# Chạy toàn bộ Integration & Unit Test (Backend + Rust Live Binary + Frontend)
npm test

# Build bản Production hoàn chỉnh
npm run build
```

*Phát triển bởi **Team Victer** — Thành phố Đồng Nai.*
