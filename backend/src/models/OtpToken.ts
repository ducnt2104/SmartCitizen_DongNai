import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

export const OTP_TOKEN_CHANNELS = ['email', 'phone', 'sms'] as const;
export type OtpTokenChannel = (typeof OTP_TOKEN_CHANNELS)[number];

export const OTP_TOKEN_PURPOSES = ['login', 'reset_password', 'verify_phone'] as const;
export type OtpTokenPurpose = (typeof OTP_TOKEN_PURPOSES)[number];

/** Thời gian sống mặc định của mã OTP: đúng 5 phút (300 giây) */
export const OTP_TOKEN_TTL_SECONDS = 300;
/** Giữ hằng số tương thích ngược cho các module import cũ */
export const OTP_TOKEN_GRACE_TTL_SECONDS = 0;

export interface IOtpToken {
  /** Đích nhận chuẩn hóa: email chữ thường hoặc SĐT E.164 (`+84912345678`) */
  target: string;
  /** Alias tương thích ngược với schema cũ */
  identifier?: string;
  channel: OtpTokenChannel;
  purpose: OtpTokenPurpose;
  /** Bản băm SHA-256 (64 ký tự hex) của mã OTP 6 chữ số */
  otpHash: string;
  /** Salt ngẫu nhiên 128-bit (32 ký tự hex) gắn riêng cho mỗi thử thách OTP */
  otpSalt?: string;
  /** Alias tương thích ngược */
  codeHash?: string;
  /** Số lần nhập sai liên tiếp trên mã OTP này (quá 5 lần hủy ngay) */
  attempts: number;
  failedAttempts?: number;
  /** Thời điểm cho phép gửi lại mã tiếp theo (cooldown 60s) */
  resendAt: Date;
  /** Thời điểm mã bị hủy do nhập sai >= 5 lần */
  invalidatedAt: Date | null;
  lockedUntil: Date | null;
  /** Thời điểm mã đã được sử dụng thành công (chống replay) */
  consumedAt: Date | null;
  /** Thời điểm hết hạn (5 phút) — gắn MongoDB TTL Index tự động xóa */
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type OtpTokenDocument = HydratedDocument<IOtpToken>;

const otpTokenSchema = new Schema<IOtpToken>(
  {
    target: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
      index: true,
    },
    identifier: {
      type: String,
      trim: true,
      maxlength: 160,
    },
    channel: {
      type: String,
      enum: OTP_TOKEN_CHANNELS,
      required: true,
    },
    purpose: {
      type: String,
      enum: OTP_TOKEN_PURPOSES,
      default: 'login',
      required: true,
    },
    otpHash: {
      type: String,
      required: true,
      maxlength: 128,
    },
    otpSalt: {
      type: String,
      trim: true,
      maxlength: 64,
    },
    codeHash: {
      type: String,
      maxlength: 128,
    },
    attempts: {
      type: Number,
      default: 0,
      min: 0,
      required: true,
    },
    failedAttempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    resendAt: {
      type: Date,
      default: () => new Date(Date.now() + 60_000),
      required: true,
    },
    invalidatedAt: {
      type: Date,
      default: null,
    },
    lockedUntil: {
      type: Date,
      default: null,
    },
    consumedAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + OTP_TOKEN_TTL_SECONDS * 1000),
    },
  },
  {
    collection: 'otp_tokens',
    timestamps: true,
    versionKey: false,
  },
);

otpTokenSchema.pre('validate', function syncLegacyAliases() {
  if (!this.target && this.identifier) {
    this.target = this.identifier;
  }
  if (this.target && !this.identifier) {
    this.identifier = this.target;
  }
  if (!this.otpHash && this.codeHash) {
    this.otpHash = this.codeHash;
  }
  if (this.otpHash && !this.codeHash) {
    this.codeHash = this.otpHash;
  }
  if (typeof this.attempts === 'number') {
    this.failedAttempts = this.attempts;
  }
});

// Compound index tra cứu nhanh mã OTP mới nhất theo kênh + đích nhận
otpTokenSchema.index({ channel: 1, target: 1, createdAt: -1 });
// MongoDB TTL Index: tự động xóa bản ghi ngay khi chạm mốc expiresAt (5 phút)
otpTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OtpToken: Model<IOtpToken> =
  (mongoose.models.OtpToken as Model<IOtpToken> | undefined) ??
  mongoose.model<IOtpToken>('OtpToken', otpTokenSchema);

export { otpTokenSchema };
