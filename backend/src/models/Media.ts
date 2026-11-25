import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

export interface IMediaAsset {
  id: string;
  reportId: string | null;
  mimeType: 'image/webp';
  width: number;
  height: number;
  dHash: string;
  displayBuffer: Buffer;
  thumbnailBuffer: Buffer;
  displayBytes: number;
  thumbnailBytes: number;
  createdAt: Date;
}

export type MediaAssetDocument = HydratedDocument<IMediaAsset>;

const mediaAssetSchema = new Schema<IMediaAsset>(
  {
    id: { type: String, required: true, unique: true },
    reportId: { type: String, default: null, index: true },
    mimeType: { type: String, enum: ['image/webp'], default: 'image/webp', required: true },
    width: { type: Number, required: true, min: 1 },
    height: { type: Number, required: true, min: 1 },
    dHash: { type: String, default: '', index: true },
    displayBuffer: { type: Buffer, required: true },
    thumbnailBuffer: { type: Buffer, required: true },
    displayBytes: { type: Number, required: true, min: 1 },
    thumbnailBytes: { type: Number, required: true, min: 1 },
  },
  {
    collection: 'media_assets',
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  },
);

mediaAssetSchema.index({ createdAt: -1 });

export const MediaAsset: Model<IMediaAsset> =
  (mongoose.models.MediaAsset as Model<IMediaAsset> | undefined) ??
  mongoose.model<IMediaAsset>('MediaAsset', mediaAssetSchema);

export { mediaAssetSchema };
