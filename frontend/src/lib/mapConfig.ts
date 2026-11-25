import { useSyncExternalStore } from 'react';
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';
import { DONG_NAI_CITY_BOUNDS, DONG_NAI_CITY_CENTER } from '@shared/constants';
import { DONG_NAI_WARDS } from '@shared/dongNaiWards';
import type { Category, Priority, ReportStatus } from '@shared/types';
import { DONG_NAI_REAL_BOUNDARY_POLYGON } from '../data/dongNaiBoundary';

export type MapMode = 'pins' | 'heat';
/** 3 chế độ hiển thị chuẩn: Đường phố sạch (roadmap), Vệ tinh + Tên đường (hybrid), Địa hình / Tối (dark) */
export type MapSurfaceStyle = 'roadmap' | 'hybrid' | 'dark';

/** Kiểu điểm tối thiểu cho bản đồ (hỗ trợ cả ReportSummary siêu nhẹ lẫn ClientReport đầy đủ). */
export interface MapPoint {
  id: string;
  title: string;
  category: Category;
  severity: number;
  isEmergency: boolean;
  emergencyLevel: 0 | 1;
  priority: Priority;
  status: ReportStatus;
  lat: number;
  lng: number;
  clusterCount: number;
  wardCode?: string;
  code?: string;
}

export interface MapBbox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export type PinPriorityState = 'emergency' | 'high' | 'open' | 'resolved';

export const PIN_STATE_COLOR: Record<PinPriorityState, string> = {
  emergency: '#E11D48', // Rose-600
  high: '#D97706', // Amber-600
  open: '#0B57D0', // Civic Blue
  resolved: '#059669', // Emerald-600
};

export const PIN_STATE_RANK: Record<PinPriorityState, number> = {
  resolved: 1,
  open: 2,
  high: 3,
  emergency: 4,
};

const CAT_SVG_MARKUP: Record<Category, string> = {
  rac_thai:
    '<path d="M12.5 12h9m-7.5 0 .6 8h5.8l.6-8m-5.5-2h4" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  den_duong:
    '<path d="M17 10.5a4 4 0 0 0-2.2 7.3V19h4.4v-1.2a4 4 0 0 0-2.2-7.3Zm-1.5 10.5h3" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  ngap_nuoc:
    '<path d="M17 10.5s-4 4.5-4 7a4 4 0 0 0 8 0c0-2.5-4-7-4-7Z" stroke="#fff" stroke-width="1.8" stroke-linejoin="round" fill="none"/>',
  mat_duong:
    '<path d="m17 10.5 5 9H12l5-9Zm0 3.5v2.5m0 1.8h.01" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  khac:
    '<circle cx="17" cy="15.5" r="5" stroke="#fff" stroke-width="1.8" fill="none"/><circle cx="17" cy="15.5" r="1.5" fill="#fff"/>',
};

export function getPinState(r: MapPoint): PinPriorityState {
  if (r.status === 'resolved') return 'resolved';
  if (r.emergencyLevel === 1 || r.priority === 'emergency' || r.isEmergency) return 'emergency';
  if (r.priority === 'high' || r.clusterCount >= 3 || r.severity >= 4) return 'high';
  return 'open';
}

/** Tạo phần tử DOM ghim SVG sắc nét dùng chung cho cả Google AdvancedMarker và MapLibre Marker (an toàn XSS). */
export function createIncidentPinElement(
  r: MapPoint,
  onActivate?: () => void,
  isDestination = false,
): HTMLButtonElement {
  const state = getPinState(r);
  const color = isDestination ? '#E11D48' : PIN_STATE_COLOR[state];
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = isDestination ? 'sc-map-pin sc-map-pin-dest group' : 'sc-map-pin group';
  btn.setAttribute('aria-label', r.title);
  btn.title = r.title;

  const pulse = isDestination
    ? '<span class="sc-dest-pin-pulse" aria-hidden="true"></span><span class="sc-dest-pin-pulse sc-dest-pin-pulse-delay" aria-hidden="true"></span>'
    : state === 'emergency'
      ? '<span class="sc-map-pin-pulse" aria-hidden="true"></span>'
      : '';
  const badge =
    r.clusterCount > 1
      ? `<span class="sc-map-pin-badge" aria-hidden="true">${Math.min(99, r.clusterCount)}</span>`
      : '';
  const svgW = isDestination ? 42 : 36;
  const svgH = isDestination ? 50 : 44;

  btn.innerHTML = `${pulse}${badge}<svg viewBox="0 0 34 42" width="${svgW}" height="${svgH}" aria-hidden="true" class="sc-map-pin-svg"><path d="M17 1C8.7 1 2 7.5 2 15.8 2 27 17 41 17 41s15-14 15-25.2C32 7.5 25.3 1 17 1Z" fill="${color}" stroke="#ffffff" stroke-width="2.4"/>${CAT_SVG_MARKUP[r.category]}</svg>`;

  if (onActivate) {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onActivate();
    });
  }
  return btn;
}

/** Tạo phần tử DOM cụm gom nhóm (Cluster) tô màu theo mức độ khẩn cấp cao nhất bên trong cụm. */
export function createClusterElement(count: number, highest: PinPriorityState, onActivate?: () => void): HTMLButtonElement {
  const size = count >= 50 ? 48 : count >= 10 ? 42 : 36;
  const color = PIN_STATE_COLOR[highest];
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sc-cluster';
  btn.style.width = `${size}px`;
  btn.style.height = `${size}px`;
  btn.style.background = color;
  btn.setAttribute('aria-label', `${count} phản ánh`);

  const span = document.createElement('span');
  span.textContent = count > 999 ? '999+' : String(count);
  btn.appendChild(span);

  if (onActivate) {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onActivate();
    });
  }
  return btn;
}

/** Đa giác xấp xỉ hình tròn theo mét thực địa trên mặt cầu (vẽ GPS ±m Accuracy & Radius cho WebGL). */
export function createGeoJsonCircle(
  lat: number,
  lng: number,
  radiusMeters: number,
  steps = 56,
): GeoJSON.Feature<GeoJSON.Polygon> {
  const coords: Array<[number, number]> = [];
  const dLat = radiusMeters / 110574;
  const dLng = radiusMeters / (111320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * Math.PI * 2;
    coords.push([lng + dLng * Math.cos(theta), lat + dLat * Math.sin(theta)]);
  }
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [coords],
    },
  };
}

/** Khung bao Google Maps toàn Thành phố Đồng Nai (95 Phường/Xã — Bắc Bình Phước cũ tới Nam Nhơn Trạch & Đông Bắc Cát Tiên). */
export const DONG_NAI_GOOGLE_BOUNDS = {
  south: DONG_NAI_CITY_BOUNDS.latMin,
  north: DONG_NAI_CITY_BOUNDS.latMax,
  west: DONG_NAI_CITY_BOUNDS.lngMin,
  east: DONG_NAI_CITY_BOUNDS.lngMax,
} as const;

/** Khung bao mở rộng nhẹ cho hạn chế kéo pan mượt mà mà không khóa cứng rìa xã biên giới. */
export const DONG_NAI_CAMERA_RESTRICTION = {
  south: DONG_NAI_CITY_BOUNDS.latMin - 0.35,
  north: DONG_NAI_CITY_BOUNDS.latMax + 0.35,
  west: DONG_NAI_CITY_BOUNDS.lngMin - 0.35,
  east: DONG_NAI_CITY_BOUNDS.lngMax + 0.35,
} as const;

export const DONG_NAI_MAPLIBRE_BOUNDS: [[number, number], [number, number]] = [
  [DONG_NAI_CITY_BOUNDS.lngMin, DONG_NAI_CITY_BOUNDS.latMin],
  [DONG_NAI_CITY_BOUNDS.lngMax, DONG_NAI_CITY_BOUNDS.latMax],
];

export const DONG_NAI_DEFAULT_CENTER = {
  lat: DONG_NAI_CITY_CENTER[0],
  lng: DONG_NAI_CITY_CENTER[1],
} as const;

// ── Cấu hình & Giám sát Sức khỏe Google Maps JS API (Zero-Crash Fallback) ──

function readRawApiKey(): string {
  const metaEnv = import.meta.env as Record<string, string | undefined>;
  const raw = (metaEnv.VITE_GOOGLE_MAPS_API_KEY ?? metaEnv.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '').trim();
  if (!raw || raw.length < 24) return '';
  const lower = raw.toLowerCase();
  if (
    lower.includes('your_') ||
    lower.includes('replace_') ||
    lower.includes('example') ||
    lower.startsWith('<')
  ) {
    return '';
  }
  return raw;
}

export const GOOGLE_MAPS_API_KEY = readRawApiKey();
export const GOOGLE_MAPS_MAP_ID =
  ((import.meta.env as Record<string, string | undefined>).VITE_GOOGLE_MAPS_MAP_ID ?? '').trim() || 'SMARTCITIZEN_DN_MAP';

let googleRuntimeFailed = false;
let googleFailureReason: string | null = GOOGLE_MAPS_API_KEY ? null : 'missing_api_key';
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

export function markGoogleMapsFailed(reason: string): void {
  if (googleRuntimeFailed && googleFailureReason === reason) return;
  googleRuntimeFailed = true;
  googleFailureReason = reason;
  notify();
}

export function isGoogleMapsHealthy(): boolean {
  return Boolean(GOOGLE_MAPS_API_KEY) && !googleRuntimeFailed;
}

export function getGoogleMapsFailureReason(): string | null {
  return googleFailureReason;
}

// Bắt sự kiện gm_authFailure chính thức của Google Maps khi sai API key / chưa bật Billing / chặn Referrer domain
if (typeof window !== 'undefined') {
  const win = window as Window & { gm_authFailure?: () => void };
  const prev = win.gm_authFailure;
  win.gm_authFailure = () => {
    markGoogleMapsFailed('gm_auth_failure');
    prev?.();
  };
}

export function useGoogleMapsAvailable(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    isGoogleMapsAvailableSnapshot,
    () => Boolean(GOOGLE_MAPS_API_KEY),
  );
}

function isGoogleMapsAvailableSnapshot(): boolean {
  return Boolean(GOOGLE_MAPS_API_KEY) && !googleRuntimeFailed;
}

/** Liên kết mở đúng tọa độ trên Google Maps để đối chiếu trực tiếp. */
export function googleMapsPlaceUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

/** Liên kết 1-chạm mở ứng dụng Google Maps Dẫn đường trực tiếp tới hiện trường cho Đội Cứu Hộ & Cán bộ. */
export function googleMapsDirectionsUrl(
  destLat: number,
  destLng: number,
  origin?: { lat: number; lng: number } | null,
  travelMode: 'driving' | 'two-wheeler' | 'walking' = 'driving',
): string {
  const dest = `${destLat.toFixed(6)},${destLng.toFixed(6)}`;
  const origParam = origin ? `&origin=${origin.lat.toFixed(6)},${origin.lng.toFixed(6)}` : '';
  return `https://www.google.com/maps/dir/?api=1${origParam}&destination=${dest}&travelmode=${travelMode}`;
}

export const OPENFREEMAP_VECTOR_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
export const OPENFREEMAP_DARK_STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
export const DONG_NAI_GLYPHS_URL = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

/** Đa giác ranh giới thực Thành phố Đồng Nai mới (sáp nhập Đồng Nai + Bình Phước) dùng ẩn nhãn ĐVHC cũ của OSM và vẽ khung hành chính 2 cấp. */
export const DONG_NAI_ADMIN_MASK_POLYGON: GeoJSON.Feature<GeoJSON.Polygon> = DONG_NAI_REAL_BOUNDARY_POLYGON;

const REGIONAL_HUB_CODES = new Set([
  'DN-TB',
  'DN-BH',
  'DN-LTH',
  'DN-NTR',
  'DN-TBO',
  'DN-LKH',
  'DN-XLO',
  'DN-TRA',
  'DN-TPU',
  'DN-BP',
  'DN-CTH',
  'DN-LNI',
  'DN-PLO',
  'DN-BDA',
  'DN-BGM',
]);

/** GeoJSON 95 Phường/Xã mới (33 Phường, 62 Xã) đặt đúng tại vị trí cập nhật để hiển thị trực tiếp lên bản đồ. */
export function buildDongNaiWardsGeoJson(): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: 'FeatureCollection',
    features: DONG_NAI_WARDS.map((w) => ({
      type: 'Feature',
      properties: {
        wardCode: w.wardCode,
        name: w.name,
        shortName: w.shortName,
        kind: w.kind,
        zone: w.zone,
        region: w.region,
        isHub: REGIONAL_HUB_CODES.has(w.wardCode),
      },
      geometry: {
        type: 'Point',
        coordinates: [w.centerLng, w.centerLat],
      },
    })),
  };
}

const LEGACY_OSM_PLACE_LAYERS = new Set([
  'label_state',
  'label_city',
  'label_city_capital',
  'label_town',
  'label_village',
  'label_other',
]);

const cachedVectorStylePromises: Partial<Record<'roadmap' | 'dark', Promise<StyleSpecification | null>>> = {};

function excludeDongNaiLegacyFilter(existing: unknown): unknown {
  const outsideMask: unknown = ['!', ['within', DONG_NAI_ADMIN_MASK_POLYGON]];
  return existing ? ['all', existing, outsideMask] : outsideMask;
}

function tuneRoadmapLayer(layer: LayerSpecification): Record<string, unknown> {
  const next = { ...layer } as Record<string, unknown>;
  const paint = (layer.paint as Record<string, unknown> | undefined) ?? {};
  const id = layer.id;

  if (id === 'background' && layer.type === 'background') {
    next.paint = { ...paint, 'background-color': '#F8FAFC' };
  } else if (id === 'landuse_residential' && layer.type === 'fill') {
    delete next.maxzoom;
    next.paint = { ...paint, 'fill-color': '#F1F5F9', 'fill-opacity': 0.9 };
  } else if ((id === 'landuse_hospital' || id === 'hospital') && layer.type === 'fill') {
    next.paint = { ...paint, 'fill-color': '#FFE4E6' };
  } else if ((id === 'landuse_school' || id === 'landuse_university') && layer.type === 'fill') {
    next.paint = { ...paint, 'fill-color': '#FEF3C7' };
  } else if (
    (id === 'landuse_commercial' || id === 'landuse_industrial' || id === 'aeroway_fill' || id === 'aerodrome') &&
    layer.type === 'fill'
  ) {
    next.paint = { ...paint, 'fill-color': '#EEF2FF' };
  } else if (id === 'aeroway_runway' && layer.type === 'line') {
    next.paint = { ...paint, 'line-color': '#CBD5E1' };
  } else if (
    (id === 'water' || id === 'waterway_river' || id === 'waterway_other' || id === 'water_intermittent') &&
    layer.type === 'fill'
  ) {
    next.paint = { ...paint, 'fill-color': '#93C5FD', 'fill-opacity': 0.92 };
  } else if ((id === 'waterway_river' || id === 'waterway_other') && layer.type === 'line') {
    next.paint = { ...paint, 'line-color': '#7DD3FC' };
  } else if ((id === 'park' || id === 'landuse_park' || id === 'landuse_recreation_ground' || id === 'landuse_stadium') && layer.type === 'fill') {
    next.paint = { ...paint, 'fill-color': '#CBEAD1' };
  } else if (id === 'landcover_grass' && layer.type === 'fill') {
    next.paint = { ...paint, 'fill-color': '#DCF2E0' };
  } else if ((id === 'landcover_wood' || id === 'wood' || id === 'forest') && layer.type === 'fill') {
    next.paint = { ...paint, 'fill-color': '#BBE2C4', 'fill-opacity': 0.65 };
  } else if (id === 'building' && layer.type === 'fill') {
    delete next.maxzoom;
    next.minzoom = 13;
    next.paint = { ...paint, 'fill-color': '#E8EDF5', 'fill-outline-color': '#D5DCE8' };
  } else if (id === 'building-3d' && layer.type === 'fill-extrusion') {
    next.paint = { ...paint, 'fill-extrusion-color': '#E2E8F0', 'fill-extrusion-opacity': 0.52 };
  } else if (id === 'road_path_pedestrian') {
    next.minzoom = 13.2;
    next.paint = { ...paint, 'line-color': '#E2E8F0' };
  } else if (
    id === 'road_motorway' ||
    id === 'bridge_motorway' ||
    id === 'tunnel_motorway' ||
    id === 'road_motorway_link'
  ) {
    next.paint = { ...paint, 'line-color': '#FFB74D' };
  } else if (
    id === 'road_motorway_casing' ||
    id === 'bridge_motorway_casing' ||
    id === 'road_motorway_link_casing'
  ) {
    next.paint = { ...paint, 'line-color': '#F59E0B' };
  } else if (
    id === 'road_trunk_primary' ||
    id === 'bridge_trunk_primary' ||
    id === 'tunnel_trunk_primary' ||
    id === 'road_trunk_primary_link'
  ) {
    next.paint = { ...paint, 'line-color': '#FFE082' };
  } else if (
    id === 'road_trunk_primary_casing' ||
    id === 'bridge_trunk_primary_casing' ||
    id === 'road_trunk_primary_link_casing'
  ) {
    next.paint = { ...paint, 'line-color': '#EAB308' };
  } else if (
    id === 'road_secondary_tertiary' ||
    id === 'bridge_secondary_tertiary' ||
    id === 'tunnel_secondary_tertiary' ||
    id === 'road_minor' ||
    id === 'bridge_street' ||
    id === 'road_service_track' ||
    id === 'road_link'
  ) {
    next.paint = { ...paint, 'line-color': '#FFFFFF' };
  } else if (
    id === 'road_secondary_tertiary_casing' ||
    id === 'bridge_secondary_tertiary_casing' ||
    id === 'road_minor_casing' ||
    id === 'road_service_track_casing' ||
    id === 'road_link_casing'
  ) {
    next.paint = { ...paint, 'line-color': '#CBD5E1' };
  } else if (id === 'highway-name-major') {
    next.minzoom = 10.8;
  } else if (id === 'highway-name-minor') {
    next.minzoom = 12.6;
  } else if (id === 'highway-name-path') {
    next.minzoom = 13.5;
  } else if (id === 'poi_r1') {
    next.minzoom = 12.8;
  } else if (id === 'poi_r7') {
    next.minzoom = 13.8;
  } else if (id === 'poi_r20') {
    next.minzoom = 14.8;
  }
  return next;
}

function cloneAndLocalizeVectorStyle(
  base: StyleSpecification,
  lang: 'vi' | 'en',
  surface: 'roadmap' | 'dark',
): StyleSpecification {
  const nameExpr: unknown =
    lang === 'en'
      ? ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name']]
      : ['coalesce', ['get', 'name:vi'], ['get', 'name'], ['get', 'name:latin']];

  const cleanSources = { ...base.sources } as Record<string, unknown>;
  if (surface === 'roadmap' && 'ne2_shaded' in cleanSources) {
    delete cleanSources.ne2_shaded;
  }

  const mappedLayers: LayerSpecification[] = [];
  let housenumberInserted = false;

  for (const layer of base.layers) {
    const sourceLayer = (layer as { 'source-layer'?: string })['source-layer'];
    const isCountryBorder =
      layer.id === 'boundary_2' || layer.id === 'boundary_country_z0-4' || layer.id === 'boundary_country_z5-';
    if (
      (surface === 'roadmap' && layer.id === 'natural_earth') ||
      layer.id === 'boundary_3' ||
      layer.id === 'boundary_state' ||
      layer.id === 'boundary_county' ||
      (layer.id.startsWith('boundary_') && !isCountryBorder)
    ) {
      continue;
    }

    const next = surface === 'roadmap' ? tuneRoadmapLayer(layer) : ({ ...layer } as Record<string, unknown>);

    // Ẩn nhãn ĐVHC cũ của OSM (Tỉnh Bình Phước, TP. Biên Hòa, Thị trấn..., phường/xã cũ) bên trong Đồng Nai
    // để thay thế bằng lớp 95 Phường/Xã hiện hành định vị chính xác.
    const isCountryLabel = layer.id.includes('country');
    const isLegacyPlaceLayer =
      !isCountryLabel &&
      (LEGACY_OSM_PLACE_LAYERS.has(layer.id) ||
        sourceLayer === 'place' ||
        layer.id.startsWith('place_') ||
        layer.id.startsWith('label_'));
    if (isLegacyPlaceLayer) {
      next.filter = excludeDongNaiLegacyFilter(next.filter);
    }

    if (layer.type === 'symbol') {
      const layout = layer.layout as Record<string, unknown> | undefined;
      const paint = (next.paint as Record<string, unknown> | undefined) ?? {};
      if (layout && 'text-field' in layout && !layer.id.includes('shield') && !JSON.stringify(layout['text-field']).includes('"ref"')) {
        next.layout = { ...layout, 'text-field': nameExpr };
        if (surface === 'roadmap' && 'text-halo-color' in paint) {
          next.paint = {
            ...paint,
            'text-halo-color': 'rgba(255, 255, 255, 0.96)',
            'text-halo-width': Math.max(Number(paint['text-halo-width'] ?? 1.2), 1.8),
          };
        }
      }
    }

    mappedLayers.push(next as unknown as LayerSpecification);

    // Chèn lớp số nhà thật từ openmaptiles (`housenumber`) ngay sau lớp tòa nhà 3D
    if (
      surface === 'roadmap' &&
      !housenumberInserted &&
      'openmaptiles' in cleanSources &&
      layer.id === 'building-3d'
    ) {
      housenumberInserted = true;
      mappedLayers.push({
        id: 'sc-housenumber',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'housenumber',
        minzoom: 15.2,
        layout: {
          'text-field': ['to-string', ['get', 'housenumber']],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 15.2, 9, 19, 11.5],
          'text-allow-overlap': false,
          'text-padding': 4,
        },
        paint: {
          'text-color': '#475569',
          'text-halo-color': 'rgba(255, 255, 255, 0.96)',
          'text-halo-width': 1.5,
        },
      } as unknown as LayerSpecification);
    }
  }

  return {
    ...base,
    glyphs: base.glyphs ?? DONG_NAI_GLYPHS_URL,
    sources: cleanSources as StyleSpecification['sources'],
    layers: mappedLayers,
  };
}

/**
 * Nạp Vector Tile Style chi tiết (đường hẻm, tòa nhà 3D, POI trường/chợ/bệnh viện, tên đường tiếng Việt)
 * tương đương độ chi tiết Google Maps; tự động trả về null để rơi về Esri nếu offline/CSP chặn.
 */
export async function loadDetailedVectorStyle(
  surface: 'roadmap' | 'dark',
  lang: 'vi' | 'en',
  signal?: AbortSignal,
): Promise<StyleSpecification | null> {
  if (typeof fetch === 'undefined') return null;
  const styleUrl = surface === 'dark' ? OPENFREEMAP_DARK_STYLE_URL : OPENFREEMAP_VECTOR_STYLE_URL;
  if (!cachedVectorStylePromises[surface]) {
    const ctrl = new AbortController();
    const timer = typeof window !== 'undefined' ? window.setTimeout(() => ctrl.abort(), 6000) : null;
    cachedVectorStylePromises[surface] = fetch(styleUrl, {
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    })
      .then(async (res) => {
        if (!res.ok) return null;
        const json = (await res.json()) as StyleSpecification;
        if (!json || !Array.isArray(json.layers) || !json.sources) return null;
        return json;
      })
      .catch(() => {
        delete cachedVectorStylePromises[surface];
        return null;
      })
      .finally(() => {
        if (timer !== null) window.clearTimeout(timer);
      });
  }

  const base = await cachedVectorStylePromises[surface];
  if (!base || signal?.aborted) return null;
  return cloneAndLocalizeVectorStyle(base, lang, surface);
}

export function loadDetailedVectorRoadmapStyle(
  lang: 'vi' | 'en',
  signal?: AbortSignal,
): Promise<StyleSpecification | null> {
  return loadDetailedVectorStyle('roadmap', lang, signal);
}

/**
 * Cấu hình Style cho MapLibre GL JS (100% không watermark API key):
 *  - `roadmap`: Esri World Street Map (chi tiết tên đường, hẻm, địa danh, zoom 0-19) — CSP-safe & dự phòng cho Vector.
 *  - `hybrid`: Ảnh vệ tinh Esri World Imagery + Mạng lưới đường Esri World Transportation + Nhãn địa danh Esri.
 *  - `dark`: Esri World Dark Gray Base + Reference cho chế độ tối / IOC (và dự phòng cho Vector Dark).
 */
export function buildMapLibreStyle(surface: MapSurfaceStyle): StyleSpecification {
  if (surface === 'hybrid') {
    return {
      version: 8,
      glyphs: DONG_NAI_GLYPHS_URL,
      sources: {
        'esri-sat': {
          type: 'raster',
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          tileSize: 256,
          maxzoom: 19,
          attribution: '© Esri, Maxar, Earthstar Geographics',
        },
        'esri-transport': {
          type: 'raster',
          tiles: [
            'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
          ],
          tileSize: 256,
          maxzoom: 19,
          attribution: '© Esri',
        },
        'esri-places': {
          type: 'raster',
          tiles: [
            'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
          ],
          tileSize: 256,
          maxzoom: 19,
          attribution: '© Esri',
        },
      },
      layers: [
        { id: 'esri-sat-layer', type: 'raster', source: 'esri-sat', minzoom: 0, maxzoom: 22 },
        { id: 'esri-transport-layer', type: 'raster', source: 'esri-transport', minzoom: 0, maxzoom: 22 },
        // Ẩn lớp nhãn raster ĐVHC cũ của Esri (`esri-places`), thay bằng lớp 95 Phường/Xã mới từ vector GeoJSON
        { id: 'esri-places-layer', type: 'raster', source: 'esri-places', minzoom: 0, maxzoom: 22, paint: { 'raster-opacity': 0 } },
      ],
    };
  }

  if (surface === 'dark') {
    return {
      version: 8,
      glyphs: DONG_NAI_GLYPHS_URL,
      sources: {
        'carto-dark-nolabels': {
          type: 'raster',
          tiles: [
            'https://a.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png',
            'https://b.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png',
            'https://c.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png',
          ],
          tileSize: 256,
          maxzoom: 19,
          attribution: '© OpenStreetMap contributors, © CARTO',
        },
      },
      layers: [{ id: 'carto-dark-layer', type: 'raster', source: 'carto-dark-nolabels', minzoom: 0, maxzoom: 22 }],
    };
  }

  return {
    version: 8,
    glyphs: DONG_NAI_GLYPHS_URL,
    sources: {
      'carto-voyager-nolabels': {
        type: 'raster',
        tiles: [
          'https://a.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}@2x.png',
          'https://b.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}@2x.png',
          'https://c.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}@2x.png',
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© OpenStreetMap contributors, © CARTO',
      },
    },
    layers: [{ id: 'carto-voyager-layer', type: 'raster', source: 'carto-voyager-nolabels', minzoom: 0, maxzoom: 22 }],
  };
}
