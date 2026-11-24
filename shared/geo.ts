import { DONG_NAI_BBOX } from './constants';
import { DONG_NAI_WARDS } from './dongNaiWards';
import type { Ward } from './types';

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
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= DONG_NAI_BBOX.latMin &&
    lat <= DONG_NAI_BBOX.latMax &&
    lng >= DONG_NAI_BBOX.lngMin &&
    lng <= DONG_NAI_BBOX.lngMax
  );
}

/** Trục đường huyết mạch (đa tuyến xấp xỉ) dùng để chấm điểm rủi ro không gian. */
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
      [10.954, 107.01], [10.938, 107.14], [10.93, 107.24],
    ],
  },
  { name: 'Quốc lộ 51', points: [[10.91, 106.88], [10.86, 106.93], [10.81, 106.95], [10.76, 106.96]] },
  { name: 'Quốc lộ 20', points: [[10.938, 107.14], [11.02, 107.2], [11.13, 107.3], [11.2, 107.35], [11.32, 107.47]] },
  { name: 'Cách Mạng Tháng Tám', points: [[10.956, 106.81], [10.95, 106.8243], [10.94, 106.82]] },
  { name: 'Đồng Khởi', points: [[10.94, 106.82], [10.942, 106.87], [10.95, 106.89]] },
  { name: 'Võ Thị Sáu', points: [[10.961, 106.815], [10.948, 106.835], [10.935, 106.85]] },
  { name: 'Phạm Văn Thuận', points: [[10.954, 106.83], [10.95, 106.856]] },
  { name: 'Bùi Văn Hòa', points: [[10.922, 106.848], [10.905, 106.88], [10.89, 106.9]] },
];

/** Khoảng cách từ điểm tới đoạn thẳng (mét) – xấp xỉ phẳng cục bộ, đủ chính xác cho đô thị. */
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

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return '***';
  return `${digits.slice(0, 3)}****${digits.slice(-3)}`;
}

export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/[\s.\-()]/g, '');
  if (d.startsWith('+84')) d = `0${d.slice(3)}`;
  else if (d.startsWith('84') && d.length === 11) d = `0${d.slice(2)}`;
  return /^0\d{9}$/.test(d) ? d : null;
}
