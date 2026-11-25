import crypto from 'node:crypto';
import { Types } from 'mongoose';
import { connectMongoDB, disconnectMongoDB } from '../config/db';
import {
  computePriorityScore,
  Incident,
  SpamLog,
  User,
  type IIncident,
  type ISpamLog,
  type IUser,
} from '../models';

type SeedUserInput = Omit<IUser, 'createdAt' | 'updatedAt'> & { _id: Types.ObjectId };
type SeedIncidentInput = Omit<IIncident, 'createdAt' | 'updatedAt'> & { _id: Types.ObjectId };
type SeedSpamLogInput = Omit<ISpamLog, 'createdAt' | 'updatedAt'> & { _id: Types.ObjectId };

export interface DongNaiSeedDataset {
  users: SeedUserInput[];
  incidents: SeedIncidentInput[];
  spamLogs: SeedSpamLogInput[];
}

function daysAgo(days: number, offsetHours = 0): Date {
  return new Date(Date.now() - (days * 24 + offsetHours) * 3600 * 1000);
}

/**
 * Xây dựng bộ dữ liệu mẫu thực tế tại tỉnh Đồng Nai (deterministic, chuẩn GeoJSON [lng, lat]):
 * - 1 Admin cấp tỉnh Đồng Nai
 * - 2 Cán bộ xã/phường: TP. Biên Hòa (Phường Trấn Biên) & Huyện Tân Phú (Xã Tà Lài)
 * - 3 Người dân có điểm uy tín và trạng thái OTP đa dạng
 * - 8 Phản ánh hiện trường đủ 6 danh mục & 5 trạng thái kèm tọa độ GPS thật tại Đồng Nai
 * - 2 Bản ghi spam_logs mẫu minh họa TTL Index 30 ngày
 */
export function buildDongNaiSeedDataset(): DongNaiSeedDataset {
  const adminId = new Types.ObjectId('6742a0000000000000000001');
  const officerTranBienId = new Types.ObjectId('6742a0000000000000000002');
  const officerTaLaiId = new Types.ObjectId('6742a0000000000000000003');
  const citizen1Id = new Types.ObjectId('6742a0000000000000000004');
  const citizen2Id = new Types.ObjectId('6742a0000000000000000005');
  const citizen3Id = new Types.ObjectId('6742a0000000000000000006');

  const users: SeedUserInput[] = [
    {
      _id: adminId,
      phoneNumber: '0901000001',
      fullName: 'Nguyễn Minh Quân (IOC Tỉnh Đồng Nai)',
      role: 'admin',
      assignedArea: { district: 'Toàn tỉnh Đồng Nai', ward: 'Trung tâm IOC' },
      trustScore: 100,
      otpVerification: {
        isVerified: true,
        lastVerifiedAt: daysAgo(10),
        dailyReportCount: 0,
        lastReportDate: null,
      },
      clientOfflineId: 'seed-user-admin-dongnai-001',
      syncStatus: 'synced',
      clientCreatedAt: daysAgo(30),
      serverReceivedAt: daysAgo(30),
    },
    {
      _id: officerTranBienId,
      phoneNumber: '0901000002',
      fullName: 'Trần Thị Hồng Nhung (Cán bộ P. Trấn Biên)',
      role: 'ward_officer',
      assignedArea: { district: 'TP. Biên Hòa', ward: 'Phường Trấn Biên' },
      trustScore: 100,
      otpVerification: {
        isVerified: true,
        lastVerifiedAt: daysAgo(5),
        dailyReportCount: 0,
        lastReportDate: null,
      },
      clientOfflineId: 'seed-user-officer-tranbien-002',
      syncStatus: 'synced',
      clientCreatedAt: daysAgo(28),
      serverReceivedAt: daysAgo(28),
    },
    {
      _id: officerTaLaiId,
      phoneNumber: '0901000003',
      fullName: 'Điểu Văn Sơn (Cán bộ Xã Tà Lài)',
      role: 'ward_officer',
      assignedArea: { district: 'Huyện Tân Phú', ward: 'Xã Tà Lài' },
      trustScore: 100,
      otpVerification: {
        isVerified: true,
        lastVerifiedAt: daysAgo(4),
        dailyReportCount: 0,
        lastReportDate: null,
      },
      clientOfflineId: 'seed-user-officer-talai-003',
      syncStatus: 'synced',
      clientCreatedAt: daysAgo(28),
      serverReceivedAt: daysAgo(28),
    },
    {
      _id: citizen1Id,
      phoneNumber: '0912345001',
      fullName: 'Lê Hoàng Nam',
      role: 'citizen',
      assignedArea: { district: 'TP. Biên Hòa', ward: 'Phường Trấn Biên' },
      trustScore: 100,
      otpVerification: {
        isVerified: true,
        lastVerifiedAt: daysAgo(1),
        dailyReportCount: 2,
        lastReportDate: daysAgo(0, 3),
      },
      clientOfflineId: 'seed-user-citizen-nam-004',
      syncStatus: 'synced',
      clientCreatedAt: daysAgo(20),
      serverReceivedAt: daysAgo(20),
    },
    {
      _id: citizen2Id,
      phoneNumber: '0912345002',
      fullName: 'Phạm Thị Mai Linh',
      role: 'citizen',
      assignedArea: { district: 'Huyện Tân Phú', ward: 'Xã Tà Lài' },
      trustScore: 95,
      otpVerification: {
        isVerified: true,
        lastVerifiedAt: daysAgo(2),
        dailyReportCount: 1,
        lastReportDate: daysAgo(1),
      },
      clientOfflineId: 'seed-user-citizen-linh-005',
      syncStatus: 'synced',
      clientCreatedAt: daysAgo(18),
      serverReceivedAt: daysAgo(18),
    },
    {
      _id: citizen3Id,
      phoneNumber: '0912345003',
      fullName: 'Võ Thành Đạt',
      role: 'citizen',
      assignedArea: { district: 'Huyện Long Thành', ward: 'Thị trấn Long Thành' },
      trustScore: 70,
      otpVerification: {
        isVerified: true,
        lastVerifiedAt: daysAgo(3),
        dailyReportCount: 1,
        lastReportDate: daysAgo(2),
      },
      clientOfflineId: 'seed-user-citizen-dat-006',
      syncStatus: 'synced',
      clientCreatedAt: daysAgo(15),
      serverReceivedAt: daysAgo(15),
    },
  ];

  const incidents: SeedIncidentInput[] = [
    // 1. TP. Biên Hòa - Phường Trấn Biên (ha_tang_do_thi, in_progress, độ nghiêm trọng 5, đã gộp 2 phản ánh)
    {
      _id: new Types.ObjectId('6742b0000000000000000101'),
      incidentCode: 'DN-2026-TB001',
      reporterId: citizen1Id,
      category: 'ha_tang_do_thi',
      title: 'Cây xanh gãy cành đè dây điện chiếu sáng đường Nguyễn Ái Quốc',
      description: 'Sau cơn mưa dông chiều nay, nhánh cây lớn đổ xuống kéo võng dây đèn chiếu sáng gần ngã tư đường Nguyễn Ái Quốc, nguy cơ chập điện và cản trở xe cộ.',
      district: 'TP. Biên Hòa',
      location: {
        type: 'Point',
        coordinates: [106.8243, 10.9465],
        addressText: 'Số 142 đường Nguyễn Ái Quốc, Phường Trấn Biên, TP. Biên Hòa, Đồng Nai',
        ward: 'Phường Trấn Biên',
        district: 'TP. Biên Hòa',
      },
      media: [
        {
          url: 'https://storage.smartcitizen-dongnai.vn/seed/tranbien-daydien-1.jpg',
          type: 'image',
          dHash: 'a4c8e2f091b3d577',
          capturedAt: daysAgo(0, 4),
        },
        {
          url: 'https://storage.smartcitizen-dongnai.vn/seed/tranbien-daydien-2.jpg',
          type: 'image',
          dHash: '5b371d0f6e4c2a88',
          capturedAt: daysAgo(0, 3),
        },
      ],
      aiAnalysis: {
        autoCategory: 'ha_tang_do_thi',
        detectedObjects: ['fallen_tree_branch', 'power_cable', 'street_lamp', 'asphalt_road'],
        severityLevel: 5,
        summary: 'Cành cây gãy đè lên dây điện võng thấp trên trục đường chính, mức nguy hiểm khẩn cấp cấp độ 5.',
        isValidImage: true,
      },
      priorityScore: computePriorityScore({ severityLevel: 5, duplicateCount: 2, reporterTrustScore: 100 }),
      duplicateControl: {
        isDuplicate: false,
        masterIncidentId: null,
        duplicateCount: 2,
      },
      status: 'in_progress',
      timeline: [
        {
          status: 'received',
          note: 'Hệ thống tiếp nhận phản ánh và AI gắn mức độ nghiêm trọng 5/5.',
          updatedBy: null,
          proofImageUrl: null,
          timestamp: daysAgo(0, 4),
        },
        {
          status: 'in_progress',
          note: 'Cán bộ P. Trấn Biên đã phối hợp Điện lực Biên Hòa và CSGT phong tỏa, cắt tỉa cành.',
          updatedBy: officerTranBienId,
          proofImageUrl: null,
          timestamp: daysAgo(0, 2),
        },
      ],
      clientOfflineId: 'seed-inc-tranbien-001',
      syncStatus: 'synced',
      clientCreatedAt: daysAgo(0, 4),
      serverReceivedAt: daysAgo(0, 4),
    },

    // 2. TP. Biên Hòa - Phường Trấn Biên (giao_thong, received)
    {
      _id: new Types.ObjectId('6742b0000000000000000102'),
      incidentCode: 'DN-2026-TB002',
      reporterId: citizen1Id,
      category: 'giao_thong',
      title: 'Hố ga mất nắp và ổ gà sâu trên trục Đồng Khởi',
      description: 'Đoạn trước hẻm 68 đường Đồng Khởi có miệng hố ga bị sập nắp sắt, xe máy đi buổi tối rất dễ sụp bánh.',
      district: 'TP. Biên Hòa',
      location: {
        type: 'Point',
        coordinates: [106.8312, 10.9438],
        addressText: 'Trước hẻm 68 đường Đồng Khởi, Phường Trấn Biên, TP. Biên Hòa, Đồng Nai',
        ward: 'Phường Trấn Biên',
        district: 'TP. Biên Hòa',
      },
      media: [
        {
          url: 'https://storage.smartcitizen-dongnai.vn/seed/dongkhoi-hoga.jpg',
          type: 'image',
          dHash: '1f2e3d4c5b6a7980',
          capturedAt: daysAgo(1, 2),
        },
      ],
      aiAnalysis: {
        autoCategory: 'giao_thong',
        detectedObjects: ['open_manhole', 'pothole', 'damaged_asphalt'],
        severityLevel: 4,
        summary: 'Miệng hố ga mất nắp bên lề phải đường Đồng Khởi, nguy cơ tai nạn cao vào ban đêm.',
        isValidImage: true,
      },
      priorityScore: computePriorityScore({ severityLevel: 4, duplicateCount: 1, reporterTrustScore: 100 }),
      duplicateControl: {
        isDuplicate: false,
        masterIncidentId: null,
        duplicateCount: 1,
      },
      status: 'received',
      timeline: [
        {
          status: 'received',
          note: 'Đã tiếp nhận và chuyển Phòng Quản lý Đô thị TP. Biên Hòa lên lịch thay nắp hố ga.',
          updatedBy: officerTranBienId,
          proofImageUrl: null,
          timestamp: daysAgo(1, 1),
        },
      ],
      clientOfflineId: 'seed-inc-tranbien-002',
      syncStatus: 'synced',
      clientCreatedAt: daysAgo(1, 2),
      serverReceivedAt: daysAgo(1, 2),
    },

    // 3. Huyện Tân Phú - Xã Tà Lài (giao_thong, in_progress)
    {
      _id: new Types.ObjectId('6742b0000000000000000103'),
      incidentCode: 'DN-2026-TL003',
      reporterId: citizen2Id,
      category: 'giao_thong',
      title: 'Sạt lở lề đường và đọng bùn đất trên Tỉnh lộ 762 đoạn qua Xã Tà Lài',
      description: 'Mưa lớn kéo dài làm sạt đất đỏ từ ta-luy tràn ra gần nửa mặt đường Tỉnh lộ 762, khu vực cách cầu Tà Lài khoảng 400m, xe đi lại trơn trượt.',
      district: 'Huyện Tân Phú',
      location: {
        type: 'Point',
        coordinates: [107.3618, 11.4215],
        addressText: 'Tỉnh lộ 762, Ấp 2, Xã Tà Lài, Huyện Tân Phú, Đồng Nai',
        ward: 'Xã Tà Lài',
        district: 'Huyện Tân Phú',
      },
      media: [
        {
          url: 'https://storage.smartcitizen-dongnai.vn/seed/talai-tl762-satlo.jpg',
          type: 'image',
          dHash: '8877665544332211',
          capturedAt: daysAgo(0, 6),
        },
      ],
      aiAnalysis: {
        autoCategory: 'giao_thong',
        detectedObjects: ['landslide_mud', 'rural_highway', 'standing_water'],
        severityLevel: 4,
        summary: 'Đất sạt lở và bùn phủ một phần mặt đường Tỉnh lộ 762, cần đặt biển cảnh báo và xúc dọn ngay.',
        isValidImage: true,
      },
      priorityScore: computePriorityScore({ severityLevel: 4, duplicateCount: 0, reporterTrustScore: 95 }),
      duplicateControl: {
        isDuplicate: false,
        masterIncidentId: null,
        duplicateCount: 0,
      },
      status: 'in_progress',
      timeline: [
        {
          status: 'received',
          note: 'Tiếp nhận phản ánh offline được đồng bộ từ Xã Tà Lài.',
          updatedBy: null,
          proofImageUrl: null,
          timestamp: daysAgo(0, 5),
        },
        {
          status: 'in_progress',
          note: 'UBND Xã Tà Lài đã cắm cọc tiêu cảnh báo và điều xe xúc đến dọn bùn đất.',
          updatedBy: officerTaLaiId,
          proofImageUrl: null,
          timestamp: daysAgo(0, 3),
        },
      ],
      clientOfflineId: 'seed-inc-talai-003',
      syncStatus: 'synced',
      clientCreatedAt: daysAgo(0, 6),
      serverReceivedAt: daysAgo(0, 5),
    },

    // 4. Huyện Tân Phú - Xã Tà Lài (moi_truong, resolved + ảnh chứng minh nghiệm thu)
    {
      _id: new Types.ObjectId('6742b0000000000000000104'),
      incidentCode: 'DN-2026-TL004',
      reporterId: citizen2Id,
      category: 'moi_truong',
      title: 'Bãi rác tự phát ven đường vào vùng đệm Nam Cát Tiên',
      description: 'Một số hộ dân vứt bao tải rác nhựa và vỏ thuốc bảo vệ thực vật gần cống thoát nước Ấp 4, Xã Tà Lài gây mùi hôi.',
      district: 'Huyện Tân Phú',
      location: {
        type: 'Point',
        coordinates: [107.3542, 11.4168],
        addressText: 'Đường liên xã Ấp 4, Xã Tà Lài, Huyện Tân Phú, Đồng Nai',
        ward: 'Xã Tà Lài',
        district: 'Huyện Tân Phú',
      },
      media: [
        {
          url: 'https://storage.smartcitizen-dongnai.vn/seed/talai-rac-before.jpg',
          type: 'image',
          dHash: 'c0ffee123456789a',
          capturedAt: daysAgo(5),
        },
      ],
      aiAnalysis: {
        autoCategory: 'moi_truong',
        detectedObjects: ['plastic_waste', 'garbage_bags', 'drainage_ditch'],
        severityLevel: 3,
        summary: 'Tụ điểm rác thải sinh hoạt và bao bì nhựa cạnh rãnh thoát nước ven đường.',
        isValidImage: true,
      },
      priorityScore: computePriorityScore({ severityLevel: 3, duplicateCount: 0, reporterTrustScore: 95 }),
      duplicateControl: {
        isDuplicate: false,
        masterIncidentId: null,
        duplicateCount: 0,
      },
      status: 'resolved',
      timeline: [
        {
          status: 'received',
          note: 'Cán bộ Xã Tà Lài đã tiếp nhận hiện trường.',
          updatedBy: officerTaLaiId,
          proofImageUrl: null,
          timestamp: daysAgo(5),
        },
        {
          status: 'in_progress',
          note: 'Đội vệ sinh môi trường xã và Đoàn Thanh niên tiến hành thu gom, phun khử mùi.',
          updatedBy: officerTaLaiId,
          proofImageUrl: null,
          timestamp: daysAgo(4),
        },
        {
          status: 'resolved',
          note: 'Đã dọn sạch toàn bộ điểm rác và lắp biển cấm đổ rác.',
          updatedBy: officerTaLaiId,
          proofImageUrl: 'https://storage.smartcitizen-dongnai.vn/seed/talai-rac-after.jpg',
          timestamp: daysAgo(3),
        },
      ],
      clientOfflineId: 'seed-inc-talai-004',
      syncStatus: 'synced',
      clientCreatedAt: daysAgo(5),
      serverReceivedAt: daysAgo(5),
    },

    // 5. TP. Biên Hòa - Phường Quyết Thắng (y_te_dich_benh, pending_verify)
    {
      _id: new Types.ObjectId('6742b0000000000000000105'),
      incidentCode: 'DN-2026-QT005',
      reporterId: citizen1Id,
      category: 'y_te_dich_benh',
      title: 'Khu đất trống đọng nước tù phát sinh lăng quăng gần trường tiểu học',
      description: 'Lô đất bỏ hoang sát hẻm 21 đường Cách Mạng Tháng Tám đọng nước mưa và lốp xe cũ nhiều ngày, xuất hiện nhiều muỗi vằn.',
      district: 'TP. Biên Hòa',
      location: {
        type: 'Point',
        coordinates: [106.8194, 10.9668],
        addressText: 'Hẻm 21 đường Cách Mạng Tháng Tám, Phường Quyết Thắng, TP. Biên Hòa, Đồng Nai',
        ward: 'Phường Quyết Thắng',
        district: 'TP. Biên Hòa',
      },
      media: [
        {
          url: 'https://storage.smartcitizen-dongnai.vn/seed/quyetthang-nuoctu.jpg',
          type: 'image',
          dHash: '3c4d5e6f7a8b9c0d',
          capturedAt: daysAgo(0, 8),
        },
      ],
      aiAnalysis: {
        autoCategory: 'y_te_dich_benh',
        detectedObjects: ['stagnant_water', 'discarded_tires', 'overgrown_lot'],
        severityLevel: 3,
        summary: 'Nước đọng tù lâu ngày kèm lốp xe phế thải — nguy cơ ổ dịch sốt xuất huyết.',
        isValidImage: true,
      },
      priorityScore: computePriorityScore({ severityLevel: 3, duplicateCount: 0, reporterTrustScore: 100 }),
      duplicateControl: {
        isDuplicate: false,
        masterIncidentId: null,
        duplicateCount: 0,
      },
      status: 'pending_verify',
      timeline: [
        {
          status: 'pending_verify',
          note: 'Đang chờ Trạm Y tế phường và Tình nguyện viên xác minh thực địa.',
          updatedBy: null,
          proofImageUrl: null,
          timestamp: daysAgo(0, 8),
        },
      ],
      clientOfflineId: 'seed-inc-quyetthang-005',
      syncStatus: 'synced',
      clientCreatedAt: daysAgo(0, 8),
      serverReceivedAt: daysAgo(0, 8),
    },

    // 6. Huyện Long Thành - Thị trấn Long Thành (an_ninh_trat_tu, received)
    {
      _id: new Types.ObjectId('6742b0000000000000000106'),
      incidentCode: 'DN-2026-LT006',
      reporterId: citizen3Id,
      category: 'an_ninh_trat_tu',
      title: 'Xe tải trọng lớn dừng đỗ lấn chiếm hành lang Quốc lộ 51 vào ban đêm',
      description: 'Khu vực gần cổng Khu công nghiệp Long Thành thường xuyên có 5–6 xe container đậu nối đuôi tắt đèn cảnh báo trên làn xe máy.',
      district: 'Huyện Long Thành',
      location: {
        type: 'Point',
        coordinates: [106.9514, 10.7912],
        addressText: 'Quốc lộ 51, đoạn gần ngã tư Lộc An, Thị trấn Long Thành, Huyện Long Thành, Đồng Nai',
        ward: 'Thị trấn Long Thành',
        district: 'Huyện Long Thành',
      },
      media: [
        {
          url: 'https://storage.smartcitizen-dongnai.vn/seed/longthanh-ql51-xetai.jpg',
          type: 'image',
          dHash: '9a8b7c6d5e4f3a2b',
          capturedAt: daysAgo(1, 5),
        },
      ],
      aiAnalysis: {
        autoCategory: 'an_ninh_trat_tu',
        detectedObjects: ['parked_trucks', 'highway_shoulder', 'night_scene'],
        severityLevel: 4,
        summary: 'Xe tải dừng đỗ lấn làn xe máy ban đêm trên Quốc lộ 51, tiềm ẩn nguy cơ va chạm.',
        isValidImage: true,
      },
      priorityScore: computePriorityScore({ severityLevel: 4, duplicateCount: 0, reporterTrustScore: 70 }),
      duplicateControl: {
        isDuplicate: false,
        masterIncidentId: null,
        duplicateCount: 0,
      },
      status: 'received',
      timeline: [
        {
          status: 'received',
          note: 'Đã tiếp nhận và chuyển Công an Thị trấn Long Thành phối hợp tuần tra đêm.',
          updatedBy: adminId,
          proofImageUrl: null,
          timestamp: daysAgo(1, 4),
        },
      ],
      clientOfflineId: 'seed-inc-longthanh-006',
      syncStatus: 'synced',
      clientCreatedAt: daysAgo(1, 5),
      serverReceivedAt: daysAgo(1, 5),
    },

    // 7. TP. Long Khánh - Phường Xuân Trung (khac, resolved + ảnh chứng minh nghiệm thu)
    {
      _id: new Types.ObjectId('6742b0000000000000000107'),
      incidentCode: 'DN-2026-LK007',
      reporterId: citizen3Id,
      category: 'khac',
      title: 'Biển chỉ dẫn tên đường Hùng Vương bị nghiêng lệch sau gió lớn',
      description: 'Cột biển chỉ dẫn giao lộ Hùng Vương – Cách Mạng Tháng Tám bị nghiêng khoảng 30 độ, chắn tầm nhìn người đi bộ.',
      district: 'TP. Long Khánh',
      location: {
        type: 'Point',
        coordinates: [107.2216, 10.9352],
        addressText: 'Giao lộ Hùng Vương, Phường Xuân Trung, TP. Long Khánh, Đồng Nai',
        ward: 'Phường Xuân Trung',
        district: 'TP. Long Khánh',
      },
      media: [
        {
          url: 'https://storage.smartcitizen-dongnai.vn/seed/longkhanh-bienduong-before.jpg',
          type: 'image',
          dHash: '0f1e2d3c4b5a6978',
          capturedAt: daysAgo(6),
        },
      ],
      aiAnalysis: {
        autoCategory: 'khac',
        detectedObjects: ['tilted_street_sign', 'sidewalk'],
        severityLevel: 2,
        summary: 'Biển chỉ dẫn tên đường bị nghiêng chân đế trên vỉa hè.',
        isValidImage: true,
      },
      priorityScore: computePriorityScore({ severityLevel: 2, duplicateCount: 0, reporterTrustScore: 70 }),
      duplicateControl: {
        isDuplicate: false,
        masterIncidentId: null,
        duplicateCount: 0,
      },
      status: 'resolved',
      timeline: [
        {
          status: 'received',
          note: 'Đã tiếp nhận phản ánh tại Phường Xuân Trung.',
          updatedBy: adminId,
          proofImageUrl: null,
          timestamp: daysAgo(6),
        },
        {
          status: 'resolved',
          note: 'Đội duy tu đô thị TP. Long Khánh đã gia cố chân đế và dựng thẳng biển báo.',
          updatedBy: adminId,
          proofImageUrl: 'https://storage.smartcitizen-dongnai.vn/seed/longkhanh-bienduong-after.jpg',
          timestamp: daysAgo(4),
        },
      ],
      clientOfflineId: 'seed-inc-longkhanh-007',
      syncStatus: 'synced',
      clientCreatedAt: daysAgo(6),
      serverReceivedAt: daysAgo(6),
    },

    // 8. TP. Biên Hòa - Phường Trấn Biên (moi_truong, rejected_spam — AI phát hiện ảnh chụp màn hình giả mạo)
    {
      _id: new Types.ObjectId('6742b0000000000000000108'),
      incidentCode: 'DN-2026-SP008',
      reporterId: citizen3Id,
      category: 'moi_truong',
      title: 'Phản ánh bãi rác (Ảnh chụp lại màn hình không đạt chuẩn)',
      description: 'Gửi thử ảnh chụp từ màn hình máy tính không phải ảnh hiện trường thực tế.',
      district: 'TP. Biên Hòa',
      location: {
        type: 'Point',
        coordinates: [106.8261, 10.9482],
        addressText: 'Khu phố 3, Phường Trấn Biên, TP. Biên Hòa, Đồng Nai',
        ward: 'Phường Trấn Biên',
        district: 'TP. Biên Hòa',
      },
      media: [
        {
          url: 'https://storage.smartcitizen-dongnai.vn/seed/spam-screen-recapture.jpg',
          type: 'image',
          dHash: 'ffff0000ffff0000',
          capturedAt: daysAgo(2),
        },
      ],
      aiAnalysis: {
        autoCategory: 'moi_truong',
        detectedObjects: ['computer_monitor_bezel', 'moire_pattern'],
        severityLevel: 1,
        summary: 'AI phát hiện viền màn hình và vân moiré — không phải ảnh chụp trực tiếp tại hiện trường.',
        isValidImage: false,
      },
      priorityScore: 10,
      duplicateControl: {
        isDuplicate: false,
        masterIncidentId: null,
        duplicateCount: 0,
      },
      status: 'rejected_spam',
      timeline: [
        {
          status: 'pending_verify',
          note: 'AI gắn cờ ảnh không hợp lệ (isValidImage = false).',
          updatedBy: null,
          proofImageUrl: null,
          timestamp: daysAgo(2),
        },
        {
          status: 'rejected_spam',
          note: 'Cán bộ P. Trấn Biên xác nhận ảnh chụp màn hình và chuyển vào spam_logs.',
          updatedBy: officerTranBienId,
          proofImageUrl: null,
          timestamp: daysAgo(2),
        },
      ],
      clientOfflineId: 'seed-inc-spam-008',
      syncStatus: 'synced',
      clientCreatedAt: daysAgo(2),
      serverReceivedAt: daysAgo(2),
    },
  ];

  const hashIp = (ip: string): string => crypto.createHash('sha256').update(ip).digest('hex');

  const spamLogs: SeedSpamLogInput[] = [
    {
      _id: new Types.ObjectId('6742c0000000000000000201'),
      phoneNumber: '0912345003',
      ipHash: hashIp('113.161.88.14'),
      deviceFingerprint: 'fp_dn_demo_device_01',
      reason: 'ai_rejected_fake_image',
      blockedAt: daysAgo(2),
      metadata: { incidentCode: 'DN-2026-SP008', dHash: 'ffff0000ffff0000' },
      clientOfflineId: 'seed-spam-log-001',
      syncStatus: 'synced',
      clientCreatedAt: daysAgo(2),
      serverReceivedAt: daysAgo(2),
    },
    {
      _id: new Types.ObjectId('6742c0000000000000000202'),
      phoneNumber: '0912345003',
      ipHash: hashIp('113.161.88.14'),
      deviceFingerprint: 'fp_dn_demo_device_01',
      reason: 'duplicate_dhash',
      blockedAt: daysAgo(1),
      metadata: { matchedIncidentCode: 'DN-2026-TB001', hammingDistance: 2 },
      clientOfflineId: 'seed-spam-log-002',
      syncStatus: 'synced',
      clientCreatedAt: daysAgo(1),
      serverReceivedAt: daysAgo(1),
    },
  ];

  return { users, incidents, spamLogs };
}

/** Chạy seed idempotent vào MongoDB Atlas (có thể truyền `reset = true` để xóa dữ liệu cũ trước). */
export async function seedDongNaiDatabase(options: { reset?: boolean; uri?: string } = {}): Promise<{
  users: number;
  incidents: number;
  spamLogs: number;
}> {
  await connectMongoDB({ uri: options.uri, ensureIndexes: true });
  try {
    if (options.reset) {
      await Promise.all([User.deleteMany({}), Incident.deleteMany({}), SpamLog.deleteMany({})]);
      console.log('[seedDongNai] Đã xóa sạch dữ liệu cũ (--reset).');
    }

    const data = buildDongNaiSeedDataset();

    for (const u of data.users) {
      await User.findOneAndUpdate(
        { phoneNumber: u.phoneNumber },
        { $set: u },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
      );
    }

    for (const inc of data.incidents) {
      await Incident.findOneAndUpdate(
        { incidentCode: inc.incidentCode },
        { $set: inc },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
      );
    }

    for (const log of data.spamLogs) {
      await SpamLog.findOneAndUpdate(
        { clientOfflineId: log.clientOfflineId },
        { $set: log },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
      );
    }

    const counts = {
      users: await User.countDocuments(),
      incidents: await Incident.countDocuments(),
      spamLogs: await SpamLog.countDocuments(),
    };
    console.log(
      `[seedDongNai] Hoàn tất seed MongoDB Đồng Nai: ${counts.users} users (1 admin, 2 cán bộ, 3 dân), ${counts.incidents} incidents, ${counts.spamLogs} spam_logs.`,
    );
    return counts;
  } finally {
    await disconnectMongoDB();
  }
}

// Cho phép chạy trực tiếp bằng `tsx src/seed/seedDongNai.ts` hoặc `node dist/seed/seedDongNai.js`
if (require.main === module) {
  const reset = process.argv.includes('--reset');
  seedDongNaiDatabase({ reset })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seedDongNai] Lỗi seed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
