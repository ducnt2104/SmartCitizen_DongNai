import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';
import {
  applyHybridSyncIndex,
  createHybridSyncDefinition,
  type HybridSyncFields,
} from './common';

export const SPAM_REASONS = [
  'duplicate_dhash',
  'rate_limit_exceeded',
  'ai_rejected_fake_image',
  'gps_out_of_dong_nai',
] as const;
export type SpamReason = (typeof SPAM_REASONS)[number];

/** 30 ngày tính bằng giây cho TTL Index */
export const SPAM_LOG_TTL_SECONDS = 2592000;

export interface ISpamLog extends HybridSyncFields {
  phoneNumber?: string | null;
  ipHash?: string | null;
  deviceFingerprint?: string | null;
  reason: SpamReason;
  blockedAt: Date;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export type SpamLogDocument = HydratedDocument<ISpamLog>;

const spamLogSchema = new Schema<ISpamLog>(
  {
    phoneNumber: {
      type: String,
      trim: true,
      maxlength: 20,
      default: null,
      required: [
        function hasNoOtherIdentifier(this: ISpamLog) {
          return !this.ipHash && !this.deviceFingerprint;
        },
        'Cần ít nhất một trong các định danh: phoneNumber, ipHash hoặc deviceFingerprint.',
      ],
    },
    ipHash: { type: String, trim: true, maxlength: 128, default: null },
    deviceFingerprint: { type: String, trim: true, maxlength: 128, default: null },
    reason: {
      type: String,
      enum: {
        values: SPAM_REASONS,
        message: 'Lý do chặn spam không hợp lệ ({VALUE}).',
      },
      required: [true, 'Lý do chặn spam (reason) là bắt buộc.'],
    },
    blockedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: undefined,
    },
    ...createHybridSyncDefinition(),
  },
  {
    collection: 'spam_logs',
    timestamps: true,
    versionKey: false,
  },
);

// Bảo đảm mỗi bản ghi chặn spam có ít nhất 1 định danh truy vết (SĐT, IP hash hoặc deviceFingerprint)
spamLogSchema.pre('validate', function ensureIdentifier() {
  if (!this.phoneNumber && !this.ipHash && !this.deviceFingerprint) {
    this.invalidate(
      'phoneNumber',
      'Cần ít nhất một trong các định danh: phoneNumber, ipHash hoặc deviceFingerprint.',
    );
  }
});

// TTL Index: MongoDB tự động xóa bản ghi spam_logs sau đúng 30 ngày (2,592,000 giây)
spamLogSchema.index({ blockedAt: 1 }, { expireAfterSeconds: SPAM_LOG_TTL_SECONDS });
// Index truy vết nhanh theo SĐT / thiết bị
spamLogSchema.index({ phoneNumber: 1, blockedAt: -1 });
// Index Hybrid Sync idempotency
applyHybridSyncIndex(spamLogSchema);

export const SpamLog: Model<ISpamLog> =
  (mongoose.models.SpamLog as Model<ISpamLog> | undefined) ??
  mongoose.model<ISpamLog>('SpamLog', spamLogSchema);

export { spamLogSchema };
