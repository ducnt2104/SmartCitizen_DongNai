import { DONG_NAI_BBOX } from './constants';
import { DONG_NAI_WARDS, matchWardByAddressText } from './dongNaiWards';
import type { ReverseGeocodeResult, Ward } from './types';

const R = 6371000;
const toRad = (d: number): number => (d * Math.PI) / 180;

/** Khoảng cách Haversine (mét). */
export function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

export function inDongNaiBBox(lat: number, lng: number): boolean {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < DONG_NAI_BBOX.latMin ||
    lat > DONG_NAI_BBOX.latMax ||
    lng < DONG_NAI_BBOX.lngMin ||
    lng > DONG_NAI_BBOX.lngMax
  ) {
    return false;
  }
  // Loại trừ góc Tây Nam (TP.HCM & phía Nam Bình Dương cũ) nằm ngoài ranh giới thực của TP. Đồng Nai
  if (lat < 11.12 && lng < 106.74) return false;
  return true;
}

/** Trục đường huyết mạch toàn Thành phố Đồng Nai (bao gồm cả trục Bắc Đồng Nai QL13/QL14/ĐT741). */
export interface ArterialRoad {
  name: string;
  points: ReadonlyArray<readonly [lat: number, lng: number]>;
}

export const ARTERIAL_ROADS: readonly ArterialRoad[] = [
  { name: 'Nguyễn Ái Quốc', points: [[10.954, 106.804], [10.9465, 106.8243], [10.942, 106.842], [10.939, 106.86]] },
  {
    name: 'Quốc lộ 1A',
    points: [
      [10.953, 106.78], [10.948, 106.81], [10.9455, 106.826], [10.942, 106.87], [10.95, 106.93],
      [10.954, 107.01], [10.938, 107.14], [10.93, 107.24], [10.924, 107.405], [10.885, 107.508],
    ],
  },
  { name: 'Quốc lộ 51', points: [[10.91, 106.88], [10.86, 106.93], [10.79, 106.95], [10.715, 107.035]] },
  { name: 'Quốc lộ 20', points: [[10.938, 107.14], [11.032, 107.175], [11.148, 107.252], [11.202, 107.352], [11.275, 107.432], [11.318, 107.482]] },
  { name: 'Quốc lộ 13', points: [[11.425, 106.625], [11.558, 106.615], [11.648, 106.605], [11.842, 106.592], [11.965, 106.545]] },
  { name: 'Quốc lộ 14', points: [[11.425, 106.625], [11.535, 106.896], [11.568, 107.015], [11.678, 107.175], [11.768, 107.235], [11.825, 107.305]] },
  { name: 'ĐT 741', points: [[11.46, 106.925], [11.535, 106.896], [11.675, 106.885], [11.816, 106.968], [11.848, 106.992]] },
  { name: 'Cách Mạng Tháng Tám', points: [[10.956, 106.81], [10.95, 106.8243], [10.94, 106.82]] },
  { name: 'Đồng Khởi', points: [[10.94, 106.82], [10.942, 106.87], [10.95, 106.89]] },
  { name: 'Võ Thị Sáu', points: [[10.961, 106.815], [10.948, 106.835], [10.935, 106.85]] },
  { name: 'Phạm Văn Thuận', points: [[10.954, 106.83], [10.95, 106.856]] },
  { name: 'Bùi Văn Hòa', points: [[10.922, 106.848], [10.905, 106.88], [10.88, 106.905]] },
];

/** Khoảng cách từ điểm tới đoạn thẳng (mét) – xấp xỉ phẳng cục bộ. */
function distanceToSegmentMeters(
  pLat: number, pLng: number, aLat: number, aLng: number, bLat: number, bLng: number,
): number {
  const kx = Math.cos(toRad(pLat)) * 111320;
  const ky = 110574;
  const ax = (aLng - pLng) * kx, ay = (aLat - pLat) * ky;
  const bx = (bLng - pLng) * kx, by = (bLat - pLat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

export interface ArterialMatch {
  name: string;
  distanceM: number;
}

/** Trả về trục huyết mạch gần nhất trong ngưỡng (mặc định 60m), hoặc null. */
export function matchArterial(lat: number, lng: number, thresholdM = 60): ArterialMatch | null {
  let best: ArterialMatch | null = null;
  for (const road of ARTERIAL_ROADS) {
    for (let i = 0; i < road.points.length - 1; i++) {
      const [aLat, aLng] = road.points[i];
      const [bLat, bLng] = road.points[i + 1];
      const d = distanceToSegmentMeters(lat, lng, aLat, aLng, bLat, bLng);
      if (d <= thresholdM && (!best || d < best.distanceM)) best = { name: road.name, distanceM: d };
    }
  }
  return best;
}

export function nearestWard(lat: number, lng: number): Ward {
  let best = DONG_NAI_WARDS[0];
  let bestD = Infinity;
  for (const w of DONG_NAI_WARDS) {
    const d = haversineMeters(lat, lng, w.centerLat, w.centerLng);
    if (d < bestD) {
      bestD = d;
      best = w;
    }
  }
  return best;
}

/**
 * Bộ giải địa giới 3 tầng chuẩn 2 cấp (Thành phố Đồng Nai -> 95 Phường/Xã):
 *  - Tầng 1: Kiểm tra Bounding Box toàn Thành phố Đồng Nai (ngoài biên giới -> báo rõ, không gán bừa).
 *  - Tầng 2: Nếu có chuỗi địa chỉ OSM/Nominatim -> quy đổi qua legacyAliases 2 thế hệ (3 cấp cũ & 10 xã lên phường 30/04/2026).
 *  - Tầng 3: Fallback Nearest Centroid Haversine + bật `needsConfirmation: true`.
 */
export function resolveAdminUnit(input: {
  lat: number;
  lng: number;
  street?: string;
  rawAddressText?: string;
}): ReverseGeocodeResult {
  if (!inDongNaiBBox(input.lat, input.lng)) {
    return {
      inBounds: false,
      address: 'Vị trí ngoài địa giới Thành phố Đồng Nai',
      wardCode: null,
      wardName: null,
      source: 'out_of_bounds',
      needsConfirmation: true,
      matchedAlias: null,
      arterial: null,
    };
  }

  const arterial = matchArterial(input.lat, input.lng);
  const street = input.street?.trim() || '';

  if (input.rawAddressText && input.rawAddressText.trim()) {
    const aliasHit = matchWardByAddressText(input.rawAddressText);
    if (aliasHit) {
      const parts = [street, aliasHit.ward.name, 'Thành phố Đồng Nai'].filter(Boolean);
      return {
        inBounds: true,
        address: parts.join(', '),
        wardCode: aliasHit.ward.wardCode,
        wardName: aliasHit.ward.name,
        source: 'osm_alias',
        needsConfirmation: false,
        matchedAlias: aliasHit.matchedAlias,
        arterial,
      };
    }
    const near = nearestWard(input.lat, input.lng);
    const parts = [street, near.name, 'Thành phố Đồng Nai'].filter(Boolean);
    return {
      inBounds: true,
      address: parts.join(', '),
      wardCode: near.wardCode,
      wardName: near.name,
      source: 'osm_nearest',
      needsConfirmation: true,
      matchedAlias: null,
      arterial,
    };
  }

  const near = nearestWard(input.lat, input.lng);
  const parts = [street, near.name, 'Thành phố Đồng Nai'].filter(Boolean);
  return {
    inBounds: true,
    address: parts.join(', '),
    wardCode: near.wardCode,
    wardName: near.name,
    source: 'local_fallback',
    needsConfirmation: true,
    matchedAlias: null,
    arterial,
  };
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return '***';
  return `${digits.slice(0, 3)}****${digits.slice(-3)}`;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}***@${domain}`;
}

export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/[\s.\-()]/g, '');
  if (d.startsWith('+84')) d = `0${d.slice(3)}`;
  else if (d.startsWith('84') && d.length === 11) d = `0${d.slice(2)}`;
  return /^0\d{9}$/.test(d) ? d : null;
}

export function normalizeEmail(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s : null;
}
