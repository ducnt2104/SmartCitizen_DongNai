import mongoose, { Schema, type Model, type SchemaDefinition } from 'mongoose';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Model nới lỏng kiểu: tính đúng đắn kiểu nằm ở tầng Repository & Shared Types. */
export type LooseModel = Model<any>;

function mk(def: SchemaDefinition): Schema<any> {
  return new Schema<any>(def as any, { strict: false, versionKey: false });
}

/** Hồ sơ phản ánh: GeoJSON `location` 2dsphere + composite indexes cho truy vấn nóng toàn TP. Đồng Nai. */
const reportSchema = mk({
  id: { type: String, required: true, unique: true },
  code: { type: String, required: true, unique: true },
  category: { type: String, required: true },
  status: { type: String, required: true },
  wardCode: { type: String, required: true },
  reporterId: { type: String, required: true, index: true },
  imageHash: { type: String, default: '' },
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  createdAt: { type: String, required: true },
  location: {
    type: { type: String, enum: ['Point'], required: true, default: 'Point' },
    coordinates: { type: [Number], required: true },
  },
});
// Spatial & Composite Indexes cho Pha 1 (hiệu năng cao trên 95 Phường/Xã)
reportSchema.index({ location: '2dsphere' });
reportSchema.index({ wardCode: 1, status: 1, createdAt: -1 });
reportSchema.index({ category: 1, status: 1 });
reportSchema.index({ lat: 1, lng: 1 });
reportSchema.index({ imageHash: 1, createdAt: -1 });

const userSchema = mk({
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
});

const sessionSchema = mk({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  refreshHash: { type: String, required: true, unique: true },
  expiresAt: { type: Number, required: true },
});

const auditSchema = mk({
  id: { type: String, required: true, unique: true },
  seq: { type: Number, required: true, unique: true },
  timestamp: { type: String, required: true },
});

/** Nhật ký bất biến: chặn mọi thao tác sửa/xóa ở tầng ODM. */
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
export const UserModel = model('AppUser', userSchema, 'app_users');
export const OtpModel = model('OtpChallenge', otpSchema, 'otp_challenges');
export const SessionModel = model('AuthSession', sessionSchema, 'auth_sessions');
export const AuditLogModel = model('AuditLog', auditSchema);

// Export bộ Mongoose Models chuẩn Hybrid Local-First <-> MongoDB Atlas (users, incidents, spam_logs)
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
  INCIDENT_CATEGORIES,
  INCIDENT_STATUSES,
  MEDIA_TYPES,
  generateIncidentCode,
  computePriorityScore,
  type IIncident,
  type IncidentDocument,
  type IncidentCategory,
  type IncidentStatus,
  type IncidentLocation,
  type IncidentMediaItem,
  type IncidentAiAnalysis,
  type IncidentDuplicateControl,
  type IncidentTimelineEntry,
} from './Incident';
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
  DONG_NAI_GEO_BOUNDS,
  SYNC_STATUSES,
  isWithinDongNaiBounds,
  validateDongNaiCoordinates,
  type HybridSyncFields,
  type SyncStatus,
} from './common';
