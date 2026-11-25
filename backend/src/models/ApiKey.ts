import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';
import {
  API_KEY_PROVIDERS,
  API_KEY_STATUSES,
  GEMINI_ENDPOINT_KINDS,
  type ApiKeyProvider,
  type ApiKeyStatus,
  type GeminiEndpointKind,
} from '../services/keyPool/types';

export interface IApiKey {
  keyId: string;
  label: string;
  provider: ApiKeyProvider;
  geminiEndpoint?: GeminiEndpointKind;
  /** Bản mã AES-256-GCM dạng `v1:<ivBase64>:<authTagBase64>:<cipherBase64>` */
  encryptedKey: string;
  iv: string;
  authTag: string;
  /** SHA-256 của raw key để khử trùng lặp mà không lưu bản rõ */
  keyFingerprint: string;
  /** Chuỗi che hiển thị cho Admin: `AIzaSy...8xKp` */
  maskedKey: string;
  weight: number;
  isEnabled: boolean;
  status: ApiKeyStatus;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  error429Count: number;
  consecutive429: number;
  lastUsedAt: Date | null;
  cooldownUntil: Date | null;
  dailyQuotaExhaustedAt: Date | null;
  quotaResetAt: Date | null;
  lastError: string | null;
  addedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ApiKeyDocument = HydratedDocument<IApiKey>;

function stripCipherFields(_doc: unknown, ret: Record<string, unknown>): Record<string, unknown> {
  delete ret.encryptedKey;
  delete ret.iv;
  delete ret.authTag;
  delete ret._id;
  return ret;
}

const apiKeySchema = new Schema<IApiKey>(
  {
    keyId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 64,
    },
    label: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    provider: {
      type: String,
      enum: API_KEY_PROVIDERS,
      default: 'gemini',
      required: true,
      index: true,
    },
    geminiEndpoint: {
      type: String,
      enum: GEMINI_ENDPOINT_KINDS,
      default: 'ai_studio',
    },
    encryptedKey: {
      type: String,
      required: true,
    },
    iv: {
      type: String,
      required: true,
    },
    authTag: {
      type: String,
      required: true,
    },
    keyFingerprint: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 128,
    },
    maskedKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64,
    },
    weight: {
      type: Number,
      default: 1,
      min: 1,
      max: 20,
    },
    isEnabled: {
      type: Boolean,
      default: true,
      index: true,
    },
    status: {
      type: String,
      enum: API_KEY_STATUSES,
      default: 'HEALTHY',
      required: true,
      index: true,
    },
    totalRequests: { type: Number, default: 0, min: 0 },
    successCount: { type: Number, default: 0, min: 0 },
    errorCount: { type: Number, default: 0, min: 0 },
    error429Count: { type: Number, default: 0, min: 0 },
    consecutive429: { type: Number, default: 0, min: 0 },
    lastUsedAt: { type: Date, default: null },
    cooldownUntil: { type: Date, default: null },
    dailyQuotaExhaustedAt: { type: Date, default: null },
    quotaResetAt: { type: Date, default: null },
    lastError: { type: String, default: null, maxlength: 500 },
    addedBy: { type: String, default: null, maxlength: 64 },
  },
  {
    collection: 'api_keys',
    timestamps: true,
    versionKey: false,
    toJSON: { transform: stripCipherFields },
    toObject: { transform: stripCipherFields },
  },
);

apiKeySchema.index({ provider: 1, isEnabled: 1, status: 1 });

export const ApiKey: Model<IApiKey> =
  (mongoose.models.ApiKey as Model<IApiKey> | undefined) ??
  mongoose.model<IApiKey>('ApiKey', apiKeySchema);

export { apiKeySchema };
