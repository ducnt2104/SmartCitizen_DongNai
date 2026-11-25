# SmartCitizen Đồng Nai — Tài liệu Giao tiếp API (`API_DOCS.md`)

> **Kiến trúc Dịch vụ:**
> - **Backend API & Local AI Router:** `http://localhost:8080`
> - **Rust High-Speed CV & ONNX Engine (Nội bộ):** `http://127.0.0.1:8001`
> - **Xác thực:** Hỗ trợ đồng thời **HTTP-only Cookies** (`sc_access`, `sc_refresh`) và `Authorization: Bearer <token>`.
> - **5 Vai trò RBAC:** `SUPER_ADMIN` (`super_admin`), `ADMIN` (`city_admin`), `OFFICER` (`ward_officer`), `YOUTH_UNION` (`volunteer`), `CITIZEN` (`citizen`).
> - **5 Nhóm sự cố:** `rac_thai`, `den_duong`, `ngap_nuoc`, `mat_duong`, `khac` (chấp nhận cả alias `OTHER`).

---

## 1. Health Check & Giám sát Hạ tầng Thật

### `GET /api/health` (và `GET /healthz`)
Kiểm tra trực tiếp ping + số lượng bản ghi MongoDB, trạng thái Rust CV Engine (`:8001`), Local LLM (`Ollama` / `llama.cpp`) và kho tri thức BM25 Local RAG.
- **Response `200 OK`:**
  ```json
  {
    "status": "ok",
    "wardsCount": 95,
    "db": {
      "mode": "mongodb",
      "ok": true,
      "latencyMs": 14.2,
      "counts": {
        "reports": 80,
        "users": 13,
        "fingerprints": 25,
        "evaluations": 42,
        "auditLogs": 19
      }
    },
    "cvEngine": {
      "online": true,
      "url": "http://127.0.0.1:8001",
      "engine": "rust-axum-cv-onnx-1.0",
      "latencyMs": 1.1,
      "indexedFingerprints": 25
    },
    "localLlm": {
      "online": true,
      "provider": "ollama",
      "model": "qwen2.5:3b",
      "latencyMs": 4.8
    },
    "rag": { "indexedDocuments": 99 }
  }
  ```

---

## 2. Xác thực Cán bộ, Super Admin & Công dân

- `POST /api/auth/admin/login` | `POST /api/auth/staff/login`
  - **Body:** `{ "staffCode": "SUPER-ADMIN", "password": "...", "unit": "city" }` *(hỗ trợ đăng nhập bằng `staffCode` hoặc `email`)*
  - **Response `200 OK`:** `{ "token": "eyJ...", "user": { "id": "u_super_admin", "role": "super_admin", "roleCode": "SUPER_ADMIN", "isActive": true, ... } }`
- `POST /api/auth/otp/request` | `POST /api/auth/otp/verify` | `POST /api/auth/password/login` | `POST /api/auth/refresh` | `POST /api/auth/logout`

---

## 3. Quản trị Hệ thống, RBAC User CRUD & Cấu hình AI Động (`SUPER_ADMIN` / `ADMIN`)

### 3.1. Danh sách & Tìm kiếm Người dùng
- **Method & URL:** `GET /api/admin/users?role=OFFICER&wardCode=DN-TB&isActive=true&q=...`
- **Response `200 OK`:** Mảng `UserProfile[]` kèm `roleCode` và `isActive`.

### 3.2. Tạo Tài khoản Mới
- **Method & URL:** `POST /api/admin/users`
- **Request Body:**
  ```json
  {
    "name": "Nguyễn Hữu Minh",
    "role": "OFFICER",
    "wardCode": "DN-TB",
    "staffCode": "CB-TB-05",
    "email": "minh.nh@dongnai.gov.vn",
    "password": "MatKhauAnToan@2026"
  }
  ```

### 3.3. Cập nhật Quyền, Địa bàn & Khóa/Mở khóa Tài khoản
- **Method & URL:** `PATCH /api/admin/users/:id`
- **Request Body:** `{ "role": "ADMIN", "wardCode": null, "isActive": false }`

### 3.4. Đặt lại Mật khẩu & Xóa Tài khoản
- `POST /api/admin/users/:id/reset-password` — Body: `{ "newPassword": "NewPassword@2026" }` → `{ "ok": true }`
- `DELETE /api/admin/users/:id` *(Chặn tự xóa chính tài khoản Super Admin đang đăng nhập)* → `{ "ok": true }`

### 3.5. Đọc & Tinh chỉnh Ngưỡng AI Động (Không cần restart)
- `GET /api/admin/ai-config` → `{ "config": { ... }, "engines": { ... }, "recentEvaluations": [ ... ] }`
- `PATCH /api/admin/ai-config`
  - **Body:**
    ```json
    {
      "screenshotThreshold": 48,
      "duplicateThreshold": 5,
      "minKeypointInliers": 15,
      "sceneMatchThreshold": 65,
      "resolutionThreshold": 75,
      "allowCloudFallback": false
    }
    ```

### 3.6. Nhật ký Hệ thống Bất biến
- `GET /api/admin/audit-logs?limit=200` | `GET /api/admin/audit/verify`

---

## 4. Phản ánh Hiện trường & Loại sự cố `OTHER` (`khac`)

- `POST /api/reports`
  - **Body:** Hỗ trợ `category: "khac"` (hoặc `"OTHER"`) kèm `aiSuggestedLabel: "Cây xanh ngã đổ"`.
  - Tự động chạy Rust CV 3 tầng chặn screenshot và quét trùng/ảnh cắt ORB+RANSAC trong bán kính `200m`.
- `POST /api/admin/reports/:id/resolve`
  - **Response `200 OK`:** Trả về `report.resolution` gồm cả **2 điểm số độc lập**: `sceneMatchScore` (0–100%), `resolutionScore` (0–100%) và `inlierKeypoints`.

---

## 5. Internal Rust CV Engine Endpoints (`http://127.0.0.1:8001`)

- `GET /health`
- `POST /cv/check-authenticity` — Body: `{ "image_base64": "...", "screenshot_threshold": 50 }`
- `POST /cv/check-duplicate` — Body: `{ "image_base64": "...", "incident_id": "...", "lat": 10.94, "lng": 106.82, "min_inliers": 15 }`
- `POST /cv/verify-resolution` — Body: `{ "before_image_base64": "...", "after_image_base64": "...", "category": "rac_thai", "scene_match_threshold": 65, "resolution_threshold": 75 }`
