import crypto from 'node:crypto';
import mongoose, { Schema, Types, type HydratedDocument, type Model } from 'mongoose';
import { matchWardByAddressText, WARD_BY_CODE } from '../shared/dongNaiWards';
import { resolveAdminUnit } from '../shared/geo';
import {
  applyHybridSyncIndex,
  createHybridSyncDefinition,
  DHASH_64_REGEX,
  DONG_NAI_GEO_BOUNDS,
  isWithinDongNaiBounds,
  normalizeSparseString,
  PHASH_HEX_REGEX,
  validateDongNaiCoordinates,
  type HybridSyncFields,
} from './common';

/** 6 danh mục tiếng Việt truyền thống (giữ tương thích ngược 100% với bộ seed & service cũ) */
export const LEGACY_INCIDENT_CATEGORIES = [
  'giao_thong',
  'moi_truong',
  'ha_tang_do_thi',
  'an_ninh_trat_tu',
  'y_te_dich_benh',
  'khac',
] as const;

/** Tập danh mục mở rộng chuẩn hóa toàn hệ thống — hỗ trợ đầy đủ 'OTHER' kèm customCategoryLabel */
export const INCIDENT_CATEGORIES = [
  ...LEGACY_INCIDENT_CATEGORIES,
  'rac_thai',
  'den_duong',
  'ngap_nuoc',
  'mat_duong',
  'TRAFFIC',
  'ENVIRONMENT',
  'INFRASTRUCTURE',
  'SECURITY',
  'HEALTH',
  'WASTE',
  'STREETLIGHT',
  'FLOODING',
  'ROAD_DAMAGE',
  'OTHER',
] as const;
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];

export const INCIDENT_STATUSES = [
  'pending_verify',
  'received',
  'verifying',
  'in_progress',
  'processing',
  'resolved',
  'quarantined',
  'rejected',
  'rejected_spam',
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const MEDIA_TYPES = ['image', 'video'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const FINGERPRINT_ALGORITHMS = ['pHash-64', 'dHash-64', 'aHash-64', 'orb-256'] as const;
export type FingerprintAlgorithm = (typeof FINGERPRINT_ALGORITHMS)[number];

export interface IncidentLocation {
  type: 'Point';
  /** Chuẩn GeoJSON: [longitude, latitude] */
  coordinates: [number, number];
  addressText: string;
  ward: string;
  district: string;
}

export interface IncidentMediaItem {
  url: string;
  type: MediaType;
  /** Chuỗi 64-bit dHash (16 ký tự hex) tính từ Web Worker của client */
  dHash: string;
  capturedAt: Date;
}

export interface ImageDescriptorMetadata {
  width?: number;
  height?: number;
  blurScore?: number;
  brightness?: number;
  keypointCount?: number;
  /** Chữ ký đặc trưng ORB/cục bộ dạng nén gọn để không vượt giới hạn lưu trữ M0 */
  orbSignature?: string;
  mimeType?: string;
  byteSize?: number;
}

export interface IncidentImageFingerprint {
  mediaUrl?: string;
  /** Chuỗi Perceptual Hash (pHash/dHash 64-bit..256-bit hex) phục vụ so khớp tốc độ cao */
  pHash: string;
  dHash?: string;
  algorithm: FingerprintAlgorithm;
  descriptorMetadata: ImageDescriptorMetadata;
  computedAt: Date;
}

export interface IncidentAiAnalysis {
  autoCategory: IncidentCategory;
  detectedObjects: string[];
  severityLevel: number;
  summary: string;
  isValidImage: boolean;
}

/** Kết quả đánh giá chuyên sâu từ AI / Computer Vision Engine (xác thực ảnh, trùng lặp, nghiệm thu) */
export interface IncidentAiEvaluation {
  authenticityScore: number;
  isDuplicate: boolean;
  matchedIncidentId: Types.ObjectId | string | null;
  sceneMatchScore: number | null;
  resolutionScore: number | null;
  modelVersion?: string;
  evaluatedAt?: Date;
}

export interface IncidentDuplicateControl {
  isDuplicate: boolean;
  masterIncidentId: Types.ObjectId | null;
  duplicateCount: number;
}

export interface IncidentTimelineEntry {
  status: IncidentStatus;
  note: string;
  updatedBy: Types.ObjectId | null;
  proofImageUrl: string | null;
  timestamp: Date;
}

export interface IIncident extends HybridSyncFields {
  incidentCode: string;
  /** Mã đồng bộ chống trùng lặp (Unique Sparse Index) từ Client Outbox Queue */
  syncId?: string;
  reporterId: Types.ObjectId;
  /** Mã đơn vị hành chính chuẩn 95 Phường/Xã TP. Đồng Nai (vd: DN-TB, DN-TLA) */
  wardCode: string;
  category: IncidentCategory;
  /** Nhãn danh mục tùy chỉnh do người dân/AI cung cấp khi category === 'OTHER' */
  customCategoryLabel?: string | null;
  title: string;
  description: string;
  /** Trường phản chiếu từ location.district phục vụ Compound Index tương thích ngược */
  district: string;
  location: IncidentLocation;
  media: IncidentMediaItem[];
  imageFingerprints: IncidentImageFingerprint[];
  aiAnalysis: IncidentAiAnalysis;
  aiEvaluation: IncidentAiEvaluation;
  priorityScore: number;
  duplicateControl: IncidentDuplicateControl;
  status: IncidentStatus;
  timeline: IncidentTimelineEntry[];
  createdAt: Date;
  updatedAt: Date;
}

export type IncidentDocument = HydratedDocument<IIncident>;

/** Sinh mã phản ánh duy nhất dạng DN-2026-XXXXX */
export function generateIncidentCode(year = new Date().getFullYear()): string {
  const token = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 5);
  return `DN-${year}-${token}`;
}

/**
 * Công thức chấm điểm ưu tiên tự động (thang 0–100):
 * - Mức độ nghiêm trọng từ AI Gemini Flash Vision (1–5): tối đa 50 điểm
 * - Số lượng người dân cùng phản ánh (duplicateCount): mỗi tin gộp +6 điểm, tối đa 30 điểm
 * - Điểm uy tín công dân (reporterTrustScore 0–100): tối đa 20 điểm
 */
export function computePriorityScore(params: {
  severityLevel?: number;
  duplicateCount?: number;
  reporterTrustScore?: number;
}): number {
  const severity = Math.max(1, Math.min(5, Math.round(params.severityLevel ?? 3)));
  const duplicates = Math.max(0, Math.floor(params.duplicateCount ?? 0));
  const trust = Math.max(0, Math.min(100, params.reporterTrustScore ?? 100));
  const score = severity * 10 + Math.min(30, duplicates * 6) + Math.round((trust / 100) * 20);
  return Math.max(0, Math.min(100, score));
}

const locationSchema = new Schema<IncidentLocation>(
  {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
      required: true,
    },
    coordinates: {
      type: [Number],
      required: [true, 'Tọa độ GeoJSON [longitude, latitude] là bắt buộc.'],
      validate: {
        validator: validateDongNaiCoordinates,
        message: `Tọa độ [longitude, latitude] phải nằm trong khung bao tỉnh Đồng Nai (lng: ${DONG_NAI_GEO_BOUNDS.lngMin}–${DONG_NAI_GEO_BOUNDS.lngMax}, lat: ${DONG_NAI_GEO_BOUNDS.latMin}–${DONG_NAI_GEO_BOUNDS.latMax}).`,
      },
    },
    addressText: {
      type: String,
      required: [true, 'Địa chỉ hiện trường (addressText) là bắt buộc.'],
      trim: true,
      maxlength: [300, 'Địa chỉ tối đa 300 ký tự.'],
    },
    ward: {
      type: String,
      required: [true, 'Phường/Xã là bắt buộc.'],
      trim: true,
      maxlength: 100,
    },
    district: {
      type: String,
      required: [true, 'Quận/Huyện/Thành phố là bắt buộc.'],
      trim: true,
      maxlength: 100,
    },
  },
  { _id: false },
);

const mediaItemSchema = new Schema<IncidentMediaItem>(
  {
    url: { type: String, required: true, trim: true, maxlength: 2048 },
    type: { type: String, enum: MEDIA_TYPES, default: 'image', required: true },
    dHash: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      validate: {
        validator: (v: string) => DHASH_64_REGEX.test(v),
        message: 'dHash phải là chuỗi hex 64-bit dài đúng 16 ký tự.',
      },
    },
    capturedAt: { type: Date, default: Date.now, required: true },
  },
  { _id: false },
);

const descriptorMetadataSchema = new Schema<ImageDescriptorMetadata>(
  {
    width: { type: Number, min: 1, max: 16384 },
    height: { type: Number, min: 1, max: 16384 },
    blurScore: { type: Number, min: 0 },
    brightness: { type: Number, min: 0, max: 255 },
    keypointCount: { type: Number, min: 0, max: 50000 },
    orbSignature: { type: String, trim: true, maxlength: 2048 },
    mimeType: { type: String, trim: true, maxlength: 64 },
    byteSize: { type: Number, min: 0 },
  },
  { _id: false },
);

const imageFingerprintSchema = new Schema<IncidentImageFingerprint>(
  {
    mediaUrl: { type: String, trim: true, maxlength: 2048 },
    pHash: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      validate: {
        validator: (v: string) => PHASH_HEX_REGEX.test(v),
        message: 'pHash phải là chuỗi hex hợp lệ (16–64 ký tự).',
      },
    },
    dHash: {
      type: String,
      trim: true,
      lowercase: true,
      validate: {
        validator: (v: string | undefined) => !v || DHASH_64_REGEX.test(v),
        message: 'dHash phải là chuỗi hex 16 ký tự.',
      },
    },
    algorithm: {
      type: String,
      enum: FINGERPRINT_ALGORITHMS,
      default: 'pHash-64',
      required: true,
    },
    descriptorMetadata: {
      type: descriptorMetadataSchema,
      default: () => ({}),
      required: true,
    },
    computedAt: { type: Date, default: Date.now, required: true },
  },
  { _id: false },
);

const aiAnalysisSchema = new Schema<IncidentAiAnalysis>(
  {
    autoCategory: { type: String, enum: INCIDENT_CATEGORIES, default: 'khac' },
    detectedObjects: {
      type: [String],
      default: [],
      validate: {
        validator: (arr: string[]) => arr.length <= 20,
        message: 'detectedObjects tối đa 20 đối tượng.',
      },
    },
    severityLevel: { type: Number, min: 1, max: 5, default: 3, required: true },
    summary: { type: String, trim: true, maxlength: 500, default: '' },
    isValidImage: { type: Boolean, default: true, required: true },
  },
  { _id: false },
);

const aiEvaluationSchema = new Schema<IncidentAiEvaluation>(
  {
    authenticityScore: { type: Number, min: 0, max: 100, default: 100, required: true },
    isDuplicate: { type: Boolean, default: false, required: true },
    matchedIncidentId: { type: Schema.Types.Mixed, default: null },
    sceneMatchScore: { type: Number, min: 0, max: 100, default: null },
    resolutionScore: { type: Number, min: 0, max: 100, default: null },
    modelVersion: { type: String, trim: true, maxlength: 80, default: 'gemini-3.5-flash' },
    evaluatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const duplicateControlSchema = new Schema<IncidentDuplicateControl>(
  {
    isDuplicate: { type: Boolean, default: false, required: true },
    masterIncidentId: { type: Schema.Types.ObjectId, ref: 'Incident', default: null },
    duplicateCount: { type: Number, default: 0, min: 0, required: true },
  },
  { _id: false },
);

const timelineEntrySchema = new Schema<IncidentTimelineEntry>(
  {
    status: { type: String, enum: INCIDENT_STATUSES, required: true },
    note: { type: String, trim: true, maxlength: 500, default: '' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    proofImageUrl: { type: String, trim: true, maxlength: 2048, default: null },
    timestamp: { type: Date, default: Date.now, required: true },
  },
  { _id: false },
);

const incidentSchema = new Schema<IIncident>(
  {
    incidentCode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      default: () => generateIncidentCode(),
      match: [/^DN-(?:[A-Z]{2,4}-)?\d{4}-[A-Z0-9]{3,10}$/, 'incidentCode phải có dạng DN-YYYY-XXXXX hoặc DN-TB-YYYY-XXXX.'],
    },
    syncId: {
      type: String,
      trim: true,
      maxlength: 128,
      set: normalizeSparseString,
    },
    reporterId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'reporterId là bắt buộc.'],
    },
    wardCode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 16,
      default: 'DN-TB',
    },
    category: {
      type: String,
      enum: {
        values: INCIDENT_CATEGORIES,
        message: 'Danh mục sự cố không hợp lệ ({VALUE}).',
      },
      required: true,
    },
    customCategoryLabel: {
      type: String,
      trim: true,
      maxlength: [120, 'Nhãn danh mục tùy chỉnh tối đa 120 ký tự.'],
      default: null,
    },
    title: {
      type: String,
      required: [true, 'Tiêu đề phản ánh là bắt buộc.'],
      trim: true,
      minlength: [3, 'Tiêu đề tối thiểu 3 ký tự.'],
      maxlength: [150, 'Tiêu đề tối đa 150 ký tự.'],
    },
    description: {
      type: String,
      required: [true, 'Mô tả phản ánh là bắt buộc.'],
      trim: true,
      maxlength: [2000, 'Mô tả tối đa 2000 ký tự.'],
    },
    district: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
      default(this: IIncident) {
        return this.location?.district || 'TP. Đồng Nai';
      },
    },
    location: {
      type: locationSchema,
      required: [true, 'Vị trí GeoJSON là bắt buộc.'],
    },
    media: {
      type: [mediaItemSchema],
      default: [],
      validate: {
        validator: (arr: IncidentMediaItem[]) => arr.length <= 10,
        message: 'Mỗi phản ánh lưu tối đa 10 tệp media để tối ưu kích thước document.',
      },
    },
    imageFingerprints: {
      type: [imageFingerprintSchema],
      default: [],
      validate: {
        validator: (arr: IncidentImageFingerprint[]) => arr.length <= 10,
        message: 'Mỗi phản ánh lưu tối đa 10 vân tay ảnh (imageFingerprints).',
      },
    },
    aiAnalysis: {
      type: aiAnalysisSchema,
      default: () => ({
        autoCategory: 'khac',
        detectedObjects: [],
        severityLevel: 3,
        summary: '',
        isValidImage: true,
      }),
      required: true,
    },
    aiEvaluation: {
      type: aiEvaluationSchema,
      default: () => ({
        authenticityScore: 100,
        isDuplicate: false,
        matchedIncidentId: null,
        sceneMatchScore: null,
        resolutionScore: null,
        modelVersion: 'gemini-3.5-flash',
        evaluatedAt: new Date(),
      }),
      required: true,
    },
    priorityScore: {
      type: Number,
      default(this: IIncident) {
        return computePriorityScore({
          severityLevel: this.aiAnalysis?.severityLevel,
          duplicateCount: this.duplicateControl?.duplicateCount,
          reporterTrustScore: 100,
        });
      },
      min: 0,
      max: 100,
      required: true,
    },
    duplicateControl: {
      type: duplicateControlSchema,
      default: () => ({
        isDuplicate: false,
        masterIncidentId: null,
        duplicateCount: 0,
      }),
      required: true,
    },
    status: {
      type: String,
      enum: {
        values: INCIDENT_STATUSES,
        message: 'Trạng thái phản ánh không hợp lệ ({VALUE}).',
      },
      default: 'pending_verify',
      required: true,
    },
    timeline: {
      type: [timelineEntrySchema],
      default: [],
      validate: {
        validator: (arr: IncidentTimelineEntry[]) => arr.length <= 50,
        message: 'Timeline tối đa 50 mốc sự kiện trên mỗi hồ sơ.',
      },
    },
    ...createHybridSyncDefinition(),
  },
  {
    collection: 'incidents',
    timestamps: true,
    versionKey: false,
  },
);

// Tự sinh incidentCode, chuẩn hóa syncId/clientOfflineId, phân giải wardCode 95 ĐVHC, điền thông tin địa lý & pHash
incidentSchema.pre('validate', function prepareIncidentFields() {
  if (!this.incidentCode) {
    this.incidentCode = generateIncidentCode();
  }

  // Chuẩn hóa và đồng bộ 2 chiều syncId <-> clientOfflineId (bỏ chuỗi rỗng cho sparse unique index)
  this.syncId = normalizeSparseString(this.syncId);
  this.clientOfflineId = normalizeSparseString(this.clientOfflineId);
  if (this.syncId && !this.clientOfflineId) {
    this.clientOfflineId = this.syncId;
  } else if (this.clientOfflineId && !this.syncId) {
    this.syncId = this.clientOfflineId;
  }

  // Phân giải tự động wardCode và các trường mô tả vị trí từ tọa độ GeoJSON [lng, lat]
  const coords = this.location?.coordinates;
  const hasValidCoords =
    Array.isArray(coords) &&
    coords.length === 2 &&
    typeof coords[0] === 'number' &&
    typeof coords[1] === 'number' &&
    isWithinDongNaiBounds(coords[0], coords[1]);

  if (this.location) {
    if (!this.wardCode || this.wardCode === 'DN-TB') {
      const hintText = [this.location.ward, this.location.district, this.location.addressText]
        .filter(Boolean)
        .join(', ');
      const matched = hintText ? matchWardByAddressText(hintText) : null;
      if (matched) {
        this.wardCode = matched.ward.wardCode;
      } else if (hasValidCoords) {
        const resolved = resolveAdminUnit({ lat: coords[1], lng: coords[0], rawAddressText: hintText });
        if (resolved.wardCode) {
          this.wardCode = resolved.wardCode;
        }
      }
    }

    const wardInfo = WARD_BY_CODE[this.wardCode];
    if (!this.location.ward && wardInfo) {
      this.location.ward = wardInfo.name;
    }
    if (!this.location.district) {
      this.location.district = this.district || 'TP. Đồng Nai';
    }
    if (!this.location.addressText && wardInfo) {
      this.location.addressText = `${wardInfo.name}, TP. Đồng Nai`;
    }
  }

  if (this.location?.district && !this.district) {
    this.district = this.location.district;
  } else if (this.district && this.location && !this.location.district) {
    this.location.district = this.district;
  }

  if (this.category === 'OTHER' && !this.customCategoryLabel) {
    this.customCategoryLabel = 'Sự cố dân sinh khác';
  }

  // Tự động trích xuất vân tay ảnh (imageFingerprints) từ media nếu client chỉ gửi media.dHash hợp lệ
  if ((!this.imageFingerprints || this.imageFingerprints.length === 0) && Array.isArray(this.media) && this.media.length > 0) {
    const validMedia = this.media.filter((m) => m && typeof m.dHash === 'string' && DHASH_64_REGEX.test(m.dHash));
    if (validMedia.length > 0) {
      this.imageFingerprints = validMedia.map((m) => ({
        mediaUrl: m.url,
        pHash: m.dHash.toLowerCase(),
        dHash: m.dHash.toLowerCase(),
        algorithm: 'dHash-64',
        descriptorMetadata: {},
        computedAt: m.capturedAt ?? new Date(),
      }));
    }
  }

  // Đồng bộ cờ trùng lặp giữa duplicateControl và aiEvaluation
  if (this.duplicateControl?.isDuplicate && this.aiEvaluation && !this.aiEvaluation.isDuplicate) {
    this.aiEvaluation.isDuplicate = true;
    if (!this.aiEvaluation.matchedIncidentId && this.duplicateControl.masterIncidentId) {
      this.aiEvaluation.matchedIncidentId = this.duplicateControl.masterIncidentId;
    }
  }

  if (!this.priorityScore || this.priorityScore === 0) {
    this.priorityScore = computePriorityScore({
      severityLevel: this.aiAnalysis?.severityLevel,
      duplicateCount: this.duplicateControl?.duplicateCount,
      reporterTrustScore: 100,
    });
  }
});

// ── Hệ thống Indexes chuẩn Production (<10ms truy vấn không gian & IOC Dashboard) ──
// 1. GeoJSON 2dsphere Index cho truy vấn bán kính ($nearSphere) và khung bản đồ ($geoWithin)
incidentSchema.index({ location: '2dsphere' });
// 2. Compound Indexes tăng tốc IOC Dashboard 95 Phường/Xã
incidentSchema.index({ wardCode: 1, status: 1, createdAt: -1 });
incidentSchema.index({ category: 1, priorityScore: -1, createdAt: -1 });
incidentSchema.index({ reporterId: 1, createdAt: -1 });
// 3. Compound Index tương thích ngược theo district
incidentSchema.index({ status: 1, district: 1, priorityScore: -1, createdAt: -1 });
// 4. Index tìm kiếm nhanh ảnh trùng theo 64-bit dHash & pHash
incidentSchema.index({ 'media.dHash': 1 });
incidentSchema.index({ 'imageFingerprints.pHash': 1 });
// 5. Unique Sparse Index trên syncId & clientOfflineId đảm bảo Idempotent Write cho Outbox Queue
incidentSchema.index({ syncId: 1 }, { unique: true, sparse: true });
applyHybridSyncIndex(incidentSchema);
// 6. Index sắp xếp điểm ưu tiên toàn cục
incidentSchema.index({ priorityScore: -1 });

export const Incident: Model<IIncident> =
  (mongoose.models.Incident as Model<IIncident> | undefined) ??
  mongoose.model<IIncident>('Incident', incidentSchema);

export { incidentSchema };
