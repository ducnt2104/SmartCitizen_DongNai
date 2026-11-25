import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';
import type { WeatherRiskLevel } from '../shared/types';

export interface IWeatherSnapshot {
  id: string;
  regionKey: string;
  regionName: string;
  wardCode: string;
  lat: number;
  lng: number;
  temperatureC: number;
  humidityPct: number;
  precipitationMm: number;
  precipitation24hMm: number;
  precipitationProbabilityPct: number;
  windGustsKmh: number;
  weatherCode: number;
  weatherLabel: string;
  riskLevel: WeatherRiskLevel;
  isHazard: boolean;
  source: string;
  observedAt: string;
  fetchedAt: Date;
}

export type WeatherSnapshotDocument = HydratedDocument<IWeatherSnapshot>;

export const weatherSnapshotSchema = new Schema<IWeatherSnapshot>(
  {
    id: { type: String, required: true, unique: true },
    regionKey: { type: String, required: true, trim: true, maxlength: 64 },
    regionName: { type: String, required: true, trim: true, maxlength: 120 },
    wardCode: { type: String, required: true, trim: true, uppercase: true, maxlength: 16 },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    temperatureC: { type: Number, required: true },
    humidityPct: { type: Number, required: true, min: 0, max: 100 },
    precipitationMm: { type: Number, required: true, min: 0 },
    precipitation24hMm: { type: Number, required: true, min: 0 },
    precipitationProbabilityPct: { type: Number, required: true, min: 0, max: 100 },
    windGustsKmh: { type: Number, required: true, min: 0 },
    weatherCode: { type: Number, required: true },
    weatherLabel: { type: String, required: true, maxlength: 120 },
    riskLevel: {
      type: String,
      enum: ['normal', 'advisory', 'warning', 'emergency'],
      required: true,
      default: 'normal',
    },
    isHazard: { type: Boolean, required: true, default: false },
    source: { type: String, required: true, maxlength: 120, default: 'Open-Meteo' },
    observedAt: { type: String, required: true },
    fetchedAt: { type: Date, required: true, default: () => new Date() },
  },
  {
    collection: 'WeatherSnapshots',
    versionKey: false,
  },
);

weatherSnapshotSchema.index({ regionKey: 1, fetchedAt: -1 });
weatherSnapshotSchema.index({ wardCode: 1, fetchedAt: -1 });
weatherSnapshotSchema.index({ fetchedAt: -1 });
weatherSnapshotSchema.index({ fetchedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export const WeatherSnapshot: Model<IWeatherSnapshot> =
  (mongoose.models.WeatherSnapshot as Model<IWeatherSnapshot> | undefined) ??
  mongoose.model<IWeatherSnapshot>('WeatherSnapshot', weatherSnapshotSchema);
