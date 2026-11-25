import { z } from 'zod';
import { DEPARTMENTS, normalizeCategoryInput, normalizeRoleInput } from '../shared/constants';
import { isValidHash } from '../shared/dhash';
import type { Category } from '../shared/types';

const hash = z.string().refine(isValidHash, 'dHash phải là 16 ký tự hex');
const photo = z.object({
  dataUrl: z.string().max(1_900_000).optional(),
  dHash: hash.optional(),
});
const identifier = z.string().min(5).max(120);
const category = z
  .string()
  .refine((v) => normalizeCategoryInput(v) !== null, 'Loại sự cố không hợp lệ (rac_thai, den_duong, ngap_nuoc, mat_duong, khac / OTHER)')
  .transform((v) => normalizeCategoryInput(v) as Category);
const department = z.enum([...DEPARTMENTS] as [string, ...string[]]);
const wardCode = z.string().regex(/^DN-[A-Z]{2,4}$/);
const roleInput = z
  .string()
  .refine(
    (v) => normalizeRoleInput(v) !== null,
    'Vai trò không hợp lệ (ADMIN, OFFICER, RESCUE, CITIZEN)',
  );

export const edgeStatsSchema = z.object({
  blurScore: z.number().min(0).max(1e6),
  brightness: z.number().min(0).max(255),
  flatRatio: z.number().min(0).max(1),
  aspect: z.number().min(0.05).max(20),
  sharpEdgeDensity: z.number().min(0).max(1).optional(),
  likelyScreenshot: z.boolean().optional(),
  screenshotConfidence: z.number().min(0).max(1).optional(),
});

export const exifMetadataSchema = z.object({
  capturedAt: z.string().max(64).nullable().optional(),
  cameraMake: z.string().max(80).nullable().optional(),
  cameraModel: z.string().max(80).nullable().optional(),
  software: z.string().max(160).nullable().optional(),
  gps: z
    .object({
      lat: z.number().finite(),
      lng: z.number().finite(),
      inBounds: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});

export const schemas = {
  otpRequest: z
    .object({
      identifier: identifier.optional(),
      phone: identifier.optional(),
      purpose: z.enum(['login', 'reset_password', 'change_email', 'change_phone']).default('login'),
    })
    .refine((d) => Boolean(d.identifier || d.phone), 'Cần cung cấp email hoặc số điện thoại.'),
  otpVerify: z
    .object({
      identifier: identifier.optional(),
      phone: identifier.optional(),
      code: z.string().regex(/^\d{6}$/, 'Mã OTP gồm đúng 6 chữ số'),
      name: z.string().min(2).max(80).optional(),
      password: z.string().min(8).max(128).optional(),
      defaultWardCode: wardCode.optional(),
    })
    .refine((d) => Boolean(d.identifier || d.phone), 'Cần cung cấp email hoặc số điện thoại.'),
  passwordLogin: z.object({
    identifier,
    password: z.string().min(1).max(128),
  }),
  passwordReset: z.object({
    identifier,
    code: z.string().regex(/^\d{6}$/, 'Mã OTP gồm đúng 6 chữ số'),
    newPassword: z.string().min(8).max(128),
  }),
  reauth: z.object({
    currentPassword: z.string().min(1).max(128).optional(),
    otpCode: z.string().regex(/^\d{6}$/, 'Mã OTP gồm đúng 6 chữ số').optional(),
  }).refine((d) => Boolean(d.currentPassword || d.otpCode), 'Cần nhập mật khẩu hiện tại hoặc mã OTP.'),
  changePassword: z.object({
    currentPassword: z.string().min(1).max(128).optional(),
    otpCode: z.string().regex(/^\d{6}$/, 'Mã OTP gồm đúng 6 chữ số').optional(),
    newPassword: z.string().min(8).max(128),
  }),
  changeEmail: z.object({
    newEmail: z.string().email().max(120),
    otpCode: z.string().regex(/^\d{6}$/, 'Mã OTP gồm đúng 6 chữ số'),
    currentPassword: z.string().min(1).max(128).optional(),
  }),
  changePhone: z.object({
    newPhone: z.string().min(8).max(24),
    otpCode: z.string().regex(/^\d{6}$/, 'Mã OTP gồm đúng 6 chữ số'),
    currentPassword: z.string().min(1).max(128).optional(),
  }),
  staffLogin: z
    .object({
      staffCode: z.string().min(2).max(120).regex(/^[A-Za-z0-9@._+-]+$/).optional(),
      identifier: z.string().min(2).max(120).regex(/^[A-Za-z0-9@._+-]+$/).optional(),
      password: z.string().min(1).max(128),
      unit: z.union([z.literal('city'), z.literal('auto'), wardCode]).optional(),
    })
    .refine((d) => Boolean(d.staffCode || d.identifier), 'Vui lòng nhập Mã tài khoản, Email hoặc Số điện thoại.'),
  rescueLogin: z.object({
    identifier: z.string().min(2).max(120).regex(/^[A-Za-z0-9@._+-]+$/),
    password: z.string().min(1).max(128),
  }),
  updateProfile: z.object({
    name: z.string().min(2).max(80).optional(),
    defaultWardCode: wardCode.nullable().optional(),
    followedWardCodes: z.array(wardCode).max(30).optional(),
    notificationsEnabled: z.boolean().optional(),
    newPassword: z.string().min(8).max(128).optional(),
    currentPassword: z.string().min(1).max(128).optional(),
  }),
  updateFollowedWards: z.object({
    wardCodes: z.array(wardCode).max(30),
  }),
  adminTrustFlag: z.object({
    trustLevel: z.enum(['high', 'normal', 'watchlist', 'flagged']),
    reason: z.string().min(3).max(300),
    trustScore: z.number().min(0).max(100).optional(),
  }),
  adminModerationDecision: z.object({
    decision: z.enum(['APPROVE', 'REJECT']),
    note: z.string().max(400).default(''),
  }),
  volunteerRegister: z.object({ wardCode, unitCode: z.string().max(16) }),

  createStaff: z.object({
    staffCode: z.string().min(3).max(32).regex(/^[A-Za-z0-9-]+$/),
    name: z.string().min(2).max(80),
    password: z.string().min(8).max(128),
    wardCode: wardCode.nullable().optional(),
    email: z.string().email().max(120).optional(),
  }),
  revokeStaff: z.object({ revoked: z.boolean() }),
  transferWard: z.object({ wardCode, note: z.string().max(300).default('') }),

  // Super Admin & RBAC User CRUD
  adminCreateUser: z.object({
    name: z.string().min(2).max(80),
    role: roleInput,
    password: z.string().min(8).max(128).optional(),
    email: z.string().email().max(120).nullable().optional(),
    phone: z.string().max(24).nullable().optional(),
    staffCode: z.string().min(2).max(32).regex(/^[A-Za-z0-9-]+$/).nullable().optional(),
    wardCode: wardCode.nullable().optional(),
    unitCode: z.string().max(24).nullable().optional(),
  }),
  adminUpdateUser: z.object({
    name: z.string().min(2).max(80).optional(),
    role: roleInput.optional(),
    wardCode: z.union([wardCode, z.literal(''), z.null()]).optional(),
    staffCode: z.union([z.string().min(2).max(32).regex(/^[A-Za-z0-9-]+$/), z.literal(''), z.null()]).optional(),
    email: z.union([z.string().email().max(120), z.literal(''), z.null()]).optional(),
    phone: z.union([z.string().max(24), z.literal(''), z.null()]).optional(),
    isActive: z.boolean().optional(),
    trustScore: z.number().min(0).max(100).optional(),
  }),
  adminResetPassword: z.object({
    newPassword: z.string().min(8).max(128),
  }),
  adminUpdateAiConfig: z.object({
    screenshotThreshold: z.number().min(25).max(85).optional(),
    duplicateThreshold: z.number().min(2).max(16).optional(),
    minKeypointInliers: z.number().min(10).max(40).optional(),
    sceneMatchThreshold: z.number().min(40).max(92).optional(),
    resolutionThreshold: z.number().min(45).max(95).optional(),
    allowCloudFallback: z.boolean().optional(),
  }),

  analyzeImage: z.object({
    image: photo.optional(),
    dHash: hash.optional(),
    pHash: hash.optional(),
    subGridHashes: z.array(hash).max(9).optional(),
    colorHistogram: z.array(z.number().min(0).max(1)).max(32).optional(),
    imageSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
    forceCloud: z.boolean().optional(),
    skipCache: z.boolean().optional(),
    category: category.optional(),
    hintText: z.string().trim().max(500).optional(),
    lat: z.number().finite().optional(),
    lng: z.number().finite().optional(),
    wardCode: wardCode.optional(),
    edge: edgeStatsSchema.optional(),
    exif: exifMetadataSchema.optional(),
  }),
  verifyResolution: z.object({
    reportId: z.string().min(3).max(64),
    afterPhoto: photo.optional(),
    dHash: hash.optional(),
    lat: z.number().finite().optional(),
    lng: z.number().finite().optional(),
    edge: edgeStatsSchema.optional(),
    exif: exifMetadataSchema.optional(),
  }),
  tacticalBriefing: z.object({
    reportId: z.string().min(3).max(64).optional(),
    category: category.optional(),
    title: z.string().trim().min(4, 'Tiêu đề sự cố cần tối thiểu 4 ký tự.').max(140).optional(),
    description: z.string().trim().max(800).optional(),
    severity: z.number().int().min(1).max(5).optional(),
    isEmergency: z.boolean().optional(),
    wardCode: wardCode.optional(),
    address: z.string().max(240).optional(),
    forceRefresh: z.boolean().default(false),
  }),
  chat: z.object({
    messages: z
      .array(z.object({ role: z.enum(['user', 'model']), text: z.string().trim().min(1, 'Tin nhắn không được để trống.').max(2000) }))
      .min(1)
      .max(20),
    wardCode: wardCode.optional(),
    locale: z.enum(['vi', 'en']).default('vi'),
  }),

  createReport: z.object({
    idempotencyKey: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
    category,
    aiSuggestedLabel: z.string().max(80).nullable().optional(),
    title: z.string().min(3).max(140),
    description: z.string().max(800).default(''),
    severity: z.coerce.number().int().min(1).max(5).optional(),
    isEmergency: z.boolean().optional(),
    lat: z.number().finite(),
    lng: z.number().finite(),
    wardCode: wardCode.optional(),
    address: z.string().max(240).optional(),
    photo: photo.optional(),
    dHash: hash.optional(),
    deviceLat: z.number().finite().optional(),
    deviceLng: z.number().finite().optional(),
    leftScene: z.boolean().default(false),
    isProxyReport: z.boolean().default(false),
    seniorSubmitted: z.boolean().default(false),
    edge: edgeStatsSchema.optional(),
    exif: exifMetadataSchema.optional(),
  }),
  attachPhoto: z.object({ photo: photo.optional(), dHash: hash.optional() }),
  rate: z.object({ stars: z.number().int().min(1).max(5), comment: z.string().max(400).default('') }),

  assign: z.object({ department, slaHours: z.number().int().min(1).max(720) }),
  status: z.object({ status: z.enum(['verifying', 'processing']) }),
  dispatch: z.object({
    wardCodes: z.array(wardCode).max(10).optional(),
    units: z.array(department).max(6).optional(),
    note: z.string().max(300).default(''),
  }),
  resolve: z.object({
    afterPhoto: photo.optional(),
    dHash: hash.optional(),
    note: z.string().max(300).default(''),
    override: z.boolean().default(false),
    lat: z.number().finite().optional(),
    lng: z.number().finite().optional(),
    edge: edgeStatsSchema.optional(),
    exif: exifMetadataSchema.optional(),
  }),
  markSpam: z.object({ reason: z.string().max(300).default('') }),

  volunteerVerify: z.object({
    verdict: z.enum(['true', 'duplicate', 'fake']),
    note: z.string().max(400).default(''),
    photo: photo.optional(),
  }),

  rescueAccept: z.object({
    lat: z.number().finite().optional(),
    lng: z.number().finite().optional(),
  }),
  rescueStatus: z
    .object({
      status: z
        .enum([
          'ACCEPTED',
          'EN_ROUTE',
          'ARRIVED',
          'IN_PROGRESS',
          'ON_SITE',
          'RESOLVED',
          'accepted',
          'en_route',
          'arrived',
          'in_progress',
          'on_site',
          'resolved',
          'completed',
        ])
        .optional(),
      step: z
        .enum([
          'ACCEPTED',
          'EN_ROUTE',
          'ARRIVED',
          'IN_PROGRESS',
          'ON_SITE',
          'RESOLVED',
          'accepted',
          'en_route',
          'arrived',
          'in_progress',
          'on_site',
          'resolved',
          'completed',
        ])
        .optional(),
      note: z.string().max(400).default(''),
      lat: z.number().finite().optional(),
      lng: z.number().finite().optional(),
      afterPhoto: photo.optional(),
      override: z.boolean().default(false),
      edge: edgeStatsSchema.optional(),
      exif: exifMetadataSchema.optional(),
    })
    .refine((d) => Boolean(d.status || d.step), 'Cần truyền trạng thái nhiệm vụ (EN_ROUTE, ARRIVED, IN_PROGRESS, RESOLVED).'),
  rescueRelease: z.object({
    reason: z.string().trim().min(5, 'Vui lòng nhập lý do trả đơn (tối thiểu 5 ký tự)').max(400),
    lat: z.number().finite().optional(),
    lng: z.number().finite().optional(),
  }),
  rescueLocation: z.object({
    lat: z.number().finite(),
    lng: z.number().finite(),
    heading: z.number().finite().nullable().optional(),
    speed: z.number().finite().nullable().optional(),
  }),
  rescueComplete: z.object({
    afterPhoto: photo.optional(),
    dHash: hash.optional(),
    note: z.string().max(400).default(''),
    override: z.boolean().default(false),
    edge: edgeStatsSchema.optional(),
    exif: exifMetadataSchema.optional(),
    lat: z.number().finite().optional(),
    lng: z.number().finite().optional(),
  }),

  createAlert: z.object({
    title: z.string().trim().min(5).max(180),
    description: z.string().trim().min(5).max(1500),
    category: z.enum(['disaster', 'traffic', 'utility', 'official_notice']),
    severity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    wardIds: z.array(z.union([wardCode, z.literal('ALL_DONG_NAI')])).min(1).max(95),
    affectedRoads: z.array(z.string().trim().min(2).max(120)).max(20).default([]),
    detourNote: z.string().trim().max(500).optional(),
    geometryType: z.enum(['point', 'circle', 'polyline']).default('circle'),
    lat: z.number().min(10.3).max(12.2),
    lng: z.number().min(106.4).max(107.9),
    radiusM: z.number().min(50).max(50000).optional(),
    polyline: z.array(z.tuple([z.number().min(10.3).max(12.2), z.number().min(106.4).max(107.9)])).min(2).max(80).optional(),
    expiresAt: z.string().max(64).optional(),
    sourceUrl: z.string().url().max(500).optional(),
  }),
  updateAlert: z.object({
    status: z.enum(['active', 'resolved']).optional(),
    severity: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    title: z.string().trim().min(5).max(180).optional(),
    description: z.string().trim().min(5).max(1500).optional(),
    detourNote: z.string().trim().max(500).nullable().optional(),
    isVerifiedOfficial: z.boolean().optional(),
  }),
  createCommunityAlert: z.object({
    title: z.string().trim().min(5).max(160),
    description: z.string().trim().min(8).max(1000),
    category: z.enum(['disaster', 'traffic', 'utility', 'official_notice']).default('disaster'),
    severity: z.union([z.literal(1), z.literal(2)]).default(1),
    wardCode: wardCode.optional(),
    lat: z.number().min(10.3).max(12.2),
    lng: z.number().min(106.4).max(107.9),
    affectedRoads: z.array(z.string().trim().min(2).max(120)).max(10).default([]),
  }),
} as const;

export type CreateReportInput = z.infer<typeof schemas.createReport>;
