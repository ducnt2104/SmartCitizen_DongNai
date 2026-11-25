import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';
import type { AlertCategory, AlertSeverity } from '../shared/types';

export interface IBulletin {
  id: string;
  title: string;
  cleanSummary: string;
  category: AlertCategory;
  severity: AlertSeverity;
  wardIds: string[];
  affectedRoads: string[];
  sourceName: string;
  sourceUrl: string;
  sourceUrlHash: string;
  publishedAt: Date;
  fetchedAt: Date;
}

export type BulletinDocument = HydratedDocument<IBulletin>;

export const bulletinSchema = new Schema<IBulletin>(
  {
    id: { type: String, required: true, unique: true },
    title: { type: String, required: true, trim: true, maxlength: 240 },
    cleanSummary: { type: String, required: true, trim: true, maxlength: 800 },
    category: {
      type: String,
      enum: ['disaster', 'traffic', 'utility', 'official_notice'],
      required: true,
    },
    severity: {
      type: Number,
      enum: [1, 2, 3],
      required: true,
      default: 1,
    },
    wardIds: { type: [String], required: true, default: ['ALL_DONG_NAI'] },
    affectedRoads: { type: [String], default: [] },
    sourceName: { type: String, required: true, trim: true, maxlength: 120 },
    sourceUrl: { type: String, required: true, trim: true, maxlength: 600 },
    sourceUrlHash: { type: String, required: true, trim: true, maxlength: 128 },
    publishedAt: { type: Date, required: true },
    fetchedAt: { type: Date, required: true, default: () => new Date() },
  },
  {
    collection: 'Bulletins',
    versionKey: false,
  },
);

bulletinSchema.index({ sourceUrlHash: 1 }, { unique: true });
bulletinSchema.index({ wardIds: 1, publishedAt: -1 });
bulletinSchema.index({ category: 1, severity: -1, publishedAt: -1 });
bulletinSchema.index({ publishedAt: -1 });

export const Bulletin: Model<IBulletin> =
  (mongoose.models.Bulletin as Model<IBulletin> | undefined) ??
  mongoose.model<IBulletin>('Bulletin', bulletinSchema);
