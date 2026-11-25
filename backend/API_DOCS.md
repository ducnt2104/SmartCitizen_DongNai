# SmartCitizen Đồng Nai — Tài liệu Giao tiếp API (`API_DOCS.md`)

> **Quy ước Phối hợp Backend (Người A) ↔ Frontend (Người B):**
> - **Base URL Local:** `http://localhost:8080` (Vite Dev Proxy chuyển tiếp `/api` và `/healthz` sang cổng `8080`).
> - **Content-Type:** `application/json; charset=utf-8` (trừ endpoint streaming SSE `/api/ai/chat` trả `text/event-stream`).
> - **Xác thực (Auth):** Hỗ trợ đồng thời **HTTP-only Cookies** (`sc_access`, `sc_refresh` với `credentials: 'include'`) và header `Authorization: Bearer <accessToken>`.
> - **Chuẩn định dạng lỗi chung:**
>   ```json
>   {
>     "error": {
>       "code": "validation_error",
>       "message": "Thông báo lỗi tiếng Việt rõ ràng cho UI",
>       "details": []
>     }
>   }
>   ```

---

## 1. Hệ thống, Địa giới 95 Phường/Xã & GIS

### 1.1. Kiểm tra sức khỏe hệ thống
- **Method & URL:** `GET /healthz` (hoặc `GET /api/health`)
- **Request Body:** Không có
- **Response `200 OK`:**
  ```json
  {
    "status": "ok",
    "wardsCount": 95,
    "db": { "mode": "mongo", "fallbackReason": null },
    "ai": { "configured": true, "model": "gemini-3.5-flash" },
    "otp": { "emailConfigured": true, "smsConfigured": false }
  }
  ```

### 1.2. Danh sách 95 ĐVHC Phường/Xã TP. Đồng Nai (Hỗ trợ HTTP `ETag` / `304`)
- **Method & URL:** `GET /api/wards`
- **Request Body:** Không có
- **Response `200 OK`:**
  ```json
  {
    "wards": [
      {
        "code": "P-TRTRANGBIEN",
        "name": "Phường Trấn Biên",
        "type": "phuong",
        "region": "central",
        "lat": 10.9574,
        "lng": 106.8426
      }
    ],
    "total": 95
  }
  ```

### 1.3. Reverse Geocoding 3 tầng
- **Method & URL:** `GET /api/geo/reverse?lat=10.9574&lng=106.8426`
- **Request Body:** Không có
- **Response `200 OK`:**
  ```json
  {
    "inBounds": true,
    "displayAddress": "Đường Hà Huy Giáp, Phường Trấn Biên, TP. Đồng Nai",
    "wardCode": "P-TRANBIEN",
    "wardName": "Phường Trấn Biên",
    "confidence": "high",
    "source": "nominatim"
  }
  ```

### 1.4. Thống kê tổng quan theo phạm vi
- **Method & URL:** `GET /api/stats?wardCode=optional`
- **Request Body:** Không có
- **Response `200 OK`:**
  ```json
  {
    "total": 120,
    "pending": 18,
    "inProgress": 27,
    "resolved": 75,
    "slaOnTimeRate": 0.94
  }
  ```

---

## 2. Xác thực, OTP Thật & Hồ sơ Người dùng

### 2.1. Kiểm tra trạng thái kênh OTP
- **Method & URL:** `GET /api/auth/otp/status`
- **Response `200 OK`:**
  ```json
  {
    "emailConfigured": true,
    "smsConfigured": false,
    "activeEmailProvider": "resend",
    "activeSmsProvider": null
  }
  ```

### 2.2. Yêu cầu gửi mã OTP thật
- **Method & URL:** `POST /api/auth/otp/request`
- **Request Body:**
  ```json
  {
    "identifier": "congdan@example.com",
    "channel": "email",
    "purpose": "login"
  }
  ```
- **Response `200 OK`:**
  ```json
  {
    "sent": true,
    "channel": "email",
    "maskedTarget": "co***@example.com",
    "expiresInSeconds": 300,
    "cooldownSeconds": 60
  }
  ```

### 2.3. Xác minh mã OTP & Đăng nhập
- **Method & URL:** `POST /api/auth/otp/verify`
- **Request Body:**
  ```json
  {
    "identifier": "congdan@example.com",
    "code": "123456",
    "name": "Nguyễn Văn A"
  }
  ```
- **Response `200 OK`:** *(đồng thời set HTTP-only cookies `sc_access`, `sc_refresh`)*
  ```json
  {
    "session": {
      "token": "eyJhbGciOiJIUzI1NiIs...",
      "user": {
        "id": "usr_01",
        "name": "Nguyễn Văn A",
        "role": "citizen",
        "email": "co***@example.com",
        "trustScore": 70
      }
    }
  }
  ```

### 2.4. Đăng nhập bằng mật khẩu / Đăng nhập Cán bộ IOC
- **Method & URL:** `POST /api/auth/password/login` | `POST /api/auth/staff/login`
- **Request Body (`password/login`):**
  ```json
  {
    "identifier": "congdan@example.com",
    "password": "MatKhauAnToan123"
  }
  ```
- **Request Body (`staff/login`):**
  ```json
  {
    "staffCode": "TP-01",
    "password": "MatKhauCanBoIOC"
  }
  ```
- **Response `200 OK`:** Trả đối tượng `{ "session": { "token": "...", "user": { ... } } }`.

### 2.5. Đặt lại mật khẩu bằng OTP / Làm mới phiên / Đăng xuất
- `POST /api/auth/password/reset` — Body: `{ "identifier": "...", "code": "123456", "newPassword": "..." }` → `{ "session": { ... } }`
- `POST /api/auth/refresh` — Body: `{}` (đọc cookie `sc_refresh`) → `{ "session": { ... } }`
- `POST /api/auth/logout` — Body: `{}` → `{ "ok": true }`
- `POST /api/auth/logout-all` *(Auth required)* — Body: `{}` → `{ "ok": true }`

### 2.6. Thông tin cá nhân & Thông báo
- `GET /api/me` *(Auth required)* → `{ "user": { ... }, "notifications": [ ... ] }`
- `PATCH /api/me/profile` *(Auth required)* — Body: `{ "name": "...", "defaultWardCode": "...", "newPassword": "..." }` → `{ "user": { ... } }`
- `POST /api/me/notifications/read` *(Auth required)* — Body: `{ "ids": ["ntf_1"] }` → `{ "ok": true }`

---

## 3. Phản ánh Hiện trường (Reports)

### 3.1. Danh sách điểm ghim siêu nhẹ cho Bản đồ GIS (BBox Summary)
- **Method & URL:** `GET /api/reports/summary?bbox=106.7,10.6,107.5,12.0&wardCode=&category=&status=`
- **Response `200 OK`:**
  ```json
  {
    "items": [
      {
        "id": "rpt_01",
        "code": "DN-2026-0001",
        "lat": 10.9574,
        "lng": 106.8426,
        "category": "infrastructure",
        "priority": "high",
        "status": "received",
        "wardCode": "P-TRANBIEN",
        "confirmCount": 4,
        "createdAt": "2026-11-25T01:00:00.000Z"
      }
    ]
  }
  ```

### 3.2. Danh sách phản ánh chi tiết (Cursor Pagination)
- **Method & URL:** `GET /api/reports?wardCode=&category=&status=&q=&cursor=&limit=20`
- **Response `200 OK`:**
  ```json
  {
    "items": [ { "id": "rpt_01", "code": "DN-2026-0001", "title": "Sụt lún mặt đường", "...": "..." } ],
    "nextCursor": "2026-11-24T12:00:00.000Z|rpt_20"
  }
  ```

### 3.3. Tra cứu mã hồ sơ / Hồ sơ của tôi / Chi tiết phản ánh
- `GET /api/reports/lookup?code=DN-2026-0001` → `{ "report": { ... } }`
- `GET /api/reports/mine` *(Auth required)* → `{ "items": [ ... ] }`
- `GET /api/reports/:id` → `{ "report": { ... } }`

### 3.4. Gửi phản ánh mới
- **Method & URL:** `POST /api/reports` *(Auth required)*
- **Request Body:**
  ```json
  {
    "title": "Nắp cối thoát nước bị vỡ gây nguy hiểm",
    "description": "Nắp cống gãy đôi ngay khúc cua trường học, nước ngập sâu.",
    "category": "infrastructure",
    "lat": 10.9574,
    "lng": 106.8426,
    "wardCode": "P-TRANBIEN",
    "address": "120 Hà Huy Giáp, Phường Trấn Biên, TP. Đồng Nai",
    "photoDataUrl": "data:image/webp;base64,...",
    "imageDHash": "a1b2c3d4e5f60718"
  }
  ```
- **Response `201 Created`:**
  ```json
  {
    "report": { "id": "rpt_99", "code": "DN-2026-0099", "status": "received", "...": "..." },
    "duplicateWarning": null
  }
  ```

### 3.5. Tương tác cộng đồng trên phản ánh
- `POST /api/reports/:id/confirm` *(Auth required)* — Cộng đồng xác nhận sự cố thực tế → `{ "report": { ... } }`
- `POST /api/reports/:id/attach-photo` *(Auth required)* — Body: `{ "photoDataUrl": "...", "imageDHash": "..." }` → `{ "report": { ... } }`
- `POST /api/reports/:id/rate` *(Auth required)* — Body: `{ "stars": 5, "comment": "Đã xử lý sạch đẹp" }` → `{ "report": { ... } }`

---

## 4. Tình nguyện viên (`volunteer`) & Điều hành IOC 2 cấp (`ward_officer`, `city_admin`)

### 4.1. Tình nguyện viên
- `POST /api/auth/volunteer/register` *(Auth required)* — Body: `{ "wardCode": "P-TRANBIEN", "note": "..." }`
- `GET /api/volunteer/tasks` *(Role: `volunteer`)*
- `POST /api/volunteer/tasks/:id/accept` *(Role: `volunteer`)*
- `POST /api/volunteer/tasks/:id/verify` *(Role: `volunteer`)* — Body: `{ "verified": true, "note": "...", "photoDataUrl": "..." }`
- `POST /api/volunteer/proxy-report` *(Role: `volunteer`)* — Gửi hộ người cao tuổi
- `GET /api/volunteer/leaderboard` — Bảng vinh danh tình nguyện viên
- `GET /api/volunteer/logbook` *(Role: `volunteer`)*

### 4.2. Điều hành IOC 2 cấp (`ward_officer` & `city_admin`)
- `GET /api/admin/overview` — Thống kê điều hành IOC
- `GET /api/admin/queue` — Hàng đợi xử lý theo SLA & mức độ khẩn cấp
- `POST /api/admin/reports/:id/assign` — Phân công phòng ban chuyên môn
- `POST /api/admin/reports/:id/status` — Cập nhật trạng thái xử lý
- `POST /api/admin/reports/:id/dispatch` — Điều phối lực lượng hiện trường / tình nguyện viên
- `POST /api/admin/reports/:id/transfer` — Chuyển tuyến phản ánh sang Phường/Xã đúng thẩm quyền
- `POST /api/admin/reports/:id/resolve` — Đóng hồ sơ kèm ảnh nghiệm thu sau xử lý
- `POST /api/admin/reports/:id/spam` | `POST /api/admin/reports/:id/restore` — Đánh dấu / khôi phục phản ánh rác
- `GET /api/admin/audit` | `GET /api/admin/audit/verify` *(`city_admin`)* — Nhật ký chuỗi băm SHA-256 bất biến
- `GET /api/admin/staff` | `POST /api/admin/staff` | `PATCH /api/admin/staff/:id/revoke` *(`city_admin`)* — Quản lý tài khoản cán bộ 95 Phường/Xã
- `GET /api/admin/export` — Xuất dữ liệu báo cáo CSV/JSON

---

## 5. Dịch vụ AI (`gemini-3.5-flash` + Fallback Cục bộ)

### 5.1. Phân tích ảnh hiện trường tự động (Zero-Typing Vision)
- **Method & URL:** `POST /api/ai/analyze-image`
- **Request Body:**
  ```json
  {
    "photoDataUrl": "data:image/webp;base64,...",
    "hint": "Đường ngập nước sau mưa lớn"
  }
  ```
- **Response `200 OK`:**
  ```json
  {
    "category": "flooding",
    "priority": "high",
    "suggestedTitle": "Ngập úng cục bộ mặt đường sau mưa lớn",
    "suggestedDescription": "Mặt đường ngập nước gây cản trở phương tiện lưu thông.",
    "department": "urban_infra",
    "confidence": 0.91
  }
  ```

### 5.2. Đối chiếu ảnh Trước / Sau nghiệm thu (AI Resolution Verification)
- **Method & URL:** `POST /api/ai/verify-resolution` *(Role: `ward_officer` | `city_admin`)*
- **Request Body:**
  ```json
  {
    "beforePhotoDataUrl": "data:image/webp;base64,...",
    "afterPhotoDataUrl": "data:image/webp;base64,...",
    "category": "waste"
  }
  ```
- **Response `200 OK`:**
  ```json
  {
    "verified": true,
    "score": 0.89,
    "summary": "Điểm tồn đọng rác thải đã được thu gom sạch sẽ."
  }
  ```

### 5.3. Trợ lý ảo Công dân & IOC (SSE Streaming)
- **Method & URL:** `POST /api/ai/chat`
- **Request Body:**
  ```json
  {
    "message": "Tra cứu quy trình xử lý sự cố chiếu sáng tại Phường Trấn Biên",
    "wardCode": "P-TRANBIEN"
  }
  ```
- **Response (`text/event-stream`):** Phát luồng sự kiện SSE `data: {"delta":"..."}\n\n` và kết thúc bằng `data: [DONE]\n\n`.

---

*Mọi endpoint mới hoặc thay đổi contract trên nhánh `backend` sẽ được cập nhật trực tiếp tại file này kèm đầy đủ Method, URL, Request Body và Response JSON mẫu.*
