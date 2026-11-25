import type { Schema, SchemaDefinition } from 'mongoose';

import { DONG_NAI_CITY_BOUNDS } from '../shared/constants';

/**
 * Khung bao địa lý toàn Thành phố Đồng Nai mới (95 Phường/Xã — gồm cả khu vực phía Bắc/Bình Phước cũ
 * và Đông Bắc/Cát Tiên). Chuẩn GeoJSON luôn đặt [longitude, latitude] (Kinh độ trước, Vĩ độ sau).
 */
export const DONG_NAI_GEO_BOUNDS = DONG_NAI_CITY_BOUNDS;

export type SyncStatus = 'synced' | 'conflict';
export const SYNC_STATUSES = ['synced', 'conflict'] as const;

export interface HybridSyncFields {
  /** UUID duy nhất sinh từ IndexedDB trên client để đảm bảo idempotency khi retry mạng chập chờn */
  clientOfflineId?: string;
  syncStatus: SyncStatus;
  /** Thời điểm người dân bấm gửi thực tế dưới thiết bị */
  clientCreatedAt: Date;
  /** Thời điểm server tiếp nhận gói tin */
  serverReceivedAt: Date;
}

export const DHASH_64_REGEX = /^[0-9a-fA-F]{16}$/;
export const VN_PHONE_REGEX = /^0\d{9}$/;

/** Kiểm tra tọa độ (lng, lat) có nằm trong khung bao địa lý toàn Thành phố Đồng Nai hay không. */
export function isWithinDongNaiBounds(lng: number, lat: number): boolean {
  if (
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    lng < DONG_NAI_GEO_BOUNDS.lngMin ||
    lng > DONG_NAI_GEO_BOUNDS.lngMax ||
    lat < DONG_NAI_GEO_BOUNDS.latMin ||
    lat > DONG_NAI_GEO_BOUNDS.latMax
  ) {
    return false;
  }
  // Loại trừ góc Tây Nam thuộc TP.HCM / phía Nam Bình Dương cũ
  if (lat < 11.12 && lng < 106.74) return false;
  return true;
}

/** Validate mảng tọa độ GeoJSON [longitude, latitude] thuộc địa phận tỉnh Đồng Nai. */
export function validateDongNaiCoordinates(coords: unknown): boolean {
  if (!Array.isArray(coords) || coords.length !== 2) return false;
  const [lng, lat] = coords;
  if (typeof lng !== 'number' || typeof lat !== 'number') return false;
  return isWithinDongNaiBounds(lng, lat);
}

/**
 * Các trường bắt buộc của kiến trúc đồng bộ Hybrid (Local-First IndexedDB <-> MongoDB Atlas).
 * Dùng chung cho mọi collection (`users`, `incidents`, `spam_logs`).
 */
export function createHybridSyncDefinition(): SchemaDefinition {
  return {
    clientOfflineId: {
      type: String,
      trim: true,
      maxlength: 128,
      // Index unique + sparse được đăng ký tập trung qua applyHybridSyncIndex() để tránh trùng lặp index
    },
    syncStatus: {
      type: String,
      enum: SYNC_STATUSES,
      default: 'synced',
      required: true,
    },
    clientCreatedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    serverReceivedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
  };
}

/** Đăng ký index unique + sparse trên clientOfflineId cho mọi schema đồng bộ Hybrid. */
export function applyHybridSyncIndex(schema: Schema): void {
  schema.index({ clientOfflineId: 1 }, { unique: true, sparse: true });
}
