import { inDongNaiBBox, resolveAdminUnit } from '../shared/geo';
import type { ReverseGeocodeResult } from '../shared/types';
import { LruCache } from '../utils/lru';

/**
 * Bộ máy Reverse Geocoding 3 tầng cho toàn Thành phố Đồng Nai (95 Phường/Xã):
 *  - Cache theo tọa độ làm tròn 4 chữ số thập phân (~11m) trong 24h tránh spam Nominatim.
 *  - Tầng 1: Kiểm tra DONG_NAI_CITY_BOUNDS (ngoài địa giới -> báo rõ, không gán bừa).
 *  - Tầng 2: Gọi OSM Nominatim (timeout 4s, AbortController) -> chuẩn hóa 2 thế hệ qua `legacyAliases`.
 *  - Tầng 3: Fallback Nearest Centroid Haversine + bật `needsConfirmation: true`.
 */
export class GeoService {
  private readonly cache = new LruCache<string, ReverseGeocodeResult>(2000, 24 * 3600 * 1000);

  async reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult> {
    if (!inDongNaiBBox(lat, lng)) {
      return resolveAdminUnit({ lat, lng });
    }

    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    let result: ReverseGeocodeResult;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=vi&lat=${lat}&lon=${lng}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'SmartCitizen-DongNai/2.0 (CivicTech-DongNai-City)',
          Accept: 'application/json',
        },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        result = resolveAdminUnit({ lat, lng });
      } else {
        const json = (await res.json()) as { address?: Record<string, string>; display_name?: string };
        const a = json.address ?? {};
        const street = [a.house_number, a.road].filter(Boolean).join(' ').trim();
        const rawArea = [
          a.suburb,
          a.quarter,
          a.village,
          a.town,
          a.city_district,
          a.county,
          a.city,
          json.display_name,
        ]
          .filter(Boolean)
          .join(', ');
        result = resolveAdminUnit({ lat, lng, street, rawAddressText: rawArea });
      }
    } catch {
      result = resolveAdminUnit({ lat, lng });
    } finally {
      clearTimeout(timer);
    }

    this.cache.set(key, result);
    return result;
  }
}
