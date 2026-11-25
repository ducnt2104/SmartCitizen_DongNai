import { DONG_NAI_CITY_BOUNDS } from './constants';

/**
 * Khung bao lãnh thổ đất liền & hải đảo gần bờ Việt Nam để phát hiện nhanh lỗi đảo trục `[lat, lng]` <-> `[lng, lat]`.
 * - Vĩ độ Việt Nam (`lat`): ~8.0°N .. 24.0°N
 * - Kinh độ Việt Nam (`lng`): ~102.0°E .. 110.0°E (không giao nhau với [8..24] -> phát hiện đảo ngược chính xác 100%!)
 */
export const VIETNAM_GEO_BOUNDS = {
  latMin: 8.0,
  latMax: 24.0,
  lngMin: 102.0,
  lngMax: 110.0,
} as const;

/**
 * Tâm mặc định thông minh tại Phường Trấn Biên (Trung tâm hành chính TP. Đồng Nai)
 * khi thiết bị chặn hoàn toàn quyền GPS, kèm nhắc người dùng kéo ghim tinh chỉnh.
 */
export const TRAN_BIEN_FALLBACK_COORDS = {
  lat: 10.9465,
  lng: 106.8235,
  wardCode: 'DN-TB',
  wardName: 'Phường Trấn Biên',
} as const;

export interface GeoJsonPoint {
  type: 'Point';
  /** Chuẩn GeoJSON quốc tế RFC 7946: [longitude, latitude] */
  coordinates: [number, number];
}

export type CoordinateErrorReason =
  | 'invalid_input'
  | 'nan_or_infinite'
  | 'zero_island'
  | 'out_of_world_bounds'
  | 'out_of_vietnam';

export type NormalizedCoordinatesResult =
  | {
      ok: true;
      /** Frontend & Google Maps chuẩn: Vĩ độ (8..24 tại VN) */
      lat: number;
      /** Frontend & Google Maps chuẩn: Kinh độ (102..110 tại VN) */
      lng: number;
      /** Chuẩn GeoJSON: { type: 'Point', coordinates: [lng, lat] } */
      geoJson: GeoJsonPoint;
      /** True nếu đầu vào bị đảo ngược [lng, lat] và đã được tự động sửa lại */
      swapped: boolean;
      inVietnam: boolean;
      inDongNai: boolean;
    }
  | {
      ok: false;
      reason: CoordinateErrorReason;
      message: string;
    };

export interface NormalizeCoordinatesOptions {
  /**
   * Thứ tự kỳ vọng khi truyền mảng 2 phần tử `[a, b]`:
   * - `'lat_lng'` (mặc định cho UI): `[lat, lng]`
   * - `'lng_lat'` (cho dữ liệu đọc từ GeoJSON): `[lng, lat]`
   */
  tupleOrder?: 'lat_lng' | 'lng_lat';
  /** Tự động hoán vị nếu phát hiện bị truyền ngược `[lng, lat]` trong phạm vi Việt Nam (mặc định `true`). */
  autoFixSwapped?: boolean;
  /** Bắt buộc tọa độ phải nằm trong phạm vi Việt Nam (`lat` 8–24, `lng` 102–110) (mặc định `true`). */
  requireVietnam?: boolean;
}

export type RawCoordinateInput =
  | { lat: unknown; lng: unknown }
  | { latitude: unknown; longitude: unknown }
  | { type?: unknown; coordinates: unknown }
  | readonly [unknown, unknown]
  | unknown;

function isInVietnamLatLng(lat: number, lng: number): boolean {
  return (
    lat >= VIETNAM_GEO_BOUNDS.latMin &&
    lat <= VIETNAM_GEO_BOUNDS.latMax &&
    lng >= VIETNAM_GEO_BOUNDS.lngMin &&
    lng <= VIETNAM_GEO_BOUNDS.lngMax
  );
}

function isInDongNaiLatLng(lat: number, lng: number): boolean {
  if (
    lat < DONG_NAI_CITY_BOUNDS.latMin ||
    lat > DONG_NAI_CITY_BOUNDS.latMax ||
    lng < DONG_NAI_CITY_BOUNDS.lngMin ||
    lng > DONG_NAI_CITY_BOUNDS.lngMax
  ) {
    return false;
  }
  if (lat < 11.12 && lng < 106.74) return false;
  return true;
}

function toFiniteNumber(val: unknown): number | null {
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  if (typeof val === 'string' && val.trim() !== '') {
    const n = Number(val.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Chuẩn hóa hệ tọa độ thống nhất toàn dự án (`client/` + `server/`):
 * - Loại bỏ triệt để `[0, 0]` (Zero Island), `NaN`, `Infinity`, ngoài biên thế giới.
 * - Tự động phát hiện & sửa lỗi đảo ngược `[lat, lng]` vs `[lng, lat]` trong lãnh thổ Việt Nam (`lat` 8–24, `lng` 102–110).
 * - Xuất đồng thời `{ lat, lng }` cho bản đồ và `{ type: 'Point', coordinates: [lng, lat] }` chuẩn GeoJSON.
 */
export function normalizeCoordinates(
  input: RawCoordinateInput,
  options: NormalizeCoordinatesOptions = {},
): NormalizedCoordinatesResult {
  const autoFixSwapped = options.autoFixSwapped ?? true;
  const requireVietnam = options.requireVietnam ?? true;
  const tupleOrder = options.tupleOrder ?? 'lat_lng';

  if (input === null || input === undefined || typeof input !== 'object') {
    return { ok: false, reason: 'invalid_input', message: 'Dữ liệu tọa độ rỗng hoặc không đúng cấu trúc.' };
  }

  let rawLat: unknown;
  let rawLng: unknown;

  if (Array.isArray(input)) {
    if (input.length !== 2) {
      return { ok: false, reason: 'invalid_input', message: 'Mảng tọa độ phải gồm đúng 2 số.' };
    }
    if (tupleOrder === 'lng_lat') {
      rawLng = input[0];
      rawLat = input[1];
    } else {
      rawLat = input[0];
      rawLng = input[1];
    }
  } else if ('coordinates' in input && Array.isArray((input as { coordinates: unknown }).coordinates)) {
    const coords = (input as { coordinates: unknown[] }).coordinates;
    if (coords.length !== 2) {
      return { ok: false, reason: 'invalid_input', message: 'GeoJSON Point coordinates phải gồm đúng [lng, lat].' };
    }
    rawLng = coords[0];
    rawLat = coords[1];
  } else if ('lat' in input && 'lng' in input) {
    rawLat = (input as { lat: unknown }).lat;
    rawLng = (input as { lng: unknown }).lng;
  } else if ('latitude' in input && 'longitude' in input) {
    rawLat = (input as { latitude: unknown }).latitude;
    rawLng = (input as { longitude: unknown }).longitude;
  } else {
    return { ok: false, reason: 'invalid_input', message: 'Không tìm thấy cặp tọa độ { lat, lng } hoặc GeoJSON Point.' };
  }

  const parsedLat = toFiniteNumber(rawLat);
  const parsedLng = toFiniteNumber(rawLng);
  if (parsedLat === null || parsedLng === null) {
    return { ok: false, reason: 'nan_or_infinite', message: 'Tọa độ chứa giá trị NaN hoặc không phải số thực hợp lệ.' };
  }

  // Chặn tuyệt đối lỗi [0, 0] (Zero Island ngoài khơi châu Phi khi GPS chưa khóa vệ tinh)
  if (Math.abs(parsedLat) < 0.0001 && Math.abs(parsedLng) < 0.0001) {
    return { ok: false, reason: 'zero_island', message: 'Tọa độ [0, 0] không hợp lệ (thiết bị chưa khóa được tín hiệu GPS).' };
  }

  let lat = parsedLat;
  let lng = parsedLng;
  let swapped = false;

  // Phát hiện đảo ngược [lat, lng] <-> [lng, lat] dựa trên dải tọa độ Việt Nam không giao nhau ([8..24] vs [102..110])
  if (!isInVietnamLatLng(lat, lng) && isInVietnamLatLng(lng, lat)) {
    if (!autoFixSwapped) {
      return {
        ok: false,
        reason: 'out_of_vietnam',
        message: `Tọa độ bị đảo ngược trục [lat=${lat}, lng=${lng}] (cần truyền lat 8–24, lng 102–110).`,
      };
    }
    lat = parsedLng;
    lng = parsedLat;
    swapped = true;
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return {
      ok: false,
      reason: 'out_of_world_bounds',
      message: `Tọa độ vượt ngoài phạm vi trái đất (lat=${lat}, lng=${lng}).`,
    };
  }

  const inVietnam = isInVietnamLatLng(lat, lng);
  if (requireVietnam && !inVietnam) {
    return {
      ok: false,
      reason: 'out_of_vietnam',
      message: `Tọa độ (${lat.toFixed(5)}, ${lng.toFixed(5)}) nằm ngoài lãnh thổ Việt Nam (lat 8–24, lng 102–110).`,
    };
  }

  const roundedLat = Math.round(lat * 1e7) / 1e7;
  const roundedLng = Math.round(lng * 1e7) / 1e7;

  return {
    ok: true,
    lat: roundedLat,
    lng: roundedLng,
    geoJson: {
      type: 'Point',
      coordinates: [roundedLng, roundedLat],
    },
    swapped,
    inVietnam,
    inDongNai: isInDongNaiLatLng(roundedLat, roundedLng),
  };
}

/** Chuyển `{ lat, lng }` chuẩn sang MongoDB GeoJSON Point `{ type: 'Point', coordinates: [lng, lat] }` có kiểm tra biên chặt chẽ. */
export function toGeoJsonPoint(lat: number, lng: number, opts?: NormalizeCoordinatesOptions): GeoJsonPoint {
  const norm = normalizeCoordinates({ lat, lng }, opts);
  if (!norm.ok) {
    throw new Error(norm.message);
  }
  return norm.geoJson;
}

/** Đọc an toàn MongoDB GeoJSON Point `{ type: 'Point', coordinates: [lng, lat] }` về `{ lat, lng }` cho Frontend. */
export function fromGeoJsonPoint(
  point: { type?: string; coordinates?: readonly number[] } | null | undefined,
): { lat: number; lng: number } | null {
  if (!point || !Array.isArray(point.coordinates) || point.coordinates.length !== 2) return null;
  const norm = normalizeCoordinates({ type: 'Point', coordinates: point.coordinates });
  return norm.ok ? { lat: norm.lat, lng: norm.lng } : null;
}
