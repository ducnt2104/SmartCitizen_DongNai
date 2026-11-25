import { DONG_NAI_BBOX } from '@shared/constants';
import { searchWards, WARD_BY_CODE } from '@shared/dongNaiWards';
import { inDongNaiBBox, resolveAdminUnit } from '@shared/geo';
import type { ReverseGeocodeResult } from '@shared/types';
import { api } from './api';
import { DONG_NAI_GOOGLE_BOUNDS, isGoogleMapsHealthy } from './mapConfig';

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

export interface PlaceSuggestion {
  id: string;
  label: string;
  sublabel: string;
  kind: 'ward' | 'place';
  lat?: number;
  lng?: number;
  wardCode?: string;
  placeId?: string;
  upgradedOn2026?: boolean;
}

/** Lấy mẫu GPS chính xác bằng `watchPosition` (chọn mẫu sai số tốt nhất trong 4s, dừng ngay khi accuracy <= 18m). */
export function getGps(timeoutMs = 12000): Promise<GpsFix> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      return reject(new GpsError('unsupported', 'Thiết bị không hỗ trợ định vị'));
    }
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
        const f: GpsFix = {
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracy: Math.max(1, Math.round(p.coords.accuracy)),
        };
        if (!best || f.accuracy < best.accuracy) best = f;
        if (f.accuracy <= 18) {
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

function hasLoadedGoogleGeocoder(): boolean {
  return (
    isGoogleMapsHealthy() &&
    typeof window !== 'undefined' &&
    Boolean((window as Window & { google?: typeof google }).google?.maps?.Geocoder)
  );
}

/** Reverse Geocode qua Google Maps Geocoder chính chủ rồi chuẩn hóa về 1 trong 95 Phường/Xã của TP. Đồng Nai. */
async function googleReverseGeocode(
  lat: number,
  lng: number,
  signal?: AbortSignal,
): Promise<ReverseGeocodeResult | null> {
  if (!hasLoadedGoogleGeocoder() || signal?.aborted) return null;
  try {
    const geocoder = new google.maps.Geocoder();
    const res = await geocoder.geocode({
      location: { lat, lng },
      language: 'vi',
      region: 'VN',
    });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const first = res.results?.[0];
    if (!first) return null;

    const comps = first.address_components ?? [];
    const findComp = (...types: string[]): string =>
      comps.find((c) => types.some((t) => c.types.includes(t)))?.long_name ?? '';

    const streetNum = findComp('street_number', 'premise', 'subpremise');
    const route = findComp('route');
    const street = [streetNum, route].filter(Boolean).join(' ').trim();
    const allText = [
      ...res.results.slice(0, 3).map((r) => r.formatted_address),
      ...comps.map((c) => c.long_name),
    ]
      .filter(Boolean)
      .join(', ');

    const normalized = resolveAdminUnit({ lat, lng, street, rawAddressText: allText });
    // Giữ chi tiết hẻm/số nhà của Google nhưng kết thúc bằng tên Phường/Xã chuẩn 2 cấp của TP. Đồng Nai
    if (normalized.inBounds && normalized.wardName) {
      const cleanFormatted = first.formatted_address
        .replace(/,?\s*Việt Nam$/i, '')
        .replace(/,?\s*Vietnam$/i, '')
        .trim();
      const headPart = street || cleanFormatted.split(',')[0]?.trim() || '';
      const niceAddress = headPart
        ? `${headPart}, ${normalized.wardName}, Thành phố Đồng Nai`
        : `${normalized.wardName}, Thành phố Đồng Nai`;
      return {
        ...normalized,
        address: niceAddress,
      };
    }
    return normalized;
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}

/**
 * Reverse Geocoding đa tầng có AbortController:
 *  - Tầng 1: Kiểm tra khung bao toàn Thành phố Đồng Nai (ngoài biên giới -> báo rõ).
 *  - Tầng 2A: Google Maps Geocoder chính chủ (nếu đã nạp Google Maps) -> chuẩn hóa về 95 Phường/Xã.
 *  - Tầng 2B: Backend `/api/geo/reverse` (cache LRU ~11m + Nominatim 4s + chuẩn hóa 2 thế hệ về 95 Phường/Xã).
 *  - Tầng 3: Fallback Nearest Centroid Haversine cục bộ (`needsConfirmation: true`).
 */
export async function reverseGeocode(lat: number, lng: number, signal?: AbortSignal): Promise<ReverseGeocodeResult> {
  if (!inDongNaiBBox(lat, lng)) {
    return resolveAdminUnit({ lat, lng });
  }
  const fallback = resolveAdminUnit({ lat, lng });
  if (typeof navigator !== 'undefined' && !navigator.onLine) return fallback;

  const googleHit = await googleReverseGeocode(lat, lng, signal);
  if (googleHit) return googleHit;

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

/**
 * Tìm kiếm thông minh Địa chỉ / Con hẻm / 95 Phường Xã ưu tiên trong Bounding Box Thành phố Đồng Nai:
 *  - Khớp tức thì 0ms với 95 Phường/Xã (không dấu + bí danh cũ trước 01/07/2025 & 30/04/2026).
 *  - Khi trực tuyến: gọi Google Places Autocomplete (nếu có key) hoặc OSM Nominatim giới hạn trong `DONG_NAI_CITY_BOUNDS`.
 */
export async function searchPlacesDongNai(query: string, signal?: AbortSignal): Promise<PlaceSuggestion[]> {
  const q = query.trim();
  if (!q) return [];

  const wardMatches: PlaceSuggestion[] = searchWards(q, 5).map((w) => ({
    id: `ward:${w.wardCode}`,
    label: w.name,
    sublabel:
      w.legacyAliases.length > 0
        ? `TP. Đồng Nai · Gồm: ${w.legacyAliases.slice(0, 3).join(', ')}`
        : `${w.zone} · Thành phố Đồng Nai`,
    kind: 'ward',
    lat: w.centerLat,
    lng: w.centerLng,
    wardCode: w.wardCode,
    upgradedOn2026: w.upgradedOn2026,
  }));

  if (q.length < 3 || (typeof navigator !== 'undefined' && !navigator.onLine)) {
    return wardMatches;
  }

  // 1) Google Places Autocomplete (ưu tiên tọa độ trong DONG_NAI_GOOGLE_BOUNDS)
  if (
    isGoogleMapsHealthy() &&
    typeof window !== 'undefined' &&
    Boolean((window as Window & { google?: typeof google }).google?.maps?.places?.AutocompleteService)
  ) {
    try {
      const svc = new google.maps.places.AutocompleteService();
      const resp = await svc.getPlacePredictions({
        input: q.toLowerCase().includes('đồng nai') || q.toLowerCase().includes('dong nai') ? q : `${q}, Đồng Nai`,
        componentRestrictions: { country: 'vn' },
        locationRestriction: DONG_NAI_GOOGLE_BOUNDS,
        language: 'vi',
      });
      if (signal?.aborted) return wardMatches;
      const places: PlaceSuggestion[] = (resp.predictions ?? []).slice(0, 5).map((p) => ({
        id: `gplace:${p.place_id}`,
        label: p.structured_formatting?.main_text ?? p.description,
        sublabel: p.structured_formatting?.secondary_text ?? 'Thành phố Đồng Nai',
        kind: 'place',
        placeId: p.place_id,
      }));
      return [...wardMatches, ...places];
    } catch {
      // Tự động rơi xuống Nominatim bên dưới nếu Places API chưa bật trên Google Cloud
    }
  }

  // 2) Fallback tìm kiếm địa chỉ chi tiết qua Nominatim giới hạn chặt trong khung bao TP. Đồng Nai
  try {
    const viewbox = `${DONG_NAI_BBOX.lngMin},${DONG_NAI_BBOX.latMax},${DONG_NAI_BBOX.lngMax},${DONG_NAI_BBOX.latMin}`;
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=vn&bounded=1&viewbox=${viewbox}&accept-language=vi&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!res.ok) return wardMatches;
    const rows = (await res.json()) as Array<{
      place_id: number;
      lat: string;
      lon: string;
      name?: string;
      display_name: string;
    }>;
    const osmPlaces: PlaceSuggestion[] = [];
    for (const r of rows) {
      const lat = Number(r.lat);
      const lng = Number(r.lon);
      if (!inDongNaiBBox(lat, lng)) continue;
      const resolved = resolveAdminUnit({ lat, lng, rawAddressText: r.display_name });
      const parts = r.display_name.split(',').map((s) => s.trim());
      const mainLabel = r.name?.trim() || parts[0] || r.display_name;
      const wardLabel = resolved.wardCode ? WARD_BY_CODE[resolved.wardCode]?.name : undefined;
      osmPlaces.push({
        id: `osm:${r.place_id}`,
        label: mainLabel,
        sublabel: [parts[1], wardLabel, 'TP. Đồng Nai'].filter(Boolean).join(' · '),
        kind: 'place',
        lat,
        lng,
        wardCode: resolved.wardCode ?? undefined,
      });
    }
    return [...wardMatches, ...osmPlaces];
  } catch (err) {
    if (signal?.aborted) return wardMatches;
    return wardMatches;
  }
}

/** Phân giải `placeId` của Google Places thành tọa độ thực (lat, lng) + mã Phường/Xã. */
export async function resolvePlaceSuggestion(
  item: PlaceSuggestion,
): Promise<{ lat: number; lng: number; wardCode?: string; label: string } | null> {
  if (typeof item.lat === 'number' && typeof item.lng === 'number') {
    return { lat: item.lat, lng: item.lng, wardCode: item.wardCode, label: item.label };
  }
  if (item.placeId && hasLoadedGoogleGeocoder()) {
    try {
      const geocoder = new google.maps.Geocoder();
      const res = await geocoder.geocode({ placeId: item.placeId, language: 'vi', region: 'VN' });
      const first = res.results?.[0];
      if (!first?.geometry?.location) return null;
      const lat = first.geometry.location.lat();
      const lng = first.geometry.location.lng();
      const unit = resolveAdminUnit({ lat, lng, rawAddressText: first.formatted_address });
      return {
        lat,
        lng,
        wardCode: unit.wardCode ?? undefined,
        label: item.label,
      };
    } catch {
      return null;
    }
  }
  return null;
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
