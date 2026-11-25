import mongoose, { Schema, type Model, type SchemaDefinition } from 'mongoose';
import { normalizeSparseString } from './common';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Model nới lỏng kiểu cho tầng tương thích REST runtime: tính đúng đắn kiểu nằm ở tầng Repository & Shared Types. */
export type LooseModel = Model<any>;

function mk(def: SchemaDefinition): Schema<any> {
  return new Schema<any>(def as any, { strict: false, versionKey: false });
}

/** Hồ sơ phản ánh runtime: GeoJSON `location` 2dsphere + Compound IOC Indexes + Unique Sparse `syncId`. */
const reportSchema = mk({
  id: { type: String, required: true, unique: true },
  syncId: { type: String, trim: true, maxlength: 128, set: normalizeSparseString },
  code: { type: String, required: true, unique: true },
  category: { type: String, required: true },
  customCategoryLabel: { type: String, default: null },
  priorityScore: { type: Number, default: 50, min: 0, max: 100 },
  status: { type: String, required: true },
  wardCode: { type: String, required: true },
  reporterId: { type: String, required: true },
  imageHash: { type: String, default: '' },
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  createdAt: { type: String, required: true },
  location: {
    type: { type: String, enum: ['Point'], required: true, default: 'Point' },
    coordinates: { type: [Number], required: true },
  },
});

// Spatial, Compound IOC & Idempotent Sync Indexes trên 95 Phường/Xã
reportSchema.index({ location: '2dsphere' });
reportSchema.index({ wardCode: 1, status: 1, createdAt: -1 });
reportSchema.index({ category: 1, priorityScore: -1, createdAt: -1 });
reportSchema.index({ reporterId: 1, createdAt: -1 });
reportSchema.index({ syncId: 1 }, { unique: true, sparse: true });
reportSchema.index({ imageHash: 1, createdAt: -1 });

const appUserSchema = mk({
  id: { type: String, required: true, unique: true },
  role: { type: String, required: true },
  phone: { type: String, default: null, index: true },
  email: { type: String, default: null, index: true },
  staffCode: { type: String, default: null, index: true },
  wardCode: { type: String, default: null, index: true },
  trustScore: { type: Number, default: 70, min: 0, max: 100 },
});

const otpSchema = mk({
  identifier: { type: String, required: true, unique: true },
  expiresAt: { type: Number, required: true },
  expiresAtDate: { type: Date, default: () => new Date(Date.now() + 5 * 60 * 1000) },
});
// TTL Index: tự xóa otp_challenges sau 1 giờ kể từ khi hết hạn
otpSchema.index({ expiresAtDate: 1 }, { expireAfterSeconds: 3600 });

const sessionSchema = mk({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  refreshHash: { type: String, required: true, unique: true },
  expiresAt: { type: Number, required: true },
  expiresAtDate: { type: Date, default: () => new Date(Date.now() + 7 * 24 * 3600 * 1000) },
});
// TTL Index: tự xóa phiên đăng nhập ngay khi hết hạn Refresh Token
sessionSchema.index({ expiresAtDate: 1 }, { expireAfterSeconds: 0 });

const auditSchema = mk({
  id: { type: String, required: true, unique: true },
  seq: { type: Number, required: true, unique: true },
  timestamp: { type: String, required: true },
});

/** Nhật ký chuỗi băm bất biến: chặn mọi thao tác sửa/xóa ở tầng ODM. */
const IMMUTABLE_OPS = [
  'updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne',
  'deleteOne', 'deleteMany', 'findOneAndDelete',
] as const;
for (const op of IMMUTABLE_OPS) {
  (auditSchema as any).pre(op, function () {
    throw new Error('AuditLog là bất biến: không cho phép sửa hoặc xóa.');
  });
}
auditSchema.pre('save', function (this: any) {
  if (!this.isNew) throw new Error('AuditLog là bất biến: không cho phép sửa.');
});

function model(name: string, schema: Schema<any>, collection?: string): LooseModel {
  return (
    (mongoose.models[name] as LooseModel | undefined) ??
    (mongoose.model(name, schema, collection) as unknown as LooseModel)
  );
}

export const ReportModel = model('Report', reportSchema);
export const UserModel = model('AppUser', appUserSchema, 'app_users');
export const OtpModel = model('OtpChallenge', otpSchema, 'otp_challenges');
export const SessionModel = model('AuthSession', sessionSchema, 'auth_sessions');
export const AuditLogModel = model('AuditLog', auditSchema);

// Export bộ Mongoose Models chuẩn Production MongoDB Atlas
export {
  User,
  userSchema,
  USER_ROLES,
  type AssignedArea,
  type OtpVerificationState,
  type IUser,
  type UserDocument,
  type UserRole,
} from './User';
export {
  Incident,
  incidentSchema,
  LEGACY_INCIDENT_CATEGORIES,
  INCIDENT_CATEGORIES,
  INCIDENT_STATUSES,
  MEDIA_TYPES,
  FINGERPRINT_ALGORITHMS,
  generateIncidentCode,
  computePriorityScore,
  type IIncident,
  type IncidentDocument,
  type IncidentCategory,
  type IncidentStatus,
  type IncidentLocation,
  type IncidentMediaItem,
  type ImageDescriptorMetadata,
  type IncidentImageFingerprint,
  type FingerprintAlgorithm,
  type IncidentAiAnalysis,
  type IncidentAiEvaluation,
  type IncidentDuplicateControl,
  type IncidentTimelineEntry,
} from './Incident';
export {
  Ward,
  wardSchema,
  WARD_KINDS,
  WARD_REGIONS,
  WARD_ZONES,
  type IWard,
  type WardDocument,
  type WardGeoPoint,
  type WardKind,
} from './Ward';
export {
  SpamLog,
  spamLogSchema,
  SPAM_REASONS,
  SPAM_LOG_TTL_SECONDS,
  type ISpamLog,
  type SpamLogDocument,
  type SpamReason,
} from './SpamLog';
export {
  OtpToken,
  otpTokenSchema,
  OTP_TOKEN_CHANNELS,
  OTP_TOKEN_PURPOSES,
  OTP_TOKEN_GRACE_TTL_SECONDS,
  type IOtpToken,
  type OtpTokenDocument,
  type OtpTokenChannel,
  type OtpTokenPurpose,
} from './OtpToken';
export {
  AiCache,
  aiCacheSchema,
  AI_CACHE_KINDS,
  AI_CACHE_TTL_SECONDS,
  type IAiCache,
  type AiCacheDocument,
  type AiCacheKind,
} from './AiCache';
export {
  AuditLog,
  operationalAuditLogSchema,
  AUDIT_LOG_TTL_SECONDS,
  type IAuditLog,
  type AuditLogDocument,
} from './AuditLog';
export {
  DONG_NAI_GEO_BOUNDS,
  SYNC_STATUSES,
  DHASH_64_REGEX,
  PHASH_HEX_REGEX,
  normalizeSparseString,
  isWithinDongNaiBounds,
  validateDongNaiCoordinates,
  type HybridSyncFields,
  type SyncStatus,
} from './common';
