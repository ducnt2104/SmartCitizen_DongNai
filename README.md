# SmartCitizen_DongNai — Team Victer

Nền tảng Web App **Phản ánh Hiện trường & Điều phối Đô thị Thông minh cấp Thành phố (95 xã, phường thuộc Thành phố Đồng Nai)** theo kiến trúc **Local-First (IndexedDB + Outbox Queue + Edge Web Worker)** kết hợp **Pipeline AI 4 lớp (`gemini-3.5-flash`)** và **Bảo mật / Chống Gian lận 7 lớp**.

---

## 1. Kiến trúc Hệ thống

```text
SmartCitizen_DongNai/
├── shared/                     # Data Contract & thuật toán thuần dùng chung
│   ├── types.ts                # Interface-First types (Report, Ward, AuditEntry, VisionResult...)
│   ├── constants.ts            # Ngưỡng bảo mật (dHash 5/12, 50m, GPS 2km/5km, trustScore...)
│   ├── dongNaiWards.ts         # Danh mục 95 xã, phường TP. Đồng Nai + adjacentWardCodes + trục huyết mạch
│   ├── geo.ts                  # Haversine, Bounding Box Đồng Nai, matchArterial, mask/normalizePhone
│   ├── dhash.ts                # 64-bit Hamming Distance
│   ├── report.ts               # Sanitizer ClientReport & computeStats
│   ├── sceneArt.ts             # Minh họa SVG thực cảnh cho dữ liệu seed
│   └── seed.ts                 # Bộ dữ liệu seed chuẩn (64 P. Trấn Biên + 16 liên phường)
├── server/                     # Backend Express + TypeScript + Zod + Mongoose + @google/genai
│   └── src/
│       ├── config/env.ts       # Zod fail-loud env config (GEMINI_MODEL=gemini-3.5-flash)
│       ├── middleware/         # JWT + RBAC 4 cấp, Rate Limiting đa tầng, NoSQL Sanitizer
│       ├── models/             # Mongoose Schema (location: 2dsphere, AuditLog bất biến)
│       ├── repositories/       # Dual-Mode: MongoDB Atlas ⇔ Local Persistent JSON Store
│       ├── services/           # gemini.service.ts, report.service.ts, triage.service.ts, staff.service.ts, auth.service.ts, audit.service.ts, trust.service.ts, chat.service.ts
│       ├── controllers/        # REST + SSE Streaming controllers
│       └── routes/             # /healthz, /api/auth/*, /api/reports/*, /api/volunteer/*, /api/admin/*, /api/ai/*
├── client/                     # Frontend React 18 + TypeScript + Vite + Tailwind + Dexie + Leaflet
│   └── src/
│       ├── workers/edgeProcessor.worker.ts   # OffscreenCanvas nén ảnh + 64-bit dHash + Edge stats + Haversine 50m
│       ├── db/                 # Dexie IndexedDB (reports, wards, outboxQueue, aiVisionCache, settings) + Exponential Backoff Sync
│       ├── i18n/               # Song ngữ 100% Tiếng Việt (vi.ts) & English (en.ts)
│       ├── components/         # Logo SVG, Header, ScopePicker, CameraCapture, MapView (Cluster/Heatmap), Timeline & BeforeAfterSlider, ChatWidget (SSE + Voice), SpotlightTour, SettingsDrawer, OfflineBanner
│       └── pages/              # Home (Senior Mode 150%), AuthPage (Tab A/B + Demo 1-Click), Report (3 bước), MapPage, MinePage, VolunteerPage, admin/* (Cổng IOC)
├── render.yaml                 # Blueprint triển khai 1-click lên Render (kèm /healthz)
└── package.json                # Monorepo scripts
```

---

## 2. Các Tính năng & Tiêu chuẩn Kỹ thuật Chính

1. **UX/UI 2 Ngôn ngữ Thiết kế Độc lập & Trợ năng (Accessibility First):**
   - **Cổng Cộng đồng (Tab A):** Nền sáng `#F8FAFC`, bo góc mềm, vùng chạm tối thiểu `48×48px`, Bottom Navigation 4 mục, font `Be Vietnam Pro` + `JetBrains Mono`.
   - **Cổng Điều hành IOC (Tab B):** Nền Xanh Than Command Center `#0B1120`, viền mảnh `1px solid #1E293B`, KPI sparklines, biểu đồ Recharts, Bản đồ nhiệt điểm nóng (chỉ tối nền tile, giữ nguyên màu thật của ghim & heatmap), Sidebar thu gọn, phím tắt lọc nhanh (`1-4`, `j/k`, `Enter`, `r`, `/`, `Esc`).
   - **Chế độ Người cao tuổi (`Aa+ Chữ lớn`):** 1 chạm nâng chữ `150%`, nâng tương phản chuẩn WCAG AAA, thu gọn trang chủ thành 2 nút khổng lồ: **📸 CHỤP ẢNH BÁO CÁO NGAY** và **🎤 NÓI VỚI TRỢ LÝ AI**.
   - **Trung tâm Cài đặt:** Sáng / Tối / Tương phản cao ngoài trời · Xanh Chính quyền số / Xanh Thanh niên Tình nguyện · Cỡ chữ `100% / 125% / 150%` · Song ngữ `VI / EN` · Spotlight Tour 4 bước.
   - **Zero Blank Screen:** Đầy đủ `Skeleton Shimmer`, `Empty State` có SVG + nút hành động, `GPS-Denied Fallback` (chọn địa danh nhanh + kéo ghim), `Offline Banner` + Outbox Queue, và tự tắt `MediaStream` camera khi unmount / ẩn tab.

2. **Local-First & 60FPS Edge Web Worker:**
   - **Instant Hydration:** Mở ứng dụng đọc ngay dữ liệu 95 xã/phường và 80 hồ sơ từ IndexedDB (`Dexie.js`) trong `<30ms`, đồng bộ ngầm với server và gửi đơn ngoại tuyến qua **Outbox Queue** (`idempotencyKey` + Exponential Backoff).
   - **Web Worker (`edgeProcessor.worker.ts`):** Chạy hoàn toàn ngoài Main Thread — dùng `OffscreenCanvas` nén ảnh về `≤ 1024px` (JPEG 0.78), tính `64-bit dHash`, đo độ nét/độ phẳng, tính Haversine `50m` và đối chiếu trục đường huyết mạch Đồng Nai.

3. **Pipeline AI 4 Lớp (`@google/genai` — `gemini-3.5-flash`):**
   - **Zero-Typing Vision (`POST /api/ai/analyze-image`):** Strict JSON Schema (`temperature: 0.1`), tự điền loại sự cố, tiêu đề, mô tả, mức nguy hiểm, mối nguy, bộ phận phụ trách và chấm `authenticityScore (0-100)` + `fraudFlags[]`. Có **LRU Cache theo `dHash`** ở cả client lẫn server.
   - **Triage & Spatial Dispatch:** Tự phân loại trùng ảnh (`dHash ≤ 5` → Cách ly), gom nhóm đa góc chụp (`dHash > 12`, khác SĐT, bán kính `≤ 50m` → Hồ sơ Mẹ + nâng Ưu tiên Cao), và kích hoạt **Khẩn cấp Cấp độ 1** + chi viện liên xã/phường trên trục huyết mạch.
   - **Đối chiếu Nghiệm thu Trước–Sau (`POST /api/ai/verify-resolution`):** Chống báo cáo khống khi cán bộ tải ảnh sau xử lý.
   - **Trợ lý AI Cộng đồng (`POST /api/ai/chat`):** SSE Streaming + Web Speech API (`vi-VN`), inject ngữ cảnh thật từ DB, có bộ lọc chống Prompt Injection và **Graceful Heuristic Fallback** khi thiếu API key hoặc ngoại tuyến.

4. **Bảo mật, Chống Spam & Chống Gian lận 7 Lớp:**
   - Lớp 1: OTP 6 số hash `SHA-256`, hiệu lực `5 phút`, chờ gửi lại `60 giây`, khóa sau `5` lần sai.
   - Lớp 2: JWT `HS256` + RBAC 4 cấp (`citizen`, `volunteer`, `ward_officer`, `city_admin`) + ép phạm vi phường cho `ward_officer`.
   - Lớp 3: Rate Limiting đa tầng theo IP + SĐT + `X-Device-Fp` (`3 phản ánh/giờ/SĐT`, `10 lượt AI Vision/giờ/thiết bị`, mỗi SĐT xác nhận 1 lần/hồ sơ).
   - Lớp 4: Chặn spam trùng `dHash ≤ 5` & chấm `authenticityScore < 45` vào tab Cách ly.
   - Lớp 5: Kiểm tra Bounding Box TP. Đồng Nai (`10.60–11.55, 106.70–107.60`) & cảnh báo / cách ly lệch GPS (`> 2km` / `> 5km`).
   - Lớp 6: Hệ thống điểm tín nhiệm công dân `trustScore` (`70` khởi điểm, `+5` xác minh đúng, `-20` spam/tin giả, `< 30` vào chế độ Giám sát).
   - Lớp 7: Audit Log bất biến có **chuỗi băm SHA-256** (`prevHash -> hash`), chống NoSQL Injection (`$` / `.`), `helmet`, `cors` whitelist, validate 100% payload bằng `Zod`.

---

## 3. Dữ liệu Mẫu & 5 Kịch bản Demo Ban Giám Khảo

- **Phường Trấn Biên (`DN-TB` — Tháng 11/2026):** Chính xác **64** hồ sơ (`21` rác thải, `18` đèn đường, `15` ngập nước, `10` mặt đường); **47** đã hoàn thành (`73.4%`), **17** đang mở; thời gian xử lý trung bình **`3.2 ngày`**.
- **Toàn TP. Đồng Nai (95 xã, phường):** Tổng **80** hồ sơ (gồm 16 hồ sơ mở rộng tại Biên Hòa, Tân Triều, Long Khánh, Trảng Bom, Long Thành, Tà Lài, Nhơn Trạch...) sẵn sàng trình diễn Bản đồ nhiệt toàn thành phố & Điều phối liên khu vực.
- **5 Kịch bản mẫu cài sẵn:**
  1. `rp_tb_em`: **Khẩn cấp Cấp độ 1** — Cây đổ + dây điện võng trên trục Nguyễn Ái Quốc / Quốc lộ 1A, tự phát lệnh chi viện 2 phường lân cận + Điện lực + CSGT.
  2. `rp_tb_mother`: **Hồ sơ Mẹ** gom từ 4 phản ánh thật (4 SĐT, 4 ảnh góc độ khác nhau với mọi cặp `dHash distance > 12`, bán kính `50m`), nâng Ưu tiên Cao.
  3. `rp_tb_q_dup`, `rp_tb_q_screen`, `rp_tb_q_gps`: **03 đơn trong tab Cách ly** (trùng ảnh `dHash ≤ 5`, ảnh chụp màn hình `authenticityScore < 45`, lệch GPS `> 5km`).
  4. **04 hồ sơ Đã hoàn thành có ảnh Trước – Sau (Before/After Slider)** kèm điểm xác thực AI và đánh giá 5 sao.
  5. **03 Nhiệm vụ Xác minh Thực địa** gắn thẻ *"Người cao tuổi gửi — Cần hỗ trợ"* chờ Đội Thanh niên Tình nguyện tiếp nhận.

### Tài khoản Demo (1-Click trên trang `/auth`)

| Vai trò | Nút 1-Click | Tài khoản thủ công | Mật khẩu / OTP |
|---|---|---|---|
| Người dân | `👤 Dân` | SĐT bất kỳ `09xxxxxxxx` | Xem `[DEMO OTP]` trên thông báo |
| Tình nguyện viên | `🦺 Tình nguyện viên` | SĐT `0900000002` | Xem `[DEMO OTP]` |
| Cán bộ P. Trấn Biên | `🏛️ Cán bộ P. Trấn Biên` | Mã `CB-TB-01`, Đơn vị `Phường Trấn Biên` | `Demo@2026` |
| Điều hành TP. Đồng Nai | `🌆 Điều hành TP. Đồng Nai` | Mã `TP-01`, Đơn vị `Ban Điều hành TP. Đồng Nai` | `Demo@2026` |

---

## 4. Chạy Local

**Yêu cầu:** Node.js `>= 20` và npm `>= 10`.

```bash
# 1. Cài dependencies cho cả server và client
npm run install:all

# 2. Tạo file biến môi trường từ mẫu
cp server/.env.example server/.env
cp client/.env.example client/.env
# (Tùy chọn: điền GEMINI_API_KEY và MONGODB_URI trong server/.env;
#  nếu để trống, hệ thống tự chạy Local JSON Store + AI Heuristic Fallback an toàn)

# 3. Chạy đồng thời Backend (cổng 8080) và Frontend (cổng 5173) ở 2 cửa sổ terminal
npm run dev:server
npm run dev:client
```

Hoặc build & chạy ở chế độ Production (1 tiến trình duy nhất phục vụ cả API lẫn SPA):

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

## 5. Hướng dẫn Triển khai GitHub → Render + MongoDB Atlas + Google AI Studio

### Bước 1: Tạo khóa API Google AI Studio
1. Truy cập [Google AI Studio](https://aistudio.google.com/apikey) và tạo API Key mới.
2. **Tuyệt đối không** đưa key vào `client/.env` hay commit lên GitHub. Chỉ cấu hình `GEMINI_API_KEY` ở phía Server/Render.

### Bước 2: Tạo cụm MongoDB Atlas (Miễn phí M0)
1. Truy cập [MongoDB Atlas](https://www.mongodb.com/atlas), tạo Cluster M0 (chọn khu vực Singapore để giảm độ trễ với Render Singapore).
2. Tạo Database User và mở Network Access (`0.0.0.0/0` hoặc IP Render).
3. Lấy chuỗi kết nối `MONGODB_URI` (dạng `mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/smartcitizen_dongnai?retryWrites=true&w=majority`).
   *(Nếu chưa nối MongoDB Atlas, backend tự fallback sang Local Persistent JSON Store để chạy demo ngay lập tức.)*

### Bước 3: Triển khai lên Render bằng `render.yaml`
1. Push toàn bộ mã nguồn lên kho lưu trữ GitHub.
2. Vào [Render Dashboard](https://dashboard.render.com/) → **New +** → **Blueprint** → chọn repo GitHub chứa file `render.yaml`.
3. Điền các biến bí mật (`sync: false`) khi Render hỏi:
   - `GEMINI_API_KEY`: khóa từ Google AI Studio.
   - `MONGODB_URI`: chuỗi kết nối MongoDB Atlas (hoặc để trống để dùng JSON Store).
   - `GEMINI_MODEL`: giữ `gemini-3.5-flash`.
   - `ALLOWED_ORIGINS`: thêm domain thực tế của bạn (ví dụ `https://smartcitizen-dongnai.onrender.com`).
   - *(Lưu ý khi lên production thực tế cho dân dùng: đổi `DEMO_OTP=false` và `ENABLE_DEMO_AUTH=false`.)*
4. Sau khi deploy xong, mở `https://<your-app>.onrender.com/healthz` để xác nhận trạng thái DB (`mongo` hoặc `json`) và AI Service (`gemini` hoặc `fallback`).

---

## 6. Ghi chú Trung thực Kỹ thuật

- **Dữ liệu hành chính:** Danh mục 95 xã, phường trong `shared/dongNaiWards.ts` gồm mã đơn vị, vùng, tọa độ tâm xấp xỉ và danh sách trục huyết mạch phục vụ minh họa & kiểm thử; cần đối chiếu bảng địa giới chính thức của tỉnh/thành phố trước khi vận hành thực tế.
- **Hạng mục cần kiểm thử thực địa từ phía người dùng:** Camera phần cứng thực tế (`getUserMedia` trên HTTPS/localhost), GPS ngoài trời, `GEMINI_API_KEY` thật (trên quota Google AI Studio) và `MONGODB_URI` thật (MongoDB Atlas).

---

*Phát triển bởi **Team Victer** — Thành phố Đồng Nai.*
