import { DONG_NAI_BBOX } from '@shared/constants';
import { normalizeCoordinates, TRAN_BIEN_FALLBACK_COORDS } from '@shared/coordinates';
import { DONG_NAI_WARDS, normalizeVi, searchWards, WARD_BY_CODE } from '@shared/dongNaiWards';
import { haversineMeters, inDongNaiBBox, resolveAdminUnit } from '@shared/geo';
import type { ReverseGeocodeResult } from '@shared/types';
import { api } from './api';
import { DONG_NAI_GOOGLE_BOUNDS, isGoogleMapsHealthy } from './mapConfig';

const LEGACY_ADMIN_SEGMENT_NORMS: ReadonlySet<string> = (() => {
  const s = new Set<string>([
    'dong nai',
    'thanh pho dong nai',
    'tp dong nai',
    'tinh dong nai',
    'binh phuoc',
    'tinh binh phuoc',
    'viet nam',
    'vietnam',
    'bien hoa',
    'tp bien hoa',
    'thanh pho bien hoa',
    'long khanh',
    'tp long khanh',
    'thanh pho long khanh',
    'dong xoai',
    'tp dong xoai',
    'thanh pho dong xoai',
    'huyen trang bom',
    'huyen long thanh',
    'huyen nhon trach',
    'huyen vinh cuu',
    'huyen thong nhat',
    'huyen cam my',
    'huyen xuan loc',
    'huyen dinh quan',
    'huyen tan phu',
    'thi xa chon thanh',
    'thi xa binh long',
    'thi xa phuoc long',
    'huyen hon quan',
    'huyen loc ninh',
    'huyen bu dop',
    'huyen bu gia map',
    'huyen phu rieng',
    'huyen dong phu',
    'huyen bu dang',
  ]);
  for (const w of DONG_NAI_WARDS) {
    s.add(normalizeVi(w.name));
    s.add(normalizeVi(w.shortName));
    for (const alias of w.legacyAliases) {
      const a = normalizeVi(alias);
      if (a) s.add(a);
      s.add(`phuong ${a}`);
      s.add(`xa ${a}`);
      s.add(`thi tran ${a}`);
    }
  }
  return s;
})();

function isLegacyOrRedundantAdminSegment(seg: string, wardName?: string | null): boolean {
  const clean = seg.trim();
  if (!clean) return true;
  if (/^\d{5,6}$/.test(clean)) return true;
  if (/^(?:huyện|thị xã|thị trấn|tỉnh|tp\.?|thành phố)\s+/i.test(clean)) return true;
  const n = normalizeVi(clean);
  if (!n) return true;
  if (wardName && (n === normalizeVi(wardName) || n === normalizeVi(wardName.replace(/^(phường|xã)\s+/i, '')))) {
    return true;
  }
  return LEGACY_ADMIN_SEGMENT_NORMS.has(n);
}

function formatModernSublabel(
  trailingParts: string[],
  mainLabel: string,
  wardCode?: string | null,
): string {
  const wardLabel = wardCode ? WARD_BY_CODE[wardCode]?.name : undefined;
  const mainNorm = normalizeVi(mainLabel);
  const kept = trailingParts
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => {
      const pn = normalizeVi(p);
      if (!pn || pn === mainNorm) return false;
      return !isLegacyOrRedundantAdminSegment(p, wardLabel);
    });
  const contextPart = kept.slice(0, 1).join(', ');
  return [contextPart, wardLabel, 'TP. Đồng Nai'].filter(Boolean).join(' · ');
}

export interface GpsFix {
  lat: number;
  lng: number;
  accuracy: number;
  tier?: 1 | 2;
}

export interface DrivingRouteResult {
  distanceKm: number;
  durationMin: number;
  path: Array<{ lat: number; lng: number }>;
  source: 'osrm' | 'geodesic';
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

/**
 * Chiến lược lấy GPS 2 tầng (Không bao giờ treo hay timeout trong nhà):
 * - Tầng 1: `getCurrentPosition({ enableHighAccuracy: true, timeout: 6000, maximumAge: 15000 })`
 * - Tầng 2 (Fallback tự động khi trong nhà / yếu sóng): `getCurrentPosition({ enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 })`
 * - Chuẩn hóa qua `normalizeCoordinates` chống `[0, 0]`, `NaN` và đảo ngược tọa độ.
 */
export async function getGps(): Promise<GpsFix> {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    throw new GpsError('unsupported', 'Thiết bị không hỗ trợ định vị');
  }

  const attempt = (opts: PositionOptions, tier: 1 | 2): Promise<{ fix?: GpsFix; err?: GpsError }> =>
    new Promise((resolve) => {
      let settled = false;
      const guard = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ err: new GpsError('timeout', 'Hết thời gian chờ tín hiệu GPS') });
      }, (opts.timeout ?? 7000) + 500);

      navigator.geolocation.getCurrentPosition(
        (p) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(guard);
          const norm = normalizeCoordinates(
            { lat: p.coords.latitude, lng: p.coords.longitude },
            { requireVietnam: false },
          );
          if (!norm.ok) {
            resolve({ err: new GpsError('unavailable', norm.message) });
            return;
          }
          resolve({
            fix: {
              lat: norm.lat,
              lng: norm.lng,
              accuracy: Math.max(1, Math.round(p.coords.accuracy || (tier === 1 ? 15 : 85))),
              tier,
            },
          });
        },
        (e) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(guard);
          resolve({
            err: new GpsError(
              e.code === e.PERMISSION_DENIED ? 'denied' : e.code === e.TIMEOUT ? 'timeout' : 'unavailable',
              e.message,
            ),
          });
        },
        opts,
      );
    });

  const t1 = await attempt({ enableHighAccuracy: true, timeout: 6000, maximumAge: 0 }, 1);
  if (t1.fix) return t1.fix;
  if (t1.err?.kind === 'denied') throw t1.err;

  const t2 = await attempt({ enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }, 2);
  if (t2.fix) return t2.fix;
  throw t2.err ?? t1.err ?? new GpsError('unavailable', 'Không lấy được vị trí GPS');
}

/**
 * Tìm tuyến đường lái xe thực tế cho Đội Cứu Hộ (OSRM Driving API miễn phí + Fallback đường thẳng đô thị 0% lỗi).
 */
export async function fetchDrivingRoute(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  signal?: AbortSignal,
): Promise<DrivingRouteResult> {
  const straightM = haversineMeters(origin.lat, origin.lng, destination.lat, destination.lng);
  const fallbackKm = Math.max(0.1, Math.round(((straightM * 1.28) / 1000) * 100) / 100);
  const fallbackMin = Math.max(2, Math.round((fallbackKm / 38) * 60 + 1));
  const fallback: DrivingRouteResult = {
    distanceKm: fallbackKm,
    durationMin: fallbackMin,
    path: [origin, destination],
    source: 'geodesic',
  };

  if (typeof navigator !== 'undefined' && !navigator.onLine) return fallback;

  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 4500);
  signal?.addEventListener('abort', () => ctrl.abort());
  try {
    const coordsStr = `${origin.lng.toFixed(6)},${origin.lat.toFixed(6)};${destination.lng.toFixed(6)},${destination.lat.toFixed(6)}`;
    const url = `https://router.project-osrm.org/route/v1/driving/${coordsStr}?overview=full&geometries=geojson`;
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) return fallback;
    const json = (await res.json()) as {
      code?: string;
      routes?: Array<{
        distance?: number;
        duration?: number;
        geometry?: { coordinates?: Array<[number, number]> };
      }>;
    };
    const r0 = json.routes?.[0];
    const coords = r0?.geometry?.coordinates;
    if (!r0 || !coords || coords.length < 2) return fallback;
    return {
      distanceKm: Math.max(0.1, Math.round(((r0.distance ?? straightM) / 1000) * 100) / 100),
      durationMin: Math.max(1, Math.round((r0.duration ?? fallbackMin * 60) / 60)),
      path: coords.map(([lng, lat]) => ({ lat, lng })),
      source: 'osrm',
    };
  } catch {
    return fallback;
  } finally {
    window.clearTimeout(timer);
  }
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

/** Reverse Geocode qua ArcGIS World Geocoder (CORS-enabled, chi tiết tới số nhà, con hẻm, POI). */
async function arcgisReverseGeocode(
  lat: number,
  lng: number,
  signal?: AbortSignal,
): Promise<ReverseGeocodeResult | null> {
  if (signal?.aborted) return null;
  try {
    const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?f=json&location=${encodeURIComponent(`${lng.toFixed(6)},${lat.toFixed(6)}`)}&langCode=vi`;
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      address?: {
        Match_addr?: string;
        LongLabel?: string;
        ShortLabel?: string;
        PlaceName?: string;
        AddNum?: string;
        Address?: string;
        Neighborhood?: string;
        District?: string;
        City?: string;
        Subregion?: string;
        Region?: string;
      };
    };
    const a = json.address;
    if (!a) return null;

    const addrLine = (a.Address ?? '').trim();
    const numLine = (a.AddNum ?? '').trim();
    const street = addrLine && numLine && !addrLine.startsWith(numLine) ? `${numLine} ${addrLine}` : addrLine || (a.PlaceName ?? '').trim();
    const rawText = [a.LongLabel, a.Neighborhood, a.District, a.City, a.Subregion, a.Region].filter(Boolean).join(', ');
    const normalized = resolveAdminUnit({ lat, lng, street, rawAddressText: rawText });

    if (normalized.inBounds && normalized.wardName) {
      const poi = (a.PlaceName ?? '').trim();
      const headPart =
        poi && street && !street.toLowerCase().includes(poi.toLowerCase())
          ? `${poi}, ${street}`
          : street || poi || (a.ShortLabel ?? '').trim();
      return {
        ...normalized,
        address: headPart ? `${headPart}, ${normalized.wardName}, Thành phố Đồng Nai` : `${normalized.wardName}, Thành phố Đồng Nai`,
      };
    }
    return normalized;
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}

/** Reverse Geocode qua Photon OSM (lấy nhiều feature gần nhất để trích xuất đủ POI + số nhà + tên đường + locality). */
async function photonReverseGeocode(
  lat: number,
  lng: number,
  signal?: AbortSignal,
): Promise<ReverseGeocodeResult | null> {
  if (signal?.aborted) return null;
  try {
    const url = `https://photon.komoot.io/reverse?lat=${encodeURIComponent(lat.toFixed(6))}&lon=${encodeURIComponent(lng.toFixed(6))}&limit=3`;
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      features?: Array<{
        properties?: {
          osm_key?: string;
          housenumber?: string;
          street?: string;
          name?: string;
          locality?: string;
          district?: string;
          suburb?: string;
          county?: string;
          city?: string;
          state?: string;
        };
      }>;
    };
    const feats = json.features ?? [];
    if (feats.length === 0) return null;

    let housenumber = '';
    let street = '';
    let poi = '';
    const rawParts: string[] = [];

    for (const f of feats) {
      const pr = f.properties;
      if (!pr) continue;
      if (!housenumber && pr.housenumber) housenumber = pr.housenumber.trim();
      if (!street) {
        if (pr.street?.trim()) street = pr.street.trim();
        else if (pr.osm_key === 'highway' && pr.name?.trim()) street = pr.name.trim();
      }
      if (!poi && pr.osm_key !== 'highway' && pr.osm_key !== 'boundary' && pr.name?.trim()) {
        poi = pr.name.trim();
      }
      for (const adminField of [pr.locality, pr.district, pr.suburb, pr.county, pr.city, pr.state]) {
        if (adminField?.trim()) rawParts.push(adminField.trim());
      }
    }

    const streetLine = [housenumber, street].filter(Boolean).join(' ').trim();
    const headPart =
      poi && streetLine && !streetLine.toLowerCase().includes(poi.toLowerCase())
        ? `${poi}, ${streetLine}`
        : streetLine || poi;
    const rawText = [poi, streetLine, ...rawParts].filter(Boolean).join(', ');
    const normalized = resolveAdminUnit({ lat, lng, street: streetLine || poi, rawAddressText: rawText });

    if (normalized.inBounds && normalized.wardName && headPart) {
      return {
        ...normalized,
        address: `${headPart}, ${normalized.wardName}, Thành phố Đồng Nai`,
      };
    }
    return normalized;
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}

function hasStreetLevelDetail(r: ReverseGeocodeResult | null): boolean {
  if (!r || r.needsConfirmation || r.source === 'local_fallback') return false;
  const parts = r.address
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 3) return false;
  return !r.wardName || parts[0].toLowerCase() !== r.wardName.toLowerCase();
}

/**
 * Reverse Geocoding đa tầng có AbortController:
 *  - Tầng 1: Kiểm tra khung bao toàn Thành phố Đồng Nai (ngoài biên giới -> báo rõ).
 *  - Tầng 2A: Google Maps Geocoder chính chủ (nếu đã nạp Google Maps) -> chuẩn hóa về 95 Phường/Xã.
 *  - Tầng 2B: Backend `/api/geo/reverse` (cache LRU ~11m + Nominatim 4s + chuẩn hóa 2 thế hệ về 95 Phường/Xã).
 *  - Tầng 2C: ArcGIS World Geocoder + Photon OSM song song (ưu tiên kết quả có số nhà/tên đường/hẻm/POI cụ thể).
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

  let apiHit: ReverseGeocodeResult | null = null;
  try {
    const resp = await api<ReverseGeocodeResult>(
      `/api/geo/reverse?lat=${encodeURIComponent(lat.toFixed(6))}&lng=${encodeURIComponent(lng.toFixed(6))}`,
      { signal, timeoutMs: 4500 },
    );
    if (resp && resp.source !== 'local_fallback') {
      apiHit = resp;
      if (hasStreetLevelDetail(resp)) return resp;
    }
  } catch (err) {
    if (signal?.aborted) throw err;
  }

  const [arcRes, photonRes] = await Promise.allSettled([
    arcgisReverseGeocode(lat, lng, signal),
    photonReverseGeocode(lat, lng, signal),
  ]);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const arcHit = arcRes.status === 'fulfilled' ? arcRes.value : null;
  const photonHit = photonRes.status === 'fulfilled' ? photonRes.value : null;

  if (hasStreetLevelDetail(arcHit) && arcHit) return arcHit;
  if (hasStreetLevelDetail(photonHit) && photonHit) return photonHit;
  return apiHit ?? arcHit ?? photonHit ?? fallback;
}

async function searchArcGisPlaces(q: string, signal?: AbortSignal): Promise<PlaceSuggestion[]> {
  try {
    const extent = `${DONG_NAI_BBOX.lngMin},${DONG_NAI_BBOX.latMin},${DONG_NAI_BBOX.lngMax},${DONG_NAI_BBOX.latMax}`;
    const singleLine = q.toLowerCase().includes('đồng nai') || q.toLowerCase().includes('dong nai') ? q : `${q}, Đồng Nai`;
    const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json&SingleLine=${encodeURIComponent(singleLine)}&countryCode=VNM&searchExtent=${extent}&locationType=rooftop&maxLocations=6&langCode=vi`;
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      candidates?: Array<{
        address?: string;
        location?: { x: number; y: number };
        score?: number;
      }>;
    };
    const out: PlaceSuggestion[] = [];
    const seen = new Set<string>();
    for (const c of json.candidates ?? []) {
      if (typeof c.score === 'number' && c.score < 58) continue;
      const lat = c.location?.y;
      const lng = c.location?.x;
      if (typeof lat !== 'number' || typeof lng !== 'number' || !inDongNaiBBox(lat, lng)) continue;
      const addr = (c.address ?? '').trim();
      if (!addr) continue;
      const key = `${addr}:${lat.toFixed(4)}:${lng.toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const resolved = resolveAdminUnit({ lat, lng, rawAddressText: addr });
      const parts = addr.split(',').map((s) => s.trim());
      const mainLabel = parts[0] || addr;
      out.push({
        id: `arc:${out.length}:${lat.toFixed(5)}:${lng.toFixed(5)}`,
        label: mainLabel,
        sublabel: formatModernSublabel(parts.slice(1), mainLabel, resolved.wardCode),
        kind: 'place',
        lat,
        lng,
        wardCode: resolved.wardCode ?? undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function searchPhotonPlaces(q: string, signal?: AbortSignal): Promise<PlaceSuggestion[]> {
  try {
    const bbox = `${DONG_NAI_BBOX.lngMin},${DONG_NAI_BBOX.latMin},${DONG_NAI_BBOX.lngMax},${DONG_NAI_BBOX.latMax}`;
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&bbox=${bbox}&lat=11.05&lon=106.95`;
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      features?: Array<{
        geometry?: { coordinates?: [number, number] };
        properties?: {
          osm_id?: number;
          name?: string;
          housenumber?: string;
          street?: string;
          locality?: string;
          district?: string;
          county?: string;
          city?: string;
          state?: string;
        };
      }>;
    };
    const out: PlaceSuggestion[] = [];
    for (const f of json.features ?? []) {
      const coords = f.geometry?.coordinates;
      if (!coords || coords.length < 2) continue;
      const [lng, lat] = coords;
      if (!inDongNaiBBox(lat, lng)) continue;
      const pr = f.properties ?? {};
      const streetLine = [pr.housenumber, pr.street].filter(Boolean).join(' ').trim();
      const raw = [pr.name, streetLine, pr.locality, pr.district, pr.county, pr.city, pr.state].filter(Boolean).join(', ');
      const resolved = resolveAdminUnit({ lat, lng, street: streetLine || pr.name, rawAddressText: raw });
      const mainLabel = pr.name?.trim() || streetLine || raw;
      out.push({
        id: `photon:${pr.osm_id ?? out.length}:${lat.toFixed(5)}`,
        label: mainLabel,
        sublabel: formatModernSublabel(streetLine && streetLine !== mainLabel ? [streetLine] : [], mainLabel, resolved.wardCode),
        kind: 'place',
        lat,
        lng,
        wardCode: resolved.wardCode ?? undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Tìm kiếm thông minh Địa chỉ / Con hẻm / 95 Phường Xã mới nhất trong Thành phố Đồng Nai:
 *  - Khớp tức thì 0ms với 95 Phường/Xã hiện hành (hiển thị tên đơn vị mới).
 *  - Khi trực tuyến: gọi song song ArcGIS Rooftop + Photon BBox + Google Places + Nominatim.
 */
export async function searchPlacesDongNai(query: string, signal?: AbortSignal): Promise<PlaceSuggestion[]> {
  const q = query.trim();
  if (!q) return [];

  const wardMatches: PlaceSuggestion[] = searchWards(q, 5).map((w) => ({
    id: `ward:${w.wardCode}`,
    label: w.name,
    sublabel: `${w.kind} · Khu vực ${w.zone} · TP. Đồng Nai`,
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
      if (places.length > 0) return [...wardMatches, ...places];
    } catch {
      // Tự động rơi xuống ArcGIS / Photon / Nominatim bên dưới
    }
  }

  // 2) Chạy song song ArcGIS World Geocoder + Photon OSM để tìm nhanh số nhà, đường, hẻm và POI
  const [arcMatches, photonMatches] = await Promise.all([
    searchArcGisPlaces(q, signal),
    searchPhotonPlaces(q, signal),
  ]);
  if (signal?.aborted) return wardMatches;

  const mergedPlaces: PlaceSuggestion[] = [...arcMatches];
  for (const ph of photonMatches) {
    const isDuplicate = mergedPlaces.some((existing) => {
      if (existing.label.trim().toLowerCase() === ph.label.trim().toLowerCase()) return true;
      if (
        typeof existing.lat === 'number' &&
        typeof existing.lng === 'number' &&
        typeof ph.lat === 'number' &&
        typeof ph.lng === 'number'
      ) {
        return haversineMeters(existing.lat, existing.lng, ph.lat, ph.lng) < 60;
      }
      return false;
    });
    if (!isDuplicate) mergedPlaces.push(ph);
  }
  if (mergedPlaces.length > 0) {
    return [...wardMatches, ...mergedPlaces.slice(0, 8)];
  }

  // 4) Fallback OSM Nominatim
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
      osmPlaces.push({
        id: `osm:${r.place_id}`,
        label: mainLabel,
        sublabel: formatModernSublabel(parts.slice(1), mainLabel, resolved.wardCode),
        kind: 'place',
        lat,
        lng,
        wardCode: resolved.wardCode ?? undefined,
      });
    }
    return [...wardMatches, ...osmPlaces];
  } catch {
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
  { name: 'Phường Trấn Biên (Trung tâm)', lat: TRAN_BIEN_FALLBACK_COORDS.lat, lng: TRAN_BIEN_FALLBACK_COORDS.lng, wardCode: 'DN-TB' },
  { name: 'Phường Long Thành (Sân bay)', lat: 10.7782, lng: 106.9462, wardCode: 'DN-LTH' },
  { name: 'Phường Nhơn Trạch (Cảng)', lat: 10.7458, lng: 106.9474, wardCode: 'DN-NTR' },
  { name: 'Phường Trảng Bom', lat: 10.9526, lng: 107.0104, wardCode: 'DN-TBO' },
  { name: 'Phường Long Khánh', lat: 10.9336, lng: 107.2627, wardCode: 'DN-LKH' },
  { name: 'Phường Xuân Lộc', lat: 10.9336, lng: 107.4074, wardCode: 'DN-XLO' },
  { name: 'Xã Tà Lài (Cát Tiên)', lat: 11.3626, lng: 107.3655, wardCode: 'DN-TLA' },
  { name: 'Phường Bình Phước (Đồng Xoài)', lat: 11.5350, lng: 106.8832, wardCode: 'DN-BP' },
  { name: 'Phường Chơn Thành', lat: 11.4282, lng: 106.6354, wardCode: 'DN-CTH' },
  { name: 'Phường Lộc Ninh', lat: 11.8448, lng: 106.5907, wardCode: 'DN-LNI' },
];

export { DONG_NAI_BBOX };
