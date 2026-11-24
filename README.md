# SmartCitizen Đồng Nai — Team Victer

Nền tảng Web App **Phản ánh Hiện trường & Điều phối Đô thị Thông minh** quy mô toàn **Thành phố Đồng Nai** theo mô hình chính quyền địa phương **2 cấp** (**Thành phố Đồng Nai → 95 Phường/Xã**, gồm **33 Phường** và **62 Xã**, có hiệu lực từ **30/04/2026** theo NQ 1662/NQ-UBTVQH15 và NQ 237/NQ-UBTVQH16).

---

## 1. Kiến trúc 6 Trụ cột Production-Ready

1. **Phạm vi Toàn Thành phố Đồng Nai — 95 ĐVHC Chính thức (33 Phường, 62 Xã):**
   - Khẳng định cứng `total === 95`, `phuong === 33`, `xa === 62` trong `shared/dongNaiWards.ts`, bao gồm đủ **10 phường mới thành lập ngày 30/04/2026** (*Trảng Bom, Long Thành, Trị An, Nhơn Trạch, Tân Khai, Xuân Lộc, Tân Phú, Lộc Ninh, Dầu Giây, Đồng Phú*).
   - Bao phủ đều 5 vùng địa bàn: **Đô thị Trung tâm**, **Nam — Sân bay Long Thành & Cảng**, **Đông — Long Khánh & Xuân Lộc**, **Đông Bắc — Trị An & Cát Tiên** và **Bắc Đồng Nai** (Bình Phước, Đồng Xoài, Chơn Thành, Phước Long, Bù Gia Mập…).
   - Mặc định hiển thị phạm vi toàn Thành phố (`scope = 'city'`), hỗ trợ chuyển nhanh 5 vùng và tìm kiếm 95 Phường/Xã không phân biệt dấu tiếng Việt.

2. **Hiệu năng & Tốc độ xử lý 60FPS:**
   - **Backend & Database:** Composite indexes `(wardCode, status, createdAt DESC)`, `(category, status)`, `(lat, lng)` và `2dsphere`; endpoint siêu nhẹ `GET /api/reports/summary?bbox=minLng,minLat,maxLng,maxLat` cho bản đồ; **Cursor/Keyset Pagination** cho `GET /api/reports`; HTTP `ETag` + `304 Not Modified` cho danh mục `GET /api/wards`; **LRU Cache** cho Reverse Geocoding (~11m, 24h).
   - **Frontend & Edge Web Worker (`edgeProcessor.worker.ts`):** Trích xuất tọa độ **EXIF GPS** từ ảnh JPEG gốc, nén ảnh về `≤ 1600px` WebP/JPEG (`0.80`) và tính `64-bit dHash` hoàn toàn ngoài Main Thread; Local-First IndexedDB (`Dexie.js`) + Outbox Queue ngoại tuyến + Optimistic UI có rollback tự động khi lỗi 4xx.

3. **Định vị GPS chính xác cao & Reverse Geocoding 3 tầng:**
   - Hook `usePreciseLocation()` dùng `watchPosition` thu mẫu thông minh tối đa `4.5s` (dừng sớm ngay khi đạt `accuracy ≤ 20m`), hiển thị vòng tròn sai số **Accuracy Circle (`±Xm`)** và cảnh báo khi tín hiệu yếu (`> 50m`).
   - **Center Crosshair Pin Picker** kiểu Grab/Be với debounce `350ms` + `AbortController`.
   - **Reverse Geocoding 3 tầng (`GET /api/geo/reverse`):** (1) Kiểm tra Bounding Box Thành phố Đồng Nai → (2) Nominatim timeout `4s` + chuẩn hóa địa chỉ 2 thế hệ (`legacyAliases`, vd. địa danh cũ 3 cấp về đúng 95 Phường/Xã mới) → (3) Fallback centroid gần nhất (Haversine) kèm nhãn *"Đề xuất tự động — Vui lòng xác nhận Phường/Xã"*.

4. **Bản đồ GIS trực quan & Mobile-First:**
   - **Layer Switcher:** CartoDB Voyager (Sáng), CartoDB Dark Matter (Tối), Esri World Imagery (Vệ tinh).
   - **Marker Clustering** đổi màu theo mức độ ưu tiên (Khẩn cấp / Cao / Đang xử lý / Đã xử lý), Custom SVG category pins có nhịp pulse cho sự cố khẩn cấp, Heatmap, thanh công cụ nổi và nút **Xem toàn TP. Đồng Nai**.

5. **Xác thực Thật, Gửi Mã OTP Thật & RBAC 2 Cấp (Zero Mock Auth / Zero Fake OTP):**
   - Gỡ bỏ hoàn toàn nút đăng nhập demo 1-click, Google Mock và mọi cơ chế trả mã OTP ra HTTP response/UI.
   - `OtpDeliveryService` hỗ trợ gửi OTP thật qua **Resend Email API**, **Nodemailer SMTP** (Gmail App Password / Brevo), **Twilio SMS** và **eSMS Việt Nam**. Nếu chưa cấu hình khóa nhà cung cấp, server trả lỗi `503 otp_provider_not_configured` tường minh.
   - Sinh mã `crypto.randomInt(100000, 1000000)`, lưu băm **HMAC-SHA256** (`OTP_PEPPER`), hiệu lực `5 phút`, tối đa `5` lần sai (khóa `15 phút`), chống replay bằng `consumedAt`, cooldown `60 giây`/định danh, rate limit `5 yêu cầu/giờ/IP`.
   - Phiên bảo vệ bằng **HTTP-only, SameSite=Lax, Secure (prod) Cookies** (`sc_access` 15 phút + `sc_refresh` 7 ngày) với **Refresh Token Rotation** & phát hiện dùng lại token (tự thu hồi toàn bộ phiên của người dùng).
   - Trang **Hồ sơ Công dân (`/profile`)** cho phép đổi tên, chọn Phường/Xã mặc định, đặt/đổi mật khẩu, đăng xuất thiết bị này hoặc **Đăng xuất tất cả thiết bị** (`POST /api/auth/logout-all`).
   - **RBAC 2 cấp:** `city_admin` có thể cấp/thu hồi tài khoản `ward_officer` cho từng đơn vị trong 95 Phường/Xã (`POST /api/admin/staff`, `PATCH /api/admin/staff/:id/revoke`) và chuyển tuyến phản ánh nhầm địa giới (`POST /api/admin/reports/:id/transfer`).

6. **Civic Tech UI/UX & AI Pipeline 4 Lớp (`gemini-3.5-flash`):**
   - Luồng báo cáo 3 chạm (Chụp ảnh + AI Zero-Typing + EXIF GPS → Xác nhận vị trí tâm ngắm + phát hiện trùng 100m → Gửi), hỗ trợ **Chế độ Người cao tuổi (`Aa+`)**, Song ngữ `VI/EN` 100%, SLA đếm ngược, Before/After Slider và Audit Log chuỗi băm SHA-256 bất biến.

---

## 2. Chạy Local

**Yêu cầu:** Node.js `>= 20` và npm `>= 10`.

```bash
# 1. Cài dependencies cho cả server và client
npm run install:all

# 2. Tạo file biến môi trường từ mẫu
cp server/.env.example server/.env
# Mở server/.env và điền:
#  - RESEND_API_KEY (hoặc SMTP_HOST/SMTP_USER/SMTP_PASS) để gửi Email OTP thật
#  - GEMINI_API_KEY (tùy chọn — để trống dùng AI Dự phòng Cục bộ)
#  - MONGODB_URI (tùy chọn — để trống dùng Local Persistent JSON Store)
#  - INITIAL_STAFF_PASSWORD (mật khẩu khởi tạo cán bộ IOC)

# 3. Chạy đồng thời Backend (8080) và Frontend (5173)
npm run dev:server
npm run dev:client
```

Hoặc build & chạy ở chế độ Production (1 tiến trình phục vụ cả API lẫn SPA):

```bash
npm run build
npm start
# Truy cập http://localhost:8080 và kiểm tra sức khỏe tại http://localhost:8080/healthz
```

Chạy toàn bộ kiểm thử tự động (Backend + Frontend):

```bash
npm test
```

---

## 3. Hướng dẫn cấu hình Gửi OTP Thật (Render / Local)

Chọn **1 trong 2** cách miễn phí phổ biến nhất cho Email OTP:

### Cách A: Resend API (Khuyến nghị — nhanh, không bị chặn cổng SMTP)
1. Đăng ký tài khoản miễn phí tại [resend.com](https://resend.com) và tạo API Key (`re_...`).
2. Thêm vào Render Dashboard → **Environment Variables** (hoặc `server/.env`):
   - `OTP_PROVIDER=auto` (hoặc `resend`)
   - `RESEND_API_KEY=re_xxxxxxxxxxxx`
   - `OTP_FROM_EMAIL=SmartCitizen Dong Nai <onboarding@resend.dev>` *(hoặc email tên miền đã verify trên Resend)*.

### Cách B: Gmail SMTP (App Password)
1. Bật **Xác minh 2 bước** trên tài khoản Google, vào [App Passwords](https://myaccount.google.com/apppasswords) tạo mật khẩu ứng dụng 16 ký tự.
2. Thêm vào Environment Variables:
   - `OTP_PROVIDER=smtp`
   - `SMTP_HOST=smtp.gmail.com`
   - `SMTP_PORT=465`
   - `SMTP_SECURE=true`
   - `SMTP_USER=your-email@gmail.com`
   - `SMTP_PASS=xxxx xxxx xxxx xxxx`

---

## 4. Triển khai GitHub → Render + MongoDB Atlas

1. Tạo cụm MongoDB Atlas M0 (Singapore), mở Network Access (`0.0.0.0/0` hoặc IP Render), lấy `MONGODB_URI`.
2. Trên [Render Dashboard](https://dashboard.render.com/), tạo Blueprint từ repo GitHub chứa `render.yaml` (hoặc cập nhật Web Service hiện có).
3. Khai báo các biến bí mật (`sync: false`): `MONGODB_URI`, `GEMINI_API_KEY`, `RESEND_API_KEY` (hoặc `SMTP_*`), `INITIAL_STAFF_PASSWORD`.
4. Kiểm tra `/healthz` để xác nhận `wardsCount: 95`, `db.mode`, `ai.mode` và `otp.emailConfigured: true`.

---

## 5. Ghi chú Trung thực Kỹ thuật

- **Dữ liệu 95 ĐVHC:** Danh mục 95 Phường/Xã (33 Phường, 62 Xã) bám sát Nghị quyết 1662/NQ-UBTVQH15 và Nghị quyết 237/NQ-UBTVQH16 (hiệu lực 30/04/2026); tọa độ tâm xấp xỉ dùng cho bản đồ & fallback, nên kết hợp bản đồ ranh giới GeoJSON polygon chính thức của Sở Tài nguyên & Môi trường khi vận hành cấp sở ngành.
- **Hạng mục cần xác minh thực tế từ người dùng:** GPS ngoài trời trên điện thoại thật, hộp thư/SMS nhận mã OTP thật sau khi cấu hình `RESEND_API_KEY`/`SMTP_*`, camera thực tế trên HTTPS, và biến môi trường live trên Render + MongoDB Atlas.

*Phát triển bởi **Team Victer** — Thành phố Đồng Nai.*
