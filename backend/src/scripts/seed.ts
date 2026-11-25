import dotenv from 'dotenv';
import path from 'node:path';
import { Types } from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/database';
import {
  computePriorityScore,
  Incident,
  isWithinDongNaiBounds,
  User,
  UserModel,
  Ward,
  type IIncident,
  type IncidentCategory,
  type IncidentStatus,
  type IWard,
} from '../models';
import { DONG_NAI_WARDS } from '../shared/dongNaiWards';
import { incidentRepository } from '../repositories/incidentRepository';
import { hashPassword } from '../utils/crypto';

// Nạp biến môi trường từ cả backend/.env và ../.env
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

export interface SuperAdminEnvConfig {
  phoneNumber: string;
  email: string;
  fullName: string;
  staffCode: string;
  passwordPlain: string;
}

export interface SeedDatabaseResult {
  wardsTotal: number;
  wardsPhuongNq1662: number;
  wardsXaNq1662: number;
  wardsPhuong2026: number;
  wardsXa2026: number;
  tranBienPilotTotal: number;
  tranBienInsertedNew: number;
  superAdminCreated: boolean;
  superAdminEmail: string;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function deterministicHex(rnd: () => number, len = 16): string {
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += Math.floor(rnd() * 16).toString(16);
  }
  return out;
}

/**
 * Đọc cấu hình tài khoản Super Admin từ `.env` (hỗ trợ các biến chuẩn SUPER_ADMIN_* / ADMIN_* / INITIAL_STAFF_PASSWORD).
 */
export function readSuperAdminConfig(envSource: NodeJS.ProcessEnv = process.env): SuperAdminEnvConfig {
  const rawPhone = (envSource.SUPER_ADMIN_PHONE ?? envSource.ADMIN_PHONE ?? '0901000000').trim();
  const rawEmail = (
    envSource.SUPER_ADMIN_EMAIL ??
    envSource.ADMIN_EMAIL ??
    'superadmin@dongnai.gov.vn'
  )
    .trim()
    .toLowerCase();
  const fullName = (
    envSource.SUPER_ADMIN_NAME ??
    envSource.ADMIN_NAME ??
    'Super Admin IOC Đồng Nai'
  ).trim();
  const staffCode = (
    envSource.SUPER_ADMIN_STAFF_CODE ??
    envSource.SUPER_ADMIN_CODE ??
    envSource.ADMIN_STAFF_CODE ??
    'SUPER-ADMIN-01'
  )
    .trim()
    .toUpperCase();
  const passwordPlain = (
    envSource.SUPER_ADMIN_PASSWORD ??
    envSource.ADMIN_PASSWORD ??
    envSource.INITIAL_STAFF_PASSWORD ??
    'DongNai@SuperAdmin2026!'
  ).trim();

  return { phoneNumber: rawPhone, email: rawEmail, fullName, staffCode, passwordPlain };
}

/**
 * Xây dựng đủ 95 đơn vị hành chính cấp xã TP. Đồng Nai:
 * - Theo NQ 1662/NQ-UBTVQH15 (01/07/2025): đúng 23 Phường + 72 Xã = 95 ĐVHC (`kindNq1662`).
 * - Theo NQ 237/NQ-UBTVQH16 (30/04/2026): 33 Phường + 62 Xã = 95 ĐVHC (`kind`, sau khi nâng cấp 10 xã lên phường).
 */
export function buildDongNai95WardsDataset(): Array<Omit<IWard, 'createdAt' | 'updatedAt'>> {
  const rows: Array<Omit<IWard, 'createdAt' | 'updatedAt'>> = DONG_NAI_WARDS.map((w) => {
    const kindNq1662: 'Phường' | 'Xã' = w.upgradedOn2026 ? 'Xã' : w.kind;
    return {
      wardCode: w.wardCode,
      name: w.name,
      shortName: w.shortName,
      kind: w.kind,
      kindNq1662,
      upgradedOn2026: w.upgradedOn2026,
      region: w.region,
      zone: w.zone,
      centerLat: w.centerLat,
      centerLng: w.centerLng,
      centerLocation: {
        type: 'Point',
        coordinates: [w.centerLng, w.centerLat],
      },
      legacyAliases: [...w.legacyAliases],
      adjacentWardCodes: [...w.adjacentWardCodes],
      arterialRoads: [...w.arterialRoads],
    };
  });

  const phuong1662 = rows.filter((r) => r.kindNq1662 === 'Phường').length;
  const xa1662 = rows.filter((r) => r.kindNq1662 === 'Xã').length;
  if (rows.length !== 95 || phuong1662 !== 23 || xa1662 !== 72) {
    throw new Error(
      `Sai lệch chuẩn 95 ĐVHC cấp xã TP. Đồng Nai: total=${rows.length}, phuongNq1662=${phuong1662}, xaNq1662=${xa1662} (yêu cầu 95 = 23 phường + 72 xã).`,
    );
  }
  return rows;
}

const TRAN_BIEN_STREETS: ReadonlyArray<{
  road: string;
  neighborhood: string;
  lng: number;
  lat: number;
}> = [
  { road: 'Đường Nguyễn Ái Quốc', neighborhood: 'Khu phố 1 (Quang Vinh)', lng: 106.8243, lat: 10.9465 },
  { road: 'Đường Đồng Khởi', neighborhood: 'Khu phố 2 (Trung Dũng)', lng: 106.8312, lat: 10.9438 },
  { road: 'Đường Võ Thị Sáu', neighborhood: 'Khu phố 3 (Thống Nhất)', lng: 106.8295, lat: 10.9416 },
  { road: 'Đường Cách Mạng Tháng Tám', neighborhood: 'Khu phố 4 (Quyết Thắng)', lng: 106.8194, lat: 10.9525 },
  { road: 'Đường Hà Huy Giáp', neighborhood: 'Khu phố 5 (Quyết Thắng)', lng: 106.8212, lat: 10.9488 },
  { road: 'Đường Hưng Đạo Vương', neighborhood: 'Khu phố 6 (Trung Dũng)', lng: 106.8236, lat: 10.9502 },
  { road: 'Đường 30 Tháng 4', neighborhood: 'Khu phố 7 (Trung Dũng)', lng: 106.8228, lat: 10.9476 },
  { road: 'Đường Phạm Văn Thuận', neighborhood: 'Khu phố 8 (Thống Nhất)', lng: 106.8342, lat: 10.9452 },
  { road: 'Đường Nguyễn Văn Trị (Bờ sông Đồng Nai)', neighborhood: 'Khu phố Chợ Biên Hòa', lng: 106.8178, lat: 10.9498 },
  { road: 'Đường Phan Chu Trinh', neighborhood: 'Khu phố Quang Vinh', lng: 106.8198, lat: 10.9542 },
  { road: 'Đường Huỳnh Văn Nghệ', neighborhood: 'Khu phố Bửu Long', lng: 106.8145, lat: 10.9612 },
  { road: 'Cầu Hóa An – Quốc lộ 1K', neighborhood: 'Khu phố Cửa ngõ Tây', lng: 106.8162, lat: 10.9435 },
  { road: 'Khu vực Công viên Biên Hùng', neighborhood: 'Trung tâm hành chính Trấn Biên', lng: 106.8254, lat: 10.9494 },
  { road: 'Khu vực Quảng trường Tỉnh', neighborhood: 'Khu phố Thống Nhất', lng: 106.8325, lat: 10.9428 },
  { road: 'Đường Đặng Văn Trơn', neighborhood: 'Khu phố Hiệp Hòa (Cù lao Phố)', lng: 106.8282, lat: 10.9389 },
  { road: 'Đường Lê Thánh Tôn', neighborhood: 'Khu phố Thanh Bình', lng: 106.8205, lat: 10.9469 },
];

interface PilotCategoryTemplate {
  category: IncidentCategory;
  customLabel?: string;
  titles: string[];
  description: string;
  objects: string[];
}

const PILOT_TEMPLATES: readonly PilotCategoryTemplate[] = [
  {
    category: 'giao_thong',
    titles: [
      'Ổ gà sâu trên làn xe hai bánh sau mưa lớn',
      'Nắp hố ga sụt lún gây nguy hiểm giờ cao điểm',
      'Vạch sơn qua đường mờ và biển cảnh báo bị che khuất',
      'Mặt đường nhựa bong tróc tạo rãnh trượt xe máy',
    ],
    description: 'Mặt đường xuất hiện điểm hư hỏng trực tiếp trên trục lưu thông đông phương tiện tại Phường Trấn Biên, cần duy tu sớm.',
    objects: ['pothole', 'damaged_asphalt', 'motorbike_lane'],
  },
  {
    category: 'ha_tang_do_thi',
    titles: [
      'Đèn chiếu sáng cao áp tắt liên tục về đêm',
      'Cành cây xanh gãy treo lơ lửng sát dây điện chiếu sáng',
      'Tủ điều khiển chiếu sáng công cộng hở chốt bảo vệ',
      'Gạch lát vỉa hè bong bật gây vấp ngã người đi bộ',
    ],
    description: 'Hạ tầng kỹ thuật đô thị xuống cấp cục bộ gây mất an toàn cho người dân đi bộ và phương tiện vào ban đêm.',
    objects: ['street_lamp', 'sidewalk_tiles', 'power_line'],
  },
  {
    category: 'moi_truong',
    titles: [
      'Điểm tập kết rác sinh hoạt tự phát sát miệng cống',
      'Xà bần xây dựng đổ trộm lấn chiếm lề đường',
      'Rác nhựa ứ đọng chắn lưới chắn rác thoát nước',
      'Thùng rác công cộng quá tải phát sinh mùi hôi',
    ],
    description: 'Chất thải rắn tồn đọng nhiều giờ chưa được thu gom dứt điểm, làm giảm mỹ quan đô thị và cản trở thoát nước mặt.',
    objects: ['garbage_pile', 'plastic_bags', 'storm_drain'],
  },
  {
    category: 'ngap_nuoc',
    titles: [
      'Ngập nước cục bộ kéo dài sau cơn mưa chiều',
      'Miệng thu nước mưa bị bùn lá bịt kín gây đọng nước',
      'Nước mưa thoát chậm tràn lên vỉa hè khu dân cư',
      'Đoạn trũng đọng nước hơn 25cm giờ tan tầm',
    ],
    description: 'Hệ thống thoát nước mưa bị nghẽn cục bộ khiến nước rút chậm, ảnh hưởng trực tiếp đến sinh hoạt và giao thông.',
    objects: ['standing_water', 'clogged_drain', 'flooded_road'],
  },
  {
    category: 'an_ninh_trat_tu',
    titles: [
      'Xe tải dừng đỗ lấn chiếm hành lang an toàn giao thông đêm',
      'Lấn chiếm lòng lề đường bày bán cản trở xe cứu hỏa',
      'Tụ tập gây tiếng ồn quá giờ quy định tại khu dân cư',
      'Vật liệu xây dựng để tràn ra phần đường xe chạy',
    ],
    description: 'Vi phạm trật tự đô thị và hành lang an toàn giao thông, đề nghị lực lượng chức năng Phường Trấn Biên kiểm tra nhắc nhở.',
    objects: ['encroachment', 'parked_vehicle', 'urban_corridor'],
  },
  {
    category: 'y_te_dich_benh',
    titles: [
      'Bãi đất trống đọng nước tù phát sinh lăng quăng muỗi vằn',
      'Vật chứa phế thải đọng nước mưa sát khu nhà trọ',
      'Điểm nước tù đọng lâu ngày gần cổng trường tiểu học',
      'Rãnh thoát nước hở ứ đọng tiềm ẩn ổ dịch sốt xuất huyết',
    ],
    description: 'Khu vực đọng nước tù nhiều ngày có nguy cơ bùng phát lăng quăng, cần phối hợp Trạm Y tế phường xử lý vệ sinh dịch tễ.',
    objects: ['stagnant_water', 'containers', 'mosquito_risk'],
  },
  {
    category: 'OTHER',
    customLabel: 'Dây cáp viễn thông & Biển hiệu mất an toàn',
    titles: [
      'Bó cáp viễn thông võng thấp ngang đầu hẻm dân sinh',
      'Biển quảng cáo rách khung sắt nguy cơ rơi khi gió giật',
      'Hộp kỹ thuật viễn thông bung nắp sát lối đi bộ',
      'Khung sắt pano cũ nghiêng lệch sau mưa dông',
    ],
    description: 'Sự cố dân sinh đặc thù ngoài danh mục cố định (được phân loại OTHER kèm nhãn chi tiết), cần đơn vị quản lý chuyên ngành phối hợp xử lý.',
    objects: ['telecom_cable', 'signboard_frame', 'utility_box'],
  },
];

const PILOT_STATUS_CYCLE: readonly IncidentStatus[] = [
  'resolved',
  'in_progress',
  'received',
  'resolved',
  'pending_verify',
  'in_progress',
  'resolved',
  'received',
];

/**
 * Sinh deterministic đúng 64 sự cố thí điểm tại Phường Trấn Biên (`wardCode = 'DN-TB'`),
 * đầy đủ GeoJSON `Point [lng, lat]`, `syncId`, `category` (gồm cả `'OTHER'` + `customCategoryLabel`),
 * `aiEvaluation` và `imageFingerprints`.
 */
export function buildTranBien64PilotIncidents(
  reporterId: Types.ObjectId,
): Array<Omit<IIncident, 'createdAt' | 'updatedAt'>> {
  const rnd = mulberry32(20261125);
  const baseTimeMs = Date.UTC(2026, 10, 1, 1, 0, 0);
  const incidents: Array<Omit<IIncident, 'createdAt' | 'updatedAt'>> = [];

  for (let i = 0; i < 64; i += 1) {
    const seq = String(i + 1).padStart(3, '0');
    const codeSeq = String(i + 1).padStart(4, '0');
    const street = TRAN_BIEN_STREETS[i % TRAN_BIEN_STREETS.length];
    const tpl = PILOT_TEMPLATES[i % PILOT_TEMPLATES.length];
    const status = PILOT_STATUS_CYCLE[i % PILOT_STATUS_CYCLE.length];

    // Dịch chuyển vi mô quanh trục đường thật của Phường Trấn Biên (~20m - 120m)
    const lng = Math.round((street.lng + (rnd() - 0.5) * 0.0022) * 100000) / 100000;
    const lat = Math.round((street.lat + (rnd() - 0.5) * 0.0022) * 100000) / 100000;
    if (!isWithinDongNaiBounds(lng, lat)) {
      throw new Error(`Tọa độ sự cố thí điểm #${seq} [${lng}, ${lat}] vượt khung bao Đồng Nai.`);
    }

    const severityLevel = ((i % 5) + 1) as 1 | 2 | 3 | 4 | 5;
    const duplicateCount = i % 9 === 0 ? 2 : i % 5 === 0 ? 1 : 0;
    const createdAt = new Date(baseTimeMs + i * 6 * 3600 * 1000);
    const dHash = deterministicHex(rnd, 16);
    const pHash = deterministicHex(rnd, 16);
    const syncId = `seed-tranbien-pilot-${seq}`;
    const priorityScore = computePriorityScore({
      severityLevel,
      duplicateCount,
      reporterTrustScore: 95,
    });

    const isResolved = status === 'resolved';
    const authenticityScore = 84 + Math.floor(rnd() * 16);
    const sceneMatchScore = duplicateCount > 0 || isResolved ? 86 + Math.floor(rnd() * 12) : null;
    const resolutionScore = isResolved ? 88 + Math.floor(rnd() * 11) : null;

    const timeline: IIncident['timeline'] = [
      {
        status: 'received',
        note: 'Hệ thống tiếp nhận phản ánh thí điểm Phường Trấn Biên và kiểm tra GeoJSON/AI tự động.',
        updatedBy: null,
        proofImageUrl: null,
        timestamp: createdAt,
      },
    ];
    if (status === 'in_progress' || isResolved) {
      timeline.push({
        status: 'in_progress',
        note: 'UBND Phường Trấn Biên đã giao tổ phụ trách đô thị xử lý tại hiện trường.',
        updatedBy: reporterId,
        proofImageUrl: null,
        timestamp: new Date(createdAt.getTime() + 2 * 3600 * 1000),
      });
    }
    if (isResolved) {
      timeline.push({
        status: 'resolved',
        note: 'Đã khắc phục dứt điểm và đối chiếu ảnh nghiệm thu hiện trường đạt yêu cầu.',
        updatedBy: reporterId,
        proofImageUrl: `https://storage.smartcitizen-dongnai.vn/pilot/tranbien-${seq}-after.jpg`,
        timestamp: new Date(createdAt.getTime() + 18 * 3600 * 1000),
      });
    }

    const mediaUrl = `https://storage.smartcitizen-dongnai.vn/pilot/tranbien-${seq}-before.jpg`;
    const houseNo = 12 + ((i * 7) % 240);

    incidents.push({
      incidentCode: `DN-TB-2026-${codeSeq}`,
      syncId,
      clientOfflineId: syncId,
      syncStatus: 'synced',
      clientCreatedAt: createdAt,
      serverReceivedAt: createdAt,
      reporterId,
      wardCode: 'DN-TB',
      category: tpl.category,
      customCategoryLabel: tpl.category === 'OTHER' ? (tpl.customLabel ?? 'Sự cố hạ tầng dân sinh khác') : null,
      title: `${tpl.titles[Math.floor(i / PILOT_TEMPLATES.length) % tpl.titles.length]} – ${street.road}`,
      description: `${tpl.description} (Vị trí ghi nhận gần số ${houseNo} ${street.road}, ${street.neighborhood}, Phường Trấn Biên).`,
      district: 'TP. Đồng Nai',
      location: {
        type: 'Point',
        coordinates: [lng, lat],
        addressText: `Số ${houseNo} ${street.road}, ${street.neighborhood}, Phường Trấn Biên, TP. Đồng Nai`,
        ward: 'Phường Trấn Biên',
        district: 'TP. Đồng Nai',
      },
      media: [
        {
          url: mediaUrl,
          type: 'image',
          dHash,
          capturedAt: createdAt,
        },
      ],
      imageFingerprints: [
        {
          mediaUrl,
          pHash,
          dHash,
          algorithm: 'pHash-64',
          descriptorMetadata: {
            width: 1280,
            height: 960,
            blurScore: Math.round((140 + rnd() * 180) * 10) / 10,
            brightness: Math.round(105 + rnd() * 90),
            keypointCount: 280 + Math.floor(rnd() * 220),
            mimeType: 'image/jpeg',
            byteSize: 185_000 + Math.floor(rnd() * 95_000),
          },
          computedAt: createdAt,
        },
      ],
      aiAnalysis: {
        autoCategory: tpl.category,
        detectedObjects: [...tpl.objects],
        severityLevel,
        summary: `AI xác thực hiện trường tại ${street.road} (mức độ ${severityLevel}/5, độ tin cậy ${authenticityScore}%).`,
        isValidImage: true,
      },
      aiEvaluation: {
        authenticityScore,
        isDuplicate: false,
        matchedIncidentId: null,
        sceneMatchScore,
        resolutionScore,
        modelVersion: 'gemini-3.5-flash',
        evaluatedAt: createdAt,
      },
      priorityScore,
      duplicateControl: {
        isDuplicate: false,
        masterIncidentId: null,
        duplicateCount,
      },
      status,
      timeline,
    });
  }

  return incidents;
}

export function buildProductionSeedOptions(options: { uri?: string; ephemeral?: boolean; includeDemo?: boolean } = {}) {
  const envAutoDemo = ['1', 'true', 'yes'].includes((process.env.AUTO_SEED_DEMO_REPORTS ?? '').trim().toLowerCase());
  return {
    ...options,
    includeDemo: options.includeDemo ?? envAutoDemo,
  };
}

/**
 * Seed Idempotent chuẩn Production cho SmartCitizen Đồng Nai:
 * 1) 95 đơn vị hành chính cấp xã TP. Đồng Nai (23 phường, 72 xã theo NQ 1662; đồng thời lưu chuẩn 2026).
 * 2) 1 tài khoản Quản trị viên (`ADMIN`) đọc từ `.env` (chỉ tạo nếu chưa tồn tại — tuyệt đối không ghi đè mật khẩu đang chạy).
 * 3) Mặc định KHÔNG bơm 64 sự cố mẫu, trừ khi truyền `includeDemo: true` hoặc `AUTO_SEED_DEMO_REPORTS=true`.
 */
export async function runProductionSeed(
  options: { uri?: string; ephemeral?: boolean; includeDemo?: boolean } = {},
): Promise<SeedDatabaseResult> {
  const resolvedOpts = buildProductionSeedOptions(options);
  let memoryServer: { stop: () => Promise<unknown> } | null = null;
  let targetUri = (resolvedOpts.uri ?? process.env.MONGODB_URI ?? '').trim();

  if (!targetUri && options.ephemeral) {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const mongod = await MongoMemoryServer.create();
    memoryServer = mongod;
    targetUri = mongod.getUri('smartcitizen_dongnai');
    console.log('[db:seed] Chế độ --ephemeral: đã khởi chạy mongod thực nghiệm cục bộ.');
  }

  await connectDatabase({ uri: targetUri, ensureIndexes: true });

  try {
    // 1. Nạp Idempotent 95 đơn vị cấp xã TP. Đồng Nai
    const wards = buildDongNai95WardsDataset();
    await Ward.bulkWrite(
      wards.map((w) => ({
        updateOne: {
          filter: { wardCode: w.wardCode },
          update: { $set: w },
          upsert: true,
        },
      })),
      { ordered: false },
    );

    const wardsPhuongNq1662 = await Ward.countDocuments({ kindNq1662: 'Phường' });
    const wardsXaNq1662 = await Ward.countDocuments({ kindNq1662: 'Xã' });
    const wardsPhuong2026 = await Ward.countDocuments({ kind: 'Phường' });
    const wardsXa2026 = await Ward.countDocuments({ kind: 'Xã' });
    const wardsTotal = await Ward.countDocuments();

    // 2. Khởi tạo 1 tài khoản Quản trị viên (ADMIN) từ .env (CHỈ tạo nếu chưa tồn tại)
    const adminCfg = readSuperAdminConfig();
    const passwordHash = hashPassword(adminCfg.passwordPlain);

    const existingSuperAdmin = await User.findOne({
      $or: [
        { role: { $in: ['admin', 'super_admin'] } },
        { phoneNumber: adminCfg.phoneNumber },
        { email: adminCfg.email },
        { staffCode: adminCfg.staffCode },
      ],
    }).lean();

    let superAdminCreated = false;
    let superAdminId: Types.ObjectId;

    if (!existingSuperAdmin) {
      const created = await User.create({
        phoneNumber: adminCfg.phoneNumber,
        email: adminCfg.email,
        staffCode: adminCfg.staffCode,
        passwordHash,
        wardCode: null,
        fullName: adminCfg.fullName,
        role: 'admin',
        assignedArea: { district: 'TP. Đồng Nai', ward: 'Trung tâm IOC Toàn Thành phố' },
        trustScore: 100,
        otpVerification: {
          isVerified: true,
          lastVerifiedAt: new Date(),
          dailyReportCount: 0,
          lastReportDate: null,
        },
        clientOfflineId: 'seed-super-admin-dongnai',
        syncStatus: 'synced',
      });
      superAdminCreated = true;
      superAdminId = created._id;
    } else {
      superAdminId = existingSuperAdmin._id as Types.ObjectId;
    }

    // Đồng bộ sang bảng app_users cho tầng AuthService nếu chưa tồn tại
    const existingAppAdmin = await UserModel.findOne({
      $or: [{ staffCode: adminCfg.staffCode }, { email: adminCfg.email }, { role: { $in: ['admin', 'super_admin', 'city_admin'] } }],
    }).lean();
    if (!existingAppAdmin) {
      await UserModel.create({
        id: 'u_super_admin_env',
        role: 'admin',
        name: adminCfg.fullName,
        phone: adminCfg.phoneNumber,
        email: adminCfg.email,
        staffCode: adminCfg.staffCode,
        passwordHash,
        wardCode: null,
        unitCode: null,
        defaultWardCode: 'DN-TB',
        notificationsEnabled: true,
        revoked: false,
        trustScore: 100,
        badges: ['Quản trị viên IOC'],
        volunteerHours: 0,
        points: 0,
        notifications: [],
        createdAt: new Date().toISOString(),
      });
    }

    let insertedNewCount = 0;
    if (resolvedOpts.includeDemo) {
      const rescueStaffPw = hashPassword(process.env.INITIAL_STAFF_PASSWORD || 'DongNai@2026!');
      const existingRescueUser = await User.findOne({
        $or: [{ staffCode: 'CUUHO-01' }, { email: 'cuuho01@dongnai.gov.vn' }, { phoneNumber: '0900000114' }],
      }).lean();
      if (!existingRescueUser) {
        await User.create({
          phoneNumber: '0900000114',
          email: 'cuuho01@dongnai.gov.vn',
          staffCode: 'CUUHO-01',
          passwordHash: rescueStaffPw,
          wardCode: 'DN-TB',
          fullName: 'Đội Cứu Hộ Phản Ứng Nhanh Trung Tâm (Trấn Biên)',
          role: 'rescue',
          assignedArea: { district: 'TP. Đồng Nai', ward: 'Phường Trấn Biên (Cơ động liên phường)' },
          trustScore: 100,
          otpVerification: {
            isVerified: true,
            lastVerifiedAt: new Date(),
            dailyReportCount: 0,
            lastReportDate: null,
          },
          clientOfflineId: 'seed-rescue-team-01',
          syncStatus: 'synced',
        });
      }
      const existingAppRescue = await UserModel.findOne({
        $or: [{ staffCode: 'CUUHO-01' }, { email: 'cuuho01@dongnai.gov.vn' }],
      }).lean();
      if (!existingAppRescue) {
        await UserModel.create({
          id: 'u_rescue_01',
          role: 'rescue',
          name: 'Đội Cứu Hộ Phản Ứng Nhanh Trung Tâm (Trấn Biên)',
          phone: '0900000114',
          email: 'cuuho01@dongnai.gov.vn',
          staffCode: 'CUUHO-01',
          passwordHash: rescueStaffPw,
          wardCode: 'DN-TB',
          unitCode: 'RESCUE-TB-01',
          defaultWardCode: 'DN-TB',
          notificationsEnabled: true,
          revoked: false,
          trustScore: 100,
          badges: ['Đội Cứu Hộ SOS 24/7'],
          volunteerHours: 0,
          points: 0,
          notifications: [],
          createdAt: new Date().toISOString(),
        });
      }

      const pilotIncidents = buildTranBien64PilotIncidents(superAdminId);
      for (const item of pilotIncidents) {
        const res = await incidentRepository.upsertBySyncId(item);
        if (res.created) {
          insertedNewCount += 1;
        }
      }
    }

    const tranBienPilotTotal = await Incident.countDocuments({
      wardCode: 'DN-TB',
      syncId: { $regex: /^seed-tranbien-pilot-\d{3}$/ },
    });

    const summary: SeedDatabaseResult = {
      wardsTotal,
      wardsPhuongNq1662,
      wardsXaNq1662,
      wardsPhuong2026,
      wardsXa2026,
      tranBienPilotTotal,
      tranBienInsertedNew: insertedNewCount,
      superAdminCreated,
      superAdminEmail: adminCfg.email,
    };

    console.log(
      `[db:seed] Hoàn tất Idempotent Seed:\n` +
        `  - Đơn vị cấp xã TP. Đồng Nai: ${summary.wardsTotal}/95 (NQ 1662: ${summary.wardsPhuongNq1662} phường, ${summary.wardsXaNq1662} xã | NQ 237/2026: ${summary.wardsPhuong2026} phường, ${summary.wardsXa2026} xã)\n` +
        `  - Sự cố thí điểm P. Trấn Biên (DN-TB): ${summary.tranBienPilotTotal}/64 (tạo mới lần này: ${summary.tranBienInsertedNew})\n` +
        `  - Tài khoản Super Admin (${summary.superAdminEmail}): ${summary.superAdminCreated ? 'ĐÃ TẠO MỚI' : 'ĐÃ TỒN TẠI (giữ nguyên)'}`,
    );

    return summary;
  } finally {
    await disconnectDatabase();
    if (memoryServer) {
      await memoryServer.stop();
    }
  }
}

if (require.main === module) {
  const ephemeral = process.argv.includes('--ephemeral');
  runProductionSeed({ ephemeral })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[db:seed] Lỗi:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
