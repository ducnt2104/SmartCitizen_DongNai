import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

export const OTP_TOKEN_CHANNELS = ['email', 'sms'] as const;
export type OtpTokenChannel = (typeof OTP_TOKEN_CHANNELS)[number];

export const OTP_TOKEN_PURPOSES = ['login', 'reset_password', 'verify_phone'] as const;
export type OtpTokenPurpose = (typeof OTP_TOKEN_PURPOSES)[number];

/** Giữ lại bản ghi OTP tối đa 1 giờ sau khi hết hạn để bắt lỗi replay trước khi MongoDB TTL tự xóa */
export const OTP_TOKEN_GRACE_TTL_SECONDS = 3600;

export interface IOtpToken {
  identifier: string;
  channel: OtpTokenChannel;
  purpose: OtpTokenPurpose;
  codeHash: string;
  expiresAt: Date;
  resendAt: Date;
  failedAttempts: number;
  lockedUntil: Date | null;
  consumedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type OtpTokenDocument = HydratedDocument<IOtpToken>;

const otpTokenSchema = new Schema<IOtpToken>(
  {
    identifier: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: 160,
    },
    channel: { type: String, enum: OTP_TOKEN_CHANNELS, required: true },
    purpose: { type: String, enum: OTP_TOKEN_PURPOSES, default: 'login', required: true },
    codeHash: { type: String, required: true, maxlength: 128 },
    expiresAt: { type: Date, required: true },
    resendAt: { type: Date, required: true },
    failedAttempts: { type: Number, default: 0, min: 0, required: true },
    lockedUntil: { type: Date, default: null },
    consumedAt: { type: Date, default: null },
  },
  {
    collection: 'otp_tokens',
    timestamps: true,
    versionKey: false,
  },
);

// TTL Index tự động dọn rác otp_tokens đã hết hạn để tiết kiệm dung lượng cụm MongoDB Atlas M0 (512MB)
otpTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: OTP_TOKEN_GRACE_TTL_SECONDS });

export const OtpToken: Model<IOtpToken> =
  (mongoose.models.OtpToken as Model<IOtpToken> | undefined) ??
  mongoose.model<IOtpToken>('OtpToken', otpTokenSchema);

export { otpTokenSchema };
