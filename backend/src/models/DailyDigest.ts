import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

export interface IDailyDigest {
  id: string;
  dateKey: string;
  bullets: string[];
  highlightsCount: {
    alerts: number;
    bulletins: number;
    openIncidents: number;
  };
  model: string;
  generatedAt: Date;
  expiresAt: Date;
}

export type DailyDigestDocument = HydratedDocument<IDailyDigest>;

export const dailyDigestSchema = new Schema<IDailyDigest>(
  {
    id: { type: String, required: true, unique: true },
    dateKey: { type: String, required: true, trim: true, maxlength: 32 },
    bullets: { type: [String], required: true, default: [] },
    highlightsCount: {
      alerts: { type: Number, required: true, default: 0 },
      bulletins: { type: Number, required: true, default: 0 },
      openIncidents: { type: Number, required: true, default: 0 },
    },
    model: { type: String, required: true, default: 'fallback', maxlength: 64 },
    generatedAt: { type: Date, required: true, default: () => new Date() },
    expiresAt: { type: Date, required: true },
  },
  {
    collection: 'DailyDigests',
    versionKey: false,
  },
);

dailyDigestSchema.index({ dateKey: 1, generatedAt: -1 });
dailyDigestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 3600 });

export const DailyDigest: Model<IDailyDigest> =
  (mongoose.models.DailyDigest as Model<IDailyDigest> | undefined) ??
  mongoose.model<IDailyDigest>('DailyDigest', dailyDigestSchema);
