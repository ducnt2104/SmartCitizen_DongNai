import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

export const AI_CACHE_KINDS = ['vision_triage', 'resolution_verify', 'scene_match', 'duplicate_eval'] as const;
export type AiCacheKind = (typeof AI_CACHE_KINDS)[number];

/** Tự động xóa cache AI sau 7 ngày (604,800 giây) để không tràn dung lượng MongoDB Free/M0 512MB */
export const AI_CACHE_TTL_SECONDS = 7 * 24 * 3600;

export interface IAiCache {
  cacheKey: string;
  kind: AiCacheKind;
  pHash?: string | null;
  modelName: string;
  payload: Record<string, unknown>;
  hitCount: number;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type AiCacheDocument = HydratedDocument<IAiCache>;

const aiCacheSchema = new Schema<IAiCache>(
  {
    cacheKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 180,
    },
    kind: { type: String, enum: AI_CACHE_KINDS, required: true },
    pHash: { type: String, trim: true, lowercase: true, maxlength: 64, default: null },
    modelName: { type: String, trim: true, maxlength: 80, default: 'gemini-3.5-flash-lite', required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    hitCount: { type: Number, default: 0, min: 0, required: true },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + AI_CACHE_TTL_SECONDS * 1000),
      required: true,
    },
  },
  {
    collection: 'ai_cache',
    timestamps: true,
    versionKey: false,
  },
);

// TTL Index tự động dọn rác đúng thời điểm expiresAt (expireAfterSeconds: 0)
aiCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
aiCacheSchema.index({ kind: 1, pHash: 1 });

export const AiCache: Model<IAiCache> =
  (mongoose.models.AiCache as Model<IAiCache> | undefined) ??
  mongoose.model<IAiCache>('AiCache', aiCacheSchema);

export { aiCacheSchema };
