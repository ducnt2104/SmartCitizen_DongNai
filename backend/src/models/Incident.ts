import crypto from 'node:crypto';
import mongoose, { Schema, Types, type HydratedDocument, type Model } from 'mongoose';
import {
  applyHybridSyncIndex,
  createHybridSyncDefinition,
  DHASH_64_REGEX,
  DONG_NAI_GEO_BOUNDS,
  validateDongNaiCoordinates,
  type HybridSyncFields,
} from './common';

export const INCIDENT_CATEGORIES = [
  'giao_thong',
  'moi_truong',
  'ha_tang_do_thi',
  'an_ninh_trat_tu',
  'y_te_dich_benh',
  'khac',
] as const;
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];

export const INCIDENT_STATUSES = [
  'pending_verify',
  'received',
  'in_progress',
  'resolved',
  'rejected_spam',
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const MEDIA_TYPES = ['image', 'video'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

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

export interface IncidentAiAnalysis {
  autoCategory: IncidentCategory;
  detectedObjects: string[];
  severityLevel: number;
  summary: string;
  isValidImage: boolean;
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
  reporterId: Types.ObjectId;
  category: IncidentCategory;
  title: string;
  description: string;
  /** Trường phản chiếu từ location.district phục vụ Compound Index hiệu năng cao trên Dashboard IOC */
  district: string;
  location: IncidentLocation;
  media: IncidentMediaItem[];
  aiAnalysis: IncidentAiAnalysis;
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
      match: [/^DN-\d{4}-[A-Z0-9]{5,}$/, 'incidentCode phải có dạng DN-YYYY-XXXXX.'],
    },
    reporterId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'reporterId là bắt buộc.'],
    },
    category: {
      type: String,
      enum: {
        values: INCIDENT_CATEGORIES,
        message: 'Danh mục sự cố không hợp lệ ({VALUE}).',
      },
      required: true,
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
        return this.location?.district;
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

// Tự sinh incidentCode, đồng bộ district top-level từ location.district và tính priorityScore mặc định
incidentSchema.pre('validate', function prepareIncidentFields() {
  if (!this.incidentCode) {
    this.incidentCode = generateIncidentCode();
  }
  if (this.location?.district && !this.district) {
    this.district = this.location.district;
  } else if (this.district && this.location && !this.location.district) {
    this.location.district = this.district;
  }
  if (!this.priorityScore || this.priorityScore === 0) {
    this.priorityScore = computePriorityScore({
      severityLevel: this.aiAnalysis?.severityLevel,
      duplicateCount: this.duplicateControl?.duplicateCount,
      reporterTrustScore: 100,
    });
  }
});

// ── Indexes bắt buộc tối ưu truy vấn không gian, dashboard IOC và chống trùng lặp ──
// 1. 2dsphere Index tìm sự cố trong bán kính 50m–200m và hiển thị bản đồ Đồng Nai
incidentSchema.index({ location: '2dsphere' });
// 2. Compound Index cho dashboard cán bộ lọc ngay điểm nóng ưu tiên cao nhất theo địa bàn
incidentSchema.index({ status: 1, district: 1, priorityScore: -1, createdAt: -1 });
// 3. Index tìm kiếm nhanh ảnh trùng theo 64-bit dHash
incidentSchema.index({ 'media.dHash': 1 });
// 4. Index unique + sparse trên clientOfflineId chống trùng bản ghi khi đồng bộ offline
applyHybridSyncIndex(incidentSchema);
// 5. Index ưu tiên toàn cục
incidentSchema.index({ priorityScore: -1 });

export const Incident: Model<IIncident> =
  (mongoose.models.Incident as Model<IIncident> | undefined) ??
  mongoose.model<IIncident>('Incident', incidentSchema);

export { incidentSchema };
