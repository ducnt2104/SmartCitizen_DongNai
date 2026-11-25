import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

/** TTL 180 ngày cho SecurityAuditLogs để kiểm soát dung lượng MongoDB Atlas Free/M0. */
export const SECURITY_AUDIT_TTL_SECONDS = 180 * 24 * 3600;

export interface ISecurityAuditLog {
  id: string;
  actorId: string;
  actorName: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  ip: string;
  deviceHash: string;
  userAgent: string;
  beforeState: unknown;
  afterState: unknown;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export type SecurityAuditLogDocument = HydratedDocument<ISecurityAuditLog>;

const securityAuditLogSchema = new Schema<ISecurityAuditLog>(
  {
    id: { type: String, required: true, unique: true, trim: true, maxlength: 64 },
    actorId: { type: String, required: true, trim: true, maxlength: 120 },
    actorName: { type: String, required: true, trim: true, maxlength: 120 },
    actorRole: { type: String, required: true, trim: true, maxlength: 40 },
    action: { type: String, required: true, trim: true, maxlength: 120 },
    targetType: { type: String, required: true, trim: true, maxlength: 64 },
    targetId: { type: String, required: true, trim: true, maxlength: 128 },
    ip: { type: String, default: '', maxlength: 64 },
    deviceHash: { type: String, default: '', maxlength: 64 },
    userAgent: { type: String, default: '', maxlength: 200 },
    beforeState: { type: Schema.Types.Mixed, default: null },
    afterState: { type: Schema.Types.Mixed, default: null },
    metadata: { type: Schema.Types.Mixed, default: undefined },
    createdAt: { type: Date, default: () => new Date(), required: true },
  },
  {
    collection: 'SecurityAuditLogs',
    timestamps: false,
    versionKey: false,
  },
);

securityAuditLogSchema.index({ createdAt: -1 });
securityAuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: SECURITY_AUDIT_TTL_SECONDS });
securityAuditLogSchema.index({ actorId: 1, createdAt: -1 });
securityAuditLogSchema.index({ action: 1, createdAt: -1 });
securityAuditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

// Bất biến: cấm sửa/xóa bản ghi SecurityAuditLogs ở tầng Mongoose
const IMMUTABLE_OPS = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const;

for (const op of IMMUTABLE_OPS) {
  (securityAuditLogSchema as unknown as { pre: (op: string, fn: () => void) => void }).pre(op, function () {
    throw new Error('SecurityAuditLogs là bất biến: không cho phép sửa hoặc xóa.');
  });
}

securityAuditLogSchema.pre('save', function () {
  if (!this.isNew) {
    throw new Error('SecurityAuditLogs là bất biến: không cho phép sửa bản ghi đã tồn tại.');
  }
});

export const SecurityAuditLog: Model<ISecurityAuditLog> =
  (mongoose.models.SecurityAuditLog as Model<ISecurityAuditLog> | undefined) ??
  mongoose.model<ISecurityAuditLog>('SecurityAuditLog', securityAuditLogSchema, 'SecurityAuditLogs');

export { securityAuditLogSchema };
