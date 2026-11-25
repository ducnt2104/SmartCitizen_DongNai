import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

/** Tự động xóa nhật ký vận hành audit_logs sau 90 ngày (7,776,000 giây) bảo vệ quota 512MB của MongoDB M0 */
export const AUDIT_LOG_TTL_SECONDS = 90 * 24 * 3600;

export interface IAuditLog {
  actorId: string;
  actorRole: string;
  action: string;
  targetCollection: string;
  targetId: string;
  wardCode?: string | null;
  ipHash?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export type AuditLogDocument = HydratedDocument<IAuditLog>;

const operationalAuditLogSchema = new Schema<IAuditLog>(
  {
    actorId: { type: String, required: true, trim: true, maxlength: 120 },
    actorRole: { type: String, required: true, trim: true, maxlength: 40 },
    action: { type: String, required: true, trim: true, maxlength: 120 },
    targetCollection: { type: String, required: true, trim: true, maxlength: 64 },
    targetId: { type: String, required: true, trim: true, maxlength: 128 },
    wardCode: { type: String, trim: true, uppercase: true, maxlength: 16, default: null },
    ipHash: { type: String, trim: true, maxlength: 128, default: null },
    metadata: { type: Schema.Types.Mixed, default: undefined },
  },
  {
    collection: 'operational_audit_logs',
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  },
);

// TTL Index tự dọn rác audit_logs cũ quá 90 ngày trên MongoDB Atlas Free/M0
operationalAuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: AUDIT_LOG_TTL_SECONDS });
operationalAuditLogSchema.index({ wardCode: 1, action: 1, createdAt: -1 });
operationalAuditLogSchema.index({ actorId: 1, createdAt: -1 });

export const AuditLog: Model<IAuditLog> =
  (mongoose.models.OperationalAuditLog as Model<IAuditLog> | undefined) ??
  mongoose.model<IAuditLog>('OperationalAuditLog', operationalAuditLogSchema);

export { operationalAuditLogSchema };
