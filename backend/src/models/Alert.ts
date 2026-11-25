import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';
import type { AlertCategory, AlertGeometryType, AlertSeverity, AlertSourceType } from '../shared/types';
import { normalizeSparseString } from './common';

export interface IAlert {
  id: string;
  title: string;
  description: string;
  category: AlertCategory;
  severity: AlertSeverity;
  sourceType: AlertSourceType;
  sourceLabel: string;
  sourceUrl?: string | null;
  sourceUrlHash?: string;
  wardIds: string[];
  affectedRoads: string[];
  detourNote?: string | null;
  geometryType: AlertGeometryType;
  lat: number;
  lng: number;
  location: {
    type: 'Point';
    coordinates: [number, number];
  };
  radiusM?: number | null;
  polyline?: Array<[number, number]>;
  status: 'active' | 'resolved';
  isVerifiedOfficial: boolean;
  confirmCount: number;
  confirmedByUserIds: string[];
  clusterReportCount?: number | null;
  clusterDistinctUsers?: number | null;
  createdById?: string | null;
  createdByName?: string | null;
  startsAt?: string | null;
  expiresAt?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type AlertDocument = HydratedDocument<IAlert>;

export const alertSchema = new Schema<IAlert>(
  {
    id: { type: String, required: true, unique: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, required: true, trim: true, maxlength: 2000 },
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
    sourceType: {
      type: String,
      enum: ['official_rss', 'weather_api', 'rescue_admin', 'community_cluster', 'community_user'],
      required: true,
    },
    sourceLabel: { type: String, required: true, trim: true, maxlength: 160 },
    sourceUrl: { type: String, default: null, maxlength: 500 },
    sourceUrlHash: {
      type: String,
      trim: true,
      maxlength: 128,
      set: normalizeSparseString,
    },
    wardIds: { type: [String], required: true, default: ['ALL_DONG_NAI'] },
    affectedRoads: { type: [String], default: [] },
    detourNote: { type: String, default: null, maxlength: 500 },
    geometryType: {
      type: String,
      enum: ['point', 'circle', 'polyline'],
      required: true,
      default: 'point',
    },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    location: {
      type: {
        type: String,
        enum: ['Point'],
        required: true,
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        required: true,
      },
    },
    radiusM: { type: Number, default: null },
    polyline: { type: [[Number]], default: undefined },
    status: {
      type: String,
      enum: ['active', 'resolved'],
      required: true,
      default: 'active',
    },
    isVerifiedOfficial: { type: Boolean, required: true, default: false },
    confirmCount: { type: Number, required: true, default: 0, min: 0 },
    confirmedByUserIds: { type: [String], default: [] },
    clusterReportCount: { type: Number, default: null },
    clusterDistinctUsers: { type: Number, default: null },
    createdById: { type: String, default: null },
    createdByName: { type: String, default: null },
    startsAt: { type: String, default: null },
    expiresAt: { type: String, default: null },
  },
  {
    collection: 'Alerts',
    timestamps: true,
    versionKey: false,
  },
);

alertSchema.index({ location: '2dsphere' });
alertSchema.index({ wardIds: 1, status: 1, severity: -1, createdAt: -1 });
alertSchema.index({ status: 1, category: 1, severity: -1, createdAt: -1 });
alertSchema.index({ affectedRoads: 1, status: 1 });
alertSchema.index({ sourceUrlHash: 1 }, { unique: true, sparse: true });
alertSchema.index({ createdAt: -1 });

export const Alert: Model<IAlert> =
  (mongoose.models.Alert as Model<IAlert> | undefined) ?? mongoose.model<IAlert>('Alert', alertSchema);
