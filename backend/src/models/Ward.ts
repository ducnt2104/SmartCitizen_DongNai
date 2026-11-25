import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';
import type { CityRegionId, WardZone } from '../shared/types';
import { validateDongNaiCoordinates } from './common';

export const WARD_KINDS = ['Phường', 'Xã'] as const;
export type WardKind = (typeof WARD_KINDS)[number];

export const WARD_REGIONS: readonly CityRegionId[] = [
  'trung_tam',
  'nam_san_bay_cang',
  'dong_xuan_loc',
  'dong_bac_cat_tien',
  'bac_dong_nai',
] as const;

export const WARD_ZONES: readonly WardZone[] = [
  'Trung tâm',
  'Công nghiệp',
  'Nông thôn - Sinh thái',
  'Liên vùng',
] as const;

export interface WardGeoPoint {
  type: 'Point';
  /** Chuẩn GeoJSON [longitude, latitude] */
  coordinates: [number, number];
}

export interface IWard {
  wardCode: string;
  name: string;
  shortName: string;
  /** Phân loại theo NQ 237/NQ-UBTVQH16 (30/04/2026: 33 Phường, 62 Xã) */
  kind: WardKind;
  /** Phân loại gốc theo NQ 1662/NQ-UBTVQH15 (01/07/2025: đúng 23 Phường, 72 Xã) */
  kindNq1662: WardKind;
  upgradedOn2026: boolean;
  region: CityRegionId;
  zone: WardZone;
  centerLat: number;
  centerLng: number;
  centerLocation: WardGeoPoint;
  legacyAliases: string[];
  adjacentWardCodes: string[];
  arterialRoads: string[];
  createdAt: Date;
  updatedAt: Date;
}

export type WardDocument = HydratedDocument<IWard>;

const wardGeoPointSchema = new Schema<WardGeoPoint>(
  {
    type: { type: String, enum: ['Point'], default: 'Point', required: true },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: validateDongNaiCoordinates,
        message: 'Tọa độ tâm Phường/Xã phải nằm trong địa giới TP. Đồng Nai.',
      },
    },
  },
  { _id: false },
);

const wardSchema = new Schema<IWard>(
  {
    wardCode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      match: [/^DN-[A-Z]{2,4}$/, 'wardCode phải có dạng DN-XX..DN-XXXX.'],
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    shortName: { type: String, required: true, trim: true, maxlength: 80 },
    kind: { type: String, enum: WARD_KINDS, required: true },
    kindNq1662: { type: String, enum: WARD_KINDS, required: true },
    upgradedOn2026: { type: Boolean, default: false, required: true },
    region: { type: String, enum: WARD_REGIONS, required: true },
    zone: { type: String, enum: WARD_ZONES, required: true },
    centerLat: { type: Number, required: true },
    centerLng: { type: Number, required: true },
    centerLocation: { type: wardGeoPointSchema, required: true },
    legacyAliases: { type: [String], default: [] },
    adjacentWardCodes: { type: [String], default: [] },
    arterialRoads: { type: [String], default: [] },
  },
  {
    collection: 'wards',
    timestamps: true,
    versionKey: false,
  },
);

wardSchema.pre('validate', function syncWardCenterGeoJson() {
  if (Number.isFinite(this.centerLng) && Number.isFinite(this.centerLat)) {
    this.centerLocation = {
      type: 'Point',
      coordinates: [this.centerLng, this.centerLat],
    };
  }
  if (!this.kindNq1662 && this.kind) {
    this.kindNq1662 = this.upgradedOn2026 ? 'Xã' : this.kind;
  }
});

wardSchema.index({ centerLocation: '2dsphere' });
wardSchema.index({ kindNq1662: 1, region: 1 });
wardSchema.index({ kind: 1, region: 1 });

export const Ward: Model<IWard> =
  (mongoose.models.Ward as Model<IWard> | undefined) ?? mongoose.model<IWard>('Ward', wardSchema);

export { wardSchema };
