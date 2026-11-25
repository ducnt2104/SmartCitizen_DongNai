import { inDongNaiBBox, matchArterial, nearestWard, resolveAdminUnit } from '../shared/geo';
import { matchWardByAddressText } from '../shared/dongNaiWards';
import type { ReverseGeocodeResult } from '../shared/types';
import { LruCache } from '../utils/lru';

interface ExtractedAddressParts {
  houseNumber?: string;
  road?: string;
  poi?: string;
  neighborhood?: string;
  rawAdminText: string;
}

function cleanPart(raw?: string | null): string {
  if (!raw) return '';
  return raw.replace(/\s+/g, ' ').trim();
}

function formatDetailedDongNaiAddress(params: {
  lat: number;
  lng: number;
  parts: ExtractedAddressParts;
}): ReverseGeocodeResult {
  const { lat, lng, parts } = params;
  const house = cleanPart(parts.houseNumber);
  const road = cleanPart(parts.road);
  const poi = cleanPart(parts.poi);
  const neighborhood = cleanPart(parts.neighborhood);

  const arterial = matchArterial(lat, lng, 120);
  const arterialRoadLabel = arterial
    ? /^(quốc lộ|đt|tỉnh lộ|cao tốc|đường)/i.test(arterial.name)
      ? arterial.name
      : `Đường ${arterial.name}`
    : '';
  const effectiveRoad = road || arterialRoadLabel;

  let streetSegment = [house, effectiveRoad].filter(Boolean).join(' ').trim();
  if (poi && (!streetSegment || !streetSegment.toLowerCase().includes(poi.toLowerCase()))) {
    streetSegment = streetSegment ? `${poi}, ${streetSegment}` : poi;
  }

  const baseResolved = resolveAdminUnit({
    lat,
    lng,
    street: streetSegment,
    rawAddressText: parts.rawAdminText,
  });

  if (!baseResolved.inBounds) {
    return baseResolved;
  }

  const aliasHit = parts.rawAdminText ? matchWardByAddressText(parts.rawAdminText, { lat, lng }) : null;
  const ward = aliasHit?.ward ?? nearestWard(lat, lng);
  const wardNameLower = ward.name.toLowerCase();
  const shortWardLower = ward.shortName.toLowerCase();

  // Tránh lặp tên Phường/Xã trong trường Khu phố/Ấp
  const validNeighborhood =
    neighborhood &&
    !neighborhood.toLowerCase().includes(wardNameLower) &&
    neighborhood.toLowerCase() !== shortWardLower &&
    (!streetSegment || !streetSegment.toLowerCase().includes(neighborhood.toLowerCase()))
      ? neighborhood
      : '';

  const fullSegments = [
    streetSegment,
    validNeighborhood,
    ward.name,
    'Thành phố Đồng Nai',
  ].filter(Boolean);

  return {
    inBounds: true,
    address: fullSegments.join(', '),
    wardCode: ward.wardCode,
    wardName: ward.name,
    source: aliasHit ? 'osm_alias' : streetSegment || validNeighborhood ? 'osm_nearest' : baseResolved.source,
    needsConfirmation: !aliasHit,
    matchedAlias: aliasHit?.matchedAlias ?? null,
    arterial: matchArterial(lat, lng),
  };
}

async function fetchJsonWithTimeout<T>(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        ...headers,
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function queryNominatim(fetchImpl: typeof fetch, lat: number, lng: number): Promise<ExtractedAddressParts | null> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=vi&lat=${lat.toFixed(6)}&lon=${lng.toFixed(6)}`;
  const json = await fetchJsonWithTimeout<{
    name?: string;
    display_name?: string;
    address?: Record<string, string>;
  }>(fetchImpl, url, 3200, {
    'User-Agent': 'SmartCitizen-DongNai/2.0 (CivicTech-DongNai)',
  });
  if (!json || (!json.address && !json.display_name)) return null;

  const a = json.address ?? {};
  const houseNumber = a.house_number;
  const road = a.road || a.pedestrian || a.residential || a.living_street || a.path || a.footway || a.cycleway;
  const neighborhood = a.quarter || a.neighbourhood || a.hamlet || a.allotments || a.suburb;
  const poiCandidate = cleanPart(json.name || a.amenity || a.building || a.shop || a.office || a.tourism);
  const poi =
    poiCandidate &&
    poiCandidate.toLowerCase() !== cleanPart(road).toLowerCase() &&
    poiCandidate.toLowerCase() !== cleanPart(neighborhood).toLowerCase()
      ? poiCandidate
      : undefined;

  const rawAdminText = [
    a.quarter,
    a.neighbourhood,
    a.suburb,
    a.village,
    a.town,
    a.city_district,
    a.district,
    a.county,
    a.city,
    json.display_name,
  ]
    .filter(Boolean)
    .join(', ');

  return { houseNumber, road, poi, neighborhood, rawAdminText };
}

async function queryPhoton(fetchImpl: typeof fetch, lat: number, lng: number): Promise<ExtractedAddressParts | null> {
  const url = `https://photon.komoot.io/reverse?lon=${lng.toFixed(6)}&lat=${lat.toFixed(6)}&lang=vi`;
  const json = await fetchJsonWithTimeout<{
    features?: Array<{
      properties?: {
        name?: string;
        housenumber?: string;
        street?: string;
        locality?: string;
        district?: string;
        city?: string;
        county?: string;
        state?: string;
      };
    }>;
  }>(fetchImpl, url, 2800);
  const p = json?.features?.[0]?.properties;
  if (!p) return null;

  const road = p.street;
  const poi = p.name && p.name !== road ? p.name : undefined;
  const rawAdminText = [p.locality, p.district, p.city, p.county, p.state].filter(Boolean).join(', ');
  if (!road && !poi && !rawAdminText) return null;

  return {
    houseNumber: p.housenumber,
    road,
    poi,
    neighborhood: p.locality,
    rawAdminText,
  };
}

async function queryBigDataCloud(fetchImpl: typeof fetch, lat: number, lng: number): Promise<ExtractedAddressParts | null> {
  const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat.toFixed(6)}&longitude=${lng.toFixed(6)}&localityLanguage=vi`;
  const json = await fetchJsonWithTimeout<{
    locality?: string;
    city?: string;
    principalSubdivision?: string;
    localityInfo?: {
      administrative?: Array<{ name?: string; order?: number }>;
      informative?: Array<{ name?: string }>;
    };
  }>(fetchImpl, url, 2800);
  if (!json) return null;

  const adminNames = (json.localityInfo?.administrative ?? []).map((x) => x.name).filter(Boolean);
  const infoNames = (json.localityInfo?.informative ?? []).map((x) => x.name).filter(Boolean);
  const rawAdminText = [json.locality, json.city, ...adminNames, ...infoNames, json.principalSubdivision]
    .filter(Boolean)
    .join(', ');
  if (!rawAdminText) return null;

  return {
    neighborhood: json.locality,
    rawAdminText,
  };
}

async function queryGoogleGeocodingIfConfigured(
  fetchImpl: typeof fetch,
  lat: number,
  lng: number,
): Promise<ExtractedAddressParts | null> {
  const key = (process.env.GOOGLE_GEOCODING_API_KEY ?? process.env.VITE_GOOGLE_MAPS_API_KEY ?? '').trim();
  if (!key || !key.startsWith('AIza')) return null;

  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat.toFixed(6)},${lng.toFixed(6)}&language=vi&key=${encodeURIComponent(key)}`;
  const json = await fetchJsonWithTimeout<{
    status?: string;
    results?: Array<{
      formatted_address?: string;
      address_components?: Array<{ long_name: string; types: string[] }>;
    }>;
  }>(fetchImpl, url, 2800);
  if (!json || json.status !== 'OK' || !json.results?.length) return null;

  const first = json.results[0];
  const comps = first.address_components ?? [];
  const findComp = (...types: string[]): string | undefined =>
    comps.find((c) => types.some((t) => c.types.includes(t)))?.long_name;

  const houseNumber = findComp('street_number', 'subpremise');
  const road = findComp('route');
  const poi = findComp('premise', 'point_of_interest', 'establishment');
  const neighborhood = findComp('neighborhood', 'sublocality_level_2', 'sublocality_level_1');
  const rawAdminText = [
    ...json.results.slice(0, 3).map((r) => r.formatted_address),
    ...comps.map((c) => c.long_name),
  ]
    .filter(Boolean)
    .join(', ');

  return { houseNumber, road, poi, neighborhood, rawAdminText };
}

/**
 * Bộ máy Reverse Geocoding Đa Tầng cho toàn Thành phố Đồng Nai (95 Phường/Xã):
 * - Cache LRU tốc độ cao theo tọa độ làm tròn 5 chữ số thập phân (~1.1 mét) trong 24 giờ.
 * - Tầng 1: Kiểm tra khung địa giới TP. Đồng Nai (`inDongNaiBBox`).
 * - Tầng 2: Kết hợp Nominatim OpenStreetMap (`zoom=18&addressdetails=1&accept-language=vi`) + Photon / BigDataCloud (+ Google Geocoding nếu có key hợp lệ).
 * - Tầng 3: Trích xuất & ghép địa chỉ cụ thể nhất: `Số nhà + Tên đường, Khu phố/Ấp, Phường/Xã (chuẩn 95 ĐVHC), Thành phố Đồng Nai`.
 */
export class MultiTierGeocodeService {
  private readonly cache = new LruCache<string, ReverseGeocodeResult>(5000, 24 * 3600 * 1000);

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  makeCacheKey(lat: number, lng: number): string {
    return `${lat.toFixed(5)},${lng.toFixed(5)}`;
  }

  async reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult> {
    if (!inDongNaiBBox(lat, lng)) {
      return resolveAdminUnit({ lat, lng });
    }

    const cacheKey = this.makeCacheKey(lat, lng);
    const hit = this.cache.get(cacheKey);
    if (hit) return hit;

    // 1. Ưu tiên Google Geocoding nếu có key hợp lệ, hoặc Nominatim OSM zoom=18 chi tiết
    let parts = await queryGoogleGeocodingIfConfigured(this.fetchImpl, lat, lng);
    if (!parts) {
      parts = await queryNominatim(this.fetchImpl, lat, lng);
    }

    // 2. Nếu Nominatim bị giới hạn hoặc thiếu tên đường/số nhà, bổ sung từ Photon + BigDataCloud
    if (!parts || (!parts.road && !parts.poi)) {
      const [photonParts, bdcParts] = await Promise.all([
        queryPhoton(this.fetchImpl, lat, lng),
        parts ? Promise.resolve(null) : queryBigDataCloud(this.fetchImpl, lat, lng),
      ]);
      if (photonParts || bdcParts) {
        parts = {
          houseNumber: parts?.houseNumber || photonParts?.houseNumber,
          road: parts?.road || photonParts?.road,
          poi: parts?.poi || photonParts?.poi,
          neighborhood: parts?.neighborhood || photonParts?.neighborhood || bdcParts?.neighborhood,
          rawAdminText: [parts?.rawAdminText, photonParts?.rawAdminText, bdcParts?.rawAdminText]
            .filter(Boolean)
            .join(', '),
        };
      }
    }

    const result = parts
      ? formatDetailedDongNaiAddress({ lat, lng, parts })
      : formatDetailedDongNaiAddress({ lat, lng, parts: { rawAdminText: '' } });

    this.cache.set(cacheKey, result);
    return result;
  }
}

export const multiTierGeocode = new MultiTierGeocodeService();
