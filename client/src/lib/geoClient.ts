import { DONG_NAI_BBOX } from '@shared/constants';
import { inDongNaiBBox, nearestWard } from '@shared/geo';

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

export function getGps(timeoutMs = 12000): Promise<GpsFix> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new GpsError('unsupported', 'Thiết bị không hỗ trợ định vị'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) =>
        reject(
          new GpsError(
            e.code === e.PERMISSION_DENIED ? 'denied' : e.code === e.TIMEOUT ? 'timeout' : 'unavailable',
            e.message,
          ),
        ),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 10000 },
    );
  });
}

export interface GeocodeResult {
  address: string;
  source: 'osm' | 'local';
}

/** Reverse geocoding bằng OSM Nominatim (khi online); mất mạng/chậm → dùng địa chỉ gần đúng theo xã/phường cục bộ. */
export async function reverseGeocode(lat: number, lng: number): Promise<GeocodeResult> {
  const ward = nearestWard(lat, lng);
  const local: GeocodeResult = { address: `${ward.name}, TP. Đồng Nai`, source: 'local' };
  if (!navigator.onLine || !inDongNaiBBox(lat, lng)) return local;
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 4500);
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=vi&lat=${lat}&lon=${lng}`,
      { signal: ctrl.signal },
    );
    if (!res.ok) return local;
    const j = (await res.json()) as { address?: Record<string, string> };
    const a = j.address ?? {};
    const street = [a.house_number, a.road].filter(Boolean).join(' ');
    const parts = [street, ward.name, 'TP. Đồng Nai'].filter(Boolean);
    return street ? { address: parts.join(', '), source: 'osm' } : local;
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'AbortError')) console.warn('Reverse geocoding lỗi, dùng địa chỉ cục bộ:', err);
    return local;
  } finally {
    window.clearTimeout(timer);
  }
}

/** Địa danh nổi bật để chọn nhanh khi từ chối GPS. */
export const QUICK_PLACES: ReadonlyArray<{ name: string; lat: number; lng: number; wardCode: string }> = [
  { name: 'UBND Phường Trấn Biên', lat: 10.9465, lng: 106.8243, wardCode: 'DN-TB' },
  { name: 'Công viên Biên Hùng', lat: 10.9566, lng: 106.8431, wardCode: 'DN-BH' },
  { name: 'Ngã tư Nguyễn Ái Quốc – QL1A', lat: 10.9461, lng: 106.8252, wardCode: 'DN-TB' },
  { name: 'Chợ Biên Hòa', lat: 10.9522, lng: 106.8186, wardCode: 'DN-TB' },
  { name: 'Trung tâm Long Khánh', lat: 10.93, lng: 107.24, wardCode: 'DN-LKH' },
  { name: 'Trung tâm Long Thành', lat: 10.79, lng: 106.95, wardCode: 'DN-LTH' },
  { name: 'Trung tâm Nhơn Trạch', lat: 10.73, lng: 106.94, wardCode: 'DN-NTR' },
  { name: 'Trảng Bom', lat: 10.954, lng: 107.01, wardCode: 'DN-TBO' },
];

export { DONG_NAI_BBOX };
