import { DONG_NAI_BBOX } from '@shared/constants';
import { inDongNaiBBox, resolveAdminUnit } from '@shared/geo';
import type { ReverseGeocodeResult } from '@shared/types';
import { api } from './api';

export interface GpsFix {
  lat: number;
  lng: number;
  accuracy: number;
}

export type GpsErrorKind = 'denied' | 'unavailable' | 'timeout' | 'unsupported';

export class GpsError extends Error {
  constructor(public readonly kind: GpsErrorKind, message: string) {
    super(message);
    this.name = 'GpsError';
  }
}

/** Lấy mẫu GPS chính xác bằng `watchPosition` (tối đa 4.5s, dừng ngay khi accuracy <= 20m). */
export function getGps(timeoutMs = 12000): Promise<GpsFix> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new GpsError('unsupported', 'Thiết bị không hỗ trợ định vị'));
    let best: GpsFix | null = null;
    let settled = false;
    let sampleTimer: number | null = null;
    let watchId: number | null = null;

    const cleanup = (): void => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      if (sampleTimer !== null) window.clearTimeout(sampleTimer);
    };

    const done = (fix: GpsFix | null, err?: GpsError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (fix) resolve(fix);
      else reject(err ?? new GpsError('unavailable', 'Không lấy được vị trí GPS'));
    };

    const hardTimer = window.setTimeout(() => {
      done(best, new GpsError('timeout', 'Hết thời gian chờ tín hiệu GPS'));
    }, timeoutMs);

    watchId = navigator.geolocation.watchPosition(
      (p) => {
        window.clearTimeout(hardTimer);
        const f: GpsFix = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) };
        if (!best || f.accuracy < best.accuracy) best = f;
        if (f.accuracy <= 20) {
          done(best);
        } else if (sampleTimer === null) {
          sampleTimer = window.setTimeout(() => done(best), 4000);
        }
      },
      (e) => {
        window.clearTimeout(hardTimer);
        done(
          best,
          new GpsError(
            e.code === e.PERMISSION_DENIED ? 'denied' : e.code === e.TIMEOUT ? 'timeout' : 'unavailable',
            e.message,
          ),
        );
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}

/**
 * Reverse Geocoding 3 tầng có AbortController:
 *  - Tầng 1: Kiểm tra khung bao toàn Thành phố Đồng Nai (ngoài biên giới -> báo rõ).
 *  - Tầng 2: Gọi backend `/api/geo/reverse` (cache LRU ~11m + Nominatim 4s + chuẩn hóa 2 thế hệ về 95 Phường/Xã).
 *  - Tầng 3: Fallback Nearest Centroid Haversine cục bộ (`needsConfirmation: true`).
 */
export async function reverseGeocode(lat: number, lng: number, signal?: AbortSignal): Promise<ReverseGeocodeResult> {
  if (!inDongNaiBBox(lat, lng)) {
    return resolveAdminUnit({ lat, lng });
  }
  const fallback = resolveAdminUnit({ lat, lng });
  if (!navigator.onLine) return fallback;
  try {
    return await api<ReverseGeocodeResult>(
      `/api/geo/reverse?lat=${encodeURIComponent(lat.toFixed(6))}&lng=${encodeURIComponent(lng.toFixed(6))}`,
      { signal, timeoutMs: 5000 },
    );
  } catch (err) {
    if (signal?.aborted) throw err;
    return fallback;
  }
}

/** Địa danh đại diện phủ khắp 5 vùng toàn Thành phố Đồng Nai khi từ chối GPS. */
export const QUICK_PLACES: ReadonlyArray<{ name: string; lat: number; lng: number; wardCode: string }> = [
  { name: 'Phường Trấn Biên (Trung tâm)', lat: 10.9465, lng: 106.8243, wardCode: 'DN-TB' },
  { name: 'Phường Long Thành (Sân bay)', lat: 10.79, lng: 106.95, wardCode: 'DN-LTH' },
  { name: 'Phường Nhơn Trạch (Cảng)', lat: 10.732, lng: 106.906, wardCode: 'DN-NTR' },
  { name: 'Phường Trảng Bom', lat: 10.954, lng: 107.01, wardCode: 'DN-TBO' },
  { name: 'Phường Long Khánh', lat: 10.93, lng: 107.24, wardCode: 'DN-LKH' },
  { name: 'Phường Xuân Lộc', lat: 10.924, lng: 107.405, wardCode: 'DN-XLO' },
  { name: 'Xã Tà Lài (Cát Tiên)', lat: 11.385, lng: 107.362, wardCode: 'DN-TLA' },
  { name: 'Phường Bình Phước (Đồng Xoài)', lat: 11.535, lng: 106.896, wardCode: 'DN-BP' },
  { name: 'Phường Chơn Thành', lat: 11.425, lng: 106.625, wardCode: 'DN-CTH' },
  { name: 'Phường Lộc Ninh', lat: 11.842, lng: 106.592, wardCode: 'DN-LNI' },
];

export { DONG_NAI_BBOX };
