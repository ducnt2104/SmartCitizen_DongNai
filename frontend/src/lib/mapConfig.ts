import { useSyncExternalStore } from 'react';
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';
import { DONG_NAI_CITY_BOUNDS, DONG_NAI_CITY_CENTER } from '@shared/constants';
import { DONG_NAI_WARDS } from '@shared/dongNaiWards';
import type { Category, Priority, ReportStatus } from '@shared/types';
import { DONG_NAI_REAL_BOUNDARY_POLYGON } from '../data/dongNaiBoundary';

export type MapMode = 'pins' | 'heat';
/** 2 chế độ chuẩn Google Maps: Đường phố (roadmap) và Vệ tinh + Đường (hybrid) */
export type MapSurfaceStyle = 'roadmap' | 'hybrid';

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
  zoom?: number;
  centerLat?: number;
  centerLng?: number;
  localHint?: string | null;
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

/** Lớp hành chính cấp tỉnh/thành phố/thị xã/huyện/xã cũ cần ẩn bên trong Đồng Nai để thay bằng 95 ĐVHC mới.
 *  KHÔNG ẩn `label_other` (Khu phố, Ấp, Cù lao, KCN, Tổ dân phố) để giữ độ chi tiết giống Google Maps. */
const LEGACY_OSM_ADMIN_LAYERS = new Set([
  'label_state',
  'label_city',
  'label_city_capital',
  'label_town',
  'label_village',
  'place_state',
  'place_city',
  'place_city_large',
  'place_capital',
  'place_town',
  'place_village',
]);

let cachedVectorStylePromise: Promise<StyleSpecification | null> | null = null;

function excludeDongNaiLegacyFilter(existing: unknown): unknown {
  const outsideMask: unknown = ['!', ['within', DONG_NAI_ADMIN_MASK_POLYGON]];
  return existing ? ['all', existing, outsideMask] : outsideMask;
}

/** Bảng màu POI chuẩn Google Maps theo từng nhóm danh mục (Y tế đỏ, Ẩm thực cam, Mua sắm xanh dương, Công viên xanh lá, Du lịch tím, Khách sạn hồng). */
const GOOGLE_POI_TEXT_COLOR_LIGHT: unknown = [
  'match',
  ['get', 'class'],
  ['hospital', 'clinic', 'doctors', 'dentist', 'pharmacy'],
  '#D93025',
  ['restaurant', 'fast_food', 'cafe', 'bar', 'pub', 'bakery', 'ice_cream', 'biergarten', 'food_court'],
  '#D96B00',
  [
    'shop',
    'supermarket',
    'grocery',
    'mall',
    'marketplace',
    'convenience',
    'department_store',
    'clothing_store',
    'electronics',
    'hardware',
    'car',
    'kiosk',
  ],
  '#1A73E8',
  ['park', 'garden', 'playground', 'pitch', 'stadium', 'golf', 'campsite', 'swimming_pool', 'nature_reserve'],
  '#188038',
  ['attraction', 'museum', 'monument', 'castle', 'theme_park', 'viewpoint', 'gallery', 'theatre', 'cinema', 'zoo', 'aquarium'],
  '#9334E6',
  ['lodging', 'hotel', 'motel', 'hostel', 'guest_house'],
  '#D81B60',
  ['bus', 'railway', 'subway', 'tram', 'ferry', 'airport', 'station'],
  '#1967D2',
  '#475569',
];

const GOOGLE_POI_TEXT_COLOR_DARK: unknown = [
  'match',
  ['get', 'class'],
  ['hospital', 'clinic', 'doctors', 'dentist', 'pharmacy'],
  '#FCA5A5',
  ['restaurant', 'fast_food', 'cafe', 'bar', 'pub', 'bakery', 'ice_cream', 'biergarten', 'food_court'],
  '#FDBA74',
  [
    'shop',
    'supermarket',
    'grocery',
    'mall',
    'marketplace',
    'convenience',
    'department_store',
    'clothing_store',
    'electronics',
    'hardware',
    'car',
    'kiosk',
  ],
  '#93C5FD',
  ['park', 'garden', 'playground', 'pitch', 'stadium', 'golf', 'campsite', 'swimming_pool', 'nature_reserve'],
  '#86EFAC',
  ['attraction', 'museum', 'monument', 'castle', 'theme_park', 'viewpoint', 'gallery', 'theatre', 'cinema', 'zoo', 'aquarium'],
  '#D8B4FE',
  ['lodging', 'hotel', 'motel', 'hostel', 'guest_house'],
  '#F9A8D4',
  ['bus', 'railway', 'subway', 'tram', 'ferry', 'airport', 'station'],
  '#7DD3FC',
  '#CBD5E1',
];

function tuneRoadmapLayer(layer: LayerSpecification): Record<string, unknown> {
  const next = { ...layer } as Record<string, unknown>;
  const paint = (layer.paint as Record<string, unknown> | undefined) ?? {};
  const layout = (layer.layout as Record<string, unknown> | undefined) ?? {};
  const id = layer.id;

  if (id === 'background' && layer.type === 'background') {
    next.paint = { ...paint, 'background-color': '#F2F3F5' };
  } else if (id === 'landuse_residential' && layer.type === 'fill') {
    delete next.maxzoom;
    next.paint = { ...paint, 'fill-color': '#F3F4F6', 'fill-opacity': 0.85 };
  } else if ((id === 'landuse_hospital' || id === 'hospital') && layer.type === 'fill') {
    next.paint = { ...paint, 'fill-color': '#FCE8E6' };
  } else if ((id === 'landuse_school' || id === 'landuse_university') && layer.type === 'fill') {
    next.paint = { ...paint, 'fill-color': '#FEF3D6' };
  } else if (
    (id === 'landuse_commercial' || id === 'landuse_industrial' || id === 'aeroway_fill' || id === 'aerodrome') &&
    layer.type === 'fill'
  ) {
    next.paint = { ...paint, 'fill-color': '#ECEEF2' };
  } else if (id === 'aeroway_runway' && layer.type === 'line') {
    next.paint = { ...paint, 'line-color': '#CBD5E1' };
  } else if (
    (id === 'water' || id === 'waterway_river' || id === 'waterway_other' || id === 'water_intermittent') &&
    layer.type === 'fill'
  ) {
    next.paint = { ...paint, 'fill-color': '#84CBE8', 'fill-opacity': 0.95 };
  } else if ((id === 'waterway_river' || id === 'waterway_other') && layer.type === 'line') {
    next.paint = { ...paint, 'line-color': '#7AC5E4' };
  } else if ((id === 'waterway_line_label' || id === 'water_name_line_label' || id === 'water_name_point_label') && layer.type === 'symbol') {
    next.paint = {
      ...paint,
      'text-color': '#1D5E8A',
      'text-halo-color': 'rgba(255, 255, 255, 0.92)',
      'text-halo-width': 1.6,
    };
  } else if ((id === 'park' || id === 'landuse_park' || id === 'landuse_recreation_ground' || id === 'landuse_stadium' || id === 'landuse_pitch') && layer.type === 'fill') {
    next.paint = { ...paint, 'fill-color': '#C5E8C8' };
  } else if (id === 'park_outline' && layer.type === 'line') {
    next.paint = { ...paint, 'line-color': '#9AD5A1', 'line-opacity': 0.65 };
  } else if (id === 'landcover_grass' && layer.type === 'fill') {
    next.paint = { ...paint, 'fill-color': '#D6F0D8' };
  } else if ((id === 'landcover_wood' || id === 'wood' || id === 'forest') && layer.type === 'fill') {
    next.paint = { ...paint, 'fill-color': '#B6DFB9', 'fill-opacity': 0.72 };
  } else if (id === 'building' && layer.type === 'fill') {
    // Giữ khung tòa nhà sắc nét xuyên suốt từ zoom 13 tới zoom 22 (không bị ẩn sau zoom 14)
    delete next.maxzoom;
    next.minzoom = 13;
    next.paint = {
      ...paint,
      'fill-color': '#E5E7EB',
      'fill-outline-color': '#CBD2DC',
      'fill-opacity': 0.92,
    };
  } else if (id === 'building-3d' && layer.type === 'fill-extrusion') {
    next.minzoom = 15.5;
    next.paint = {
      ...paint,
      'fill-extrusion-color': '#E2E6EC',
      'fill-extrusion-opacity': 0.5,
    };
  } else if (id === 'road_path_pedestrian' || id === 'tunnel_path_pedestrian' || id === 'bridge_path_pedestrian') {
    next.minzoom = 13;
    next.paint = { ...paint, 'line-color': '#E5E9F0' };
  } else if (
    id === 'road_motorway' ||
    id === 'bridge_motorway' ||
    id === 'tunnel_motorway' ||
    id === 'road_motorway_link' ||
    id === 'bridge_motorway_link' ||
    id === 'tunnel_motorway_link'
  ) {
    // Hệ màu đường cao tốc / quốc lộ hiện đại của Google Maps (xanh thép dịu mắt, nổi bật tuyến huyết mạch)
    next.paint = { ...paint, 'line-color': '#7B9BC2' };
  } else if (
    id === 'road_motorway_casing' ||
    id === 'bridge_motorway_casing' ||
    id === 'tunnel_motorway_casing' ||
    id === 'road_motorway_link_casing' ||
    id === 'bridge_motorway_link_casing'
  ) {
    next.paint = { ...paint, 'line-color': '#5A7CA5' };
  } else if (
    id === 'road_trunk_primary' ||
    id === 'bridge_trunk_primary' ||
    id === 'tunnel_trunk_primary' ||
    id === 'road_trunk_primary_link'
  ) {
    next.paint = { ...paint, 'line-color': '#9EB5D0' };
  } else if (
    id === 'road_trunk_primary_casing' ||
    id === 'bridge_trunk_primary_casing' ||
    id === 'tunnel_trunk_primary_casing' ||
    id === 'road_trunk_primary_link_casing'
  ) {
    next.paint = { ...paint, 'line-color': '#7C97B8' };
  } else if (
    id === 'road_secondary_tertiary' ||
    id === 'bridge_secondary_tertiary' ||
    id === 'tunnel_secondary_tertiary' ||
    id === 'road_minor' ||
    id === 'tunnel_minor' ||
    id === 'bridge_street' ||
    id === 'road_service_track' ||
    id === 'tunnel_service_track' ||
    id === 'bridge_service_track' ||
    id === 'road_link' ||
    id === 'tunnel_link' ||
    id === 'bridge_link'
  ) {
    next.paint = { ...paint, 'line-color': '#FFFFFF' };
  } else if (
    id === 'road_secondary_tertiary_casing' ||
    id === 'bridge_secondary_tertiary_casing' ||
    id === 'tunnel_secondary_tertiary_casing' ||
    id === 'road_minor_casing' ||
    id === 'tunnel_street_casing' ||
    id === 'bridge_street_casing' ||
    id === 'road_service_track_casing' ||
    id === 'tunnel_service_track_casing' ||
    id === 'bridge_service_track_casing' ||
    id === 'road_link_casing' ||
    id === 'tunnel_link_casing' ||
    id === 'bridge_link_casing'
  ) {
    next.paint = { ...paint, 'line-color': '#CED6E0' };
  } else if (id === 'highway-name-major') {
    next.minzoom = 10.2;
    next.layout = {
      ...layout,
      'text-size': ['interpolate', ['linear'], ['zoom'], 10.5, 10, 14, 12, 18, 14],
    };
    next.paint = {
      ...paint,
      'text-color': '#3C4043',
      'text-halo-color': 'rgba(255, 255, 255, 0.98)',
      'text-halo-width': 2.2,
    };
  } else if (id === 'highway-name-minor') {
    // Hiển thị sớm tên đường nhánh & con hẻm để phóng to luôn thấy địa chỉ cụ thể
    next.minzoom = 12.2;
    next.layout = {
      ...layout,
      'text-size': ['interpolate', ['linear'], ['zoom'], 12.2, 9.5, 15, 11, 19, 13],
    };
    next.paint = {
      ...paint,
      'text-color': '#4B5563',
      'text-halo-color': 'rgba(255, 255, 255, 0.98)',
      'text-halo-width': 2.0,
    };
  } else if (id === 'highway-name-path') {
    next.minzoom = 13.5;
    next.paint = {
      ...paint,
      'text-color': '#64748B',
      'text-halo-color': 'rgba(255, 255, 255, 0.96)',
      'text-halo-width': 1.8,
    };
  } else if (id === 'highway-shield-non-us') {
    next.minzoom = 8.5;
    next.paint = {
      ...paint,
      'text-color': '#1E3A5F',
      'text-halo-color': 'rgba(255, 255, 255, 0.98)',
      'text-halo-width': 1.6,
    };
  } else if (id === 'poi_r1') {
    next.minzoom = 11.5;
    next.layout = {
      ...layout,
      'text-size': ['interpolate', ['linear'], ['zoom'], 11.5, 10.5, 15, 12, 19, 13.5],
      'text-padding': 3,
    };
    next.paint = {
      ...paint,
      'text-color': GOOGLE_POI_TEXT_COLOR_LIGHT,
      'text-halo-color': 'rgba(255, 255, 255, 0.98)',
      'text-halo-width': 2.0,
    };
  } else if (id === 'poi_r7') {
    next.minzoom = 13.0;
    next.layout = {
      ...layout,
      'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 16, 11.5, 19, 13],
      'text-padding': 2,
    };
    next.paint = {
      ...paint,
      'text-color': GOOGLE_POI_TEXT_COLOR_LIGHT,
      'text-halo-color': 'rgba(255, 255, 255, 0.98)',
      'text-halo-width': 1.8,
    };
  } else if (id === 'poi_r20') {
    next.minzoom = 14.2;
    next.layout = {
      ...layout,
      'text-size': ['interpolate', ['linear'], ['zoom'], 14.2, 9.8, 17, 11.2, 20, 12.8],
      'text-padding': 2,
    };
    next.paint = {
      ...paint,
      'text-color': GOOGLE_POI_TEXT_COLOR_LIGHT,
      'text-halo-color': 'rgba(255, 255, 255, 0.98)',
      'text-halo-width': 1.8,
    };
  } else if (id === 'poi_transit') {
    next.minzoom = 12.8;
    next.paint = {
      ...paint,
      'text-color': '#1967D2',
      'text-halo-color': 'rgba(255, 255, 255, 0.98)',
      'text-halo-width': 1.8,
    };
  } else if (id === 'label_other') {
    // Giữ nhãn Khu phố, Ấp, Cù lao, Khu công nghiệp rõ nét kiểu Google Maps
    next.minzoom = 11.8;
    next.layout = {
      ...layout,
      'text-transform': 'uppercase',
      'text-letter-spacing': 0.04,
      'text-size': ['interpolate', ['linear'], ['zoom'], 12, 9.5, 15, 11.2, 18, 12.2],
    };
    next.paint = {
      ...paint,
      'text-color': '#4B5563',
      'text-halo-color': 'rgba(255, 255, 255, 0.96)',
      'text-halo-width': 2.0,
    };
  } else if (id === 'boundary_3') {
    // Giữ ranh giới các tỉnh/thành phố khác nét đứt tinh tế kiểu Google Maps
    next.paint = {
      ...paint,
      'line-color': '#94A3B8',
      'line-dasharray': [3, 2],
      'line-opacity': 0.72,
    };
  }
  return next;
}

function cloneAndLocalizeVectorStyle(
  base: StyleSpecification,
  lang: 'vi' | 'en',
  surface: MapSurfaceStyle,
): StyleSpecification {
  const nameExpr: unknown =
    lang === 'en'
      ? ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name']]
      : ['coalesce', ['get', 'name:vi'], ['get', 'name'], ['get', 'name:latin']];

  const cleanSources = { ...base.sources } as Record<string, unknown>;
  if ('ne2_shaded' in cleanSources) {
    delete cleanSources.ne2_shaded;
  }

  if (surface === 'hybrid') {
    cleanSources['esri-sat'] = {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© Esri, Maxar, Earthstar Geographics',
    };
  }

  const mappedLayers: LayerSpecification[] = [];
  if (surface === 'hybrid') {
    mappedLayers.push({
      id: 'esri-sat-layer',
      type: 'raster',
      source: 'esri-sat',
      minzoom: 0,
      maxzoom: 22,
    } as LayerSpecification);
  }

  let housenumberInserted = false;
  let unrankedPoiInserted = false;

  for (const layer of base.layers) {
    const sourceLayer = (layer as { 'source-layer'?: string })['source-layer'];
    const isCountryBorder =
      layer.id === 'boundary_2' || layer.id === 'boundary_country_z0-4' || layer.id === 'boundary_country_z5-';

    // Ở chế độ Vệ tinh + Địa chỉ (hybrid): giữ lớp đường nét mảnh trong suốt, ranh giới, tên đường, POI, số nhà, khu phố đè trực tiếp lên ảnh vệ tinh
    if (surface === 'hybrid') {
      const keepOnSatellite =
        layer.type === 'symbol' ||
        layer.id.startsWith('boundary_') ||
        (layer.type === 'line' &&
          sourceLayer === 'transportation' &&
          !layer.id.includes('casing') &&
          !layer.id.includes('hatching'));
      if (!keepOnSatellite) continue;
    } else if (layer.id === 'natural_earth') {
      continue;
    }

    const next = surface === 'roadmap' ? tuneRoadmapLayer(layer) : ({ ...layer } as Record<string, unknown>);

    // Trong Đồng Nai: chỉ ẩn ranh giới tỉnh/huyện cũ (`boundary_3`/`boundary_state`/`boundary_county`) để dùng địa giới 2 cấp mới;
    // NGOÀI Đồng Nai giữ nguyên ranh giới hành chính đầy đủ toàn Việt Nam & thế giới như Google Maps!
    if (
      layer.id === 'boundary_3' ||
      layer.id === 'boundary_state' ||
      layer.id === 'boundary_county' ||
      (layer.id.startsWith('boundary_') && !isCountryBorder)
    ) {
      next.filter = excludeDongNaiLegacyFilter(next.filter);
    }

    // Trong Đồng Nai: chỉ ẩn nhãn đơn vị hành chính CŨ (state/city/town/village) để thay bằng 95 Phường/Xã mới nhất.
    // GIỮ NGUYÊN `label_other` (Khu phố, Ấp, Cù lao, KCN) trong Đồng Nai và GIỮ NGUYÊN 100% nhãn bên ngoài Đồng Nai!
    const isCountryLabel = layer.id.includes('country');
    const isOtherSubLocality = layer.id === 'label_other' || layer.id === 'place_other' || layer.id === 'place_suburb';
    const isLegacyAdminPlaceLayer =
      !isCountryLabel &&
      !isOtherSubLocality &&
      (LEGACY_OSM_ADMIN_LAYERS.has(layer.id) ||
        (sourceLayer === 'place' &&
          (layer.id.includes('state') ||
            layer.id.includes('city') ||
            layer.id.includes('town') ||
            layer.id.includes('village') ||
            layer.id.includes('capital'))));
    if (isLegacyAdminPlaceLayer) {
      next.filter = excludeDongNaiLegacyFilter(next.filter);
    }

    if (surface === 'hybrid' && layer.type === 'line' && sourceLayer === 'transportation') {
      const paint = (next.paint as Record<string, unknown> | undefined) ?? {};
      const isMajor =
        layer.id.includes('motorway') || layer.id.includes('trunk') || layer.id.includes('primary');
      next.paint = {
        ...paint,
        'line-color': isMajor ? 'rgba(251, 191, 36, 0.78)' : 'rgba(255, 255, 255, 0.5)',
        'line-opacity': isMajor ? 0.78 : 0.5,
      };
    }

    if (layer.type === 'symbol') {
      const layout = (next.layout as Record<string, unknown> | undefined) ?? (layer.layout as Record<string, unknown> | undefined);
      const paint = (next.paint as Record<string, unknown> | undefined) ?? {};
      if (layout && 'text-field' in layout && !layer.id.includes('shield') && !JSON.stringify(layout['text-field']).includes('"ref"')) {
        next.layout = { ...layout, 'text-field': nameExpr };
        if (surface === 'roadmap' && 'text-halo-color' in paint) {
          next.paint = {
            ...paint,
            'text-halo-color': 'rgba(255, 255, 255, 0.98)',
            'text-halo-width': Math.max(Number(paint['text-halo-width'] ?? 1.4), 2.0),
          };
        } else if (surface === 'hybrid') {
          next.paint = {
            ...paint,
            'text-color': layer.id.startsWith('poi_') ? GOOGLE_POI_TEXT_COLOR_DARK : '#FFFFFF',
            'text-halo-color': 'rgba(15, 23, 42, 0.92)',
            'text-halo-width': 2.2,
          };
        }
      }
      if (surface === 'hybrid') {
        if (layer.id === 'highway-name-major') next.minzoom = 10.5;
        else if (layer.id === 'highway-name-minor') next.minzoom = 12.5;
        else if (layer.id === 'poi_r1') next.minzoom = 12.0;
        else if (layer.id === 'poi_r7') next.minzoom = 13.5;
        else if (layer.id === 'poi_r20') next.minzoom = 14.8;
      }
    }

    mappedLayers.push(next as unknown as LayerSpecification);

    // Chèn lớp số nhà chi tiết từ openmaptiles (`housenumber`) hiển thị xuyên suốt zoom 14.8 → 22
    if (
      !housenumberInserted &&
      'openmaptiles' in cleanSources &&
      (layer.id === 'building-3d' || layer.id === 'highway-name-minor')
    ) {
      housenumberInserted = true;
      mappedLayers.push({
        id: 'sc-housenumber',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'housenumber',
        minzoom: 14.8,
        layout: {
          'text-field': ['to-string', ['get', 'housenumber']],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 14.8, 9.5, 17, 11, 20, 13],
          'text-allow-overlap': false,
          'text-padding': 3,
        },
        paint: {
          'text-color': surface === 'roadmap' ? '#334155' : '#F8FAFC',
          'text-halo-color': surface === 'roadmap' ? 'rgba(255, 255, 255, 0.98)' : 'rgba(15, 23, 42, 0.92)',
          'text-halo-width': 1.8,
        },
      } as unknown as LayerSpecification);
    }

    // Bắt thêm mọi POI chi tiết không có trường `rank` (cửa hàng, quán ăn, công ty, văn phòng nhỏ trong hẻm)
    if (!unrankedPoiInserted && 'openmaptiles' in cleanSources && layer.id === 'poi_r20') {
      unrankedPoiInserted = true;
      mappedLayers.push({
        id: 'sc-poi-unranked',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'poi',
        minzoom: 15.0,
        filter: ['all', ['!', ['has', 'rank']], ['has', 'name']],
        layout: {
          'text-field': nameExpr,
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 15, 9.8, 18, 11.5, 21, 13],
          'text-max-width': 9,
          'text-padding': 3,
        },
        paint: {
          'text-color': surface === 'roadmap' ? GOOGLE_POI_TEXT_COLOR_LIGHT : GOOGLE_POI_TEXT_COLOR_DARK,
          'text-halo-color': surface === 'roadmap' ? 'rgba(255, 255, 255, 0.98)' : 'rgba(15, 23, 42, 0.92)',
          'text-halo-width': 1.8,
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
 * Nạp Vector Tile Style chi tiết chuẩn Google Maps (đường hẻm, tòa nhà 3D, POI phân màu theo danh mục,
 * tên đường tiếng Việt, số nhà tới zoom 22, và lớp phủ Vector trên ảnh vệ tinh Hybrid).
 */
export async function loadDetailedVectorStyle(
  surface: MapSurfaceStyle,
  lang: 'vi' | 'en',
  signal?: AbortSignal,
): Promise<StyleSpecification | null> {
  if (typeof fetch === 'undefined') return null;
  if (!cachedVectorStylePromise) {
    const ctrl = new AbortController();
    const timer = typeof window !== 'undefined' ? window.setTimeout(() => ctrl.abort(), 8000) : null;
    cachedVectorStylePromise = fetch(OPENFREEMAP_VECTOR_STYLE_URL, {
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
        cachedVectorStylePromise = null;
        return null;
      })
      .finally(() => {
        if (timer !== null) window.clearTimeout(timer);
      });
  }

  const base = await cachedVectorStylePromise;
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
 * Cấu hình Style khởi tạo & dự phòng cho MapLibre GL JS (100% miễn phí, không API key, không watermark):
 *  - `roadmap`: OpenStreetMap Standard (đầy đủ tên đường, hẻm, số nhà, POI toàn cầu) trước/khi dự phòng cho Vector Google-style.
 *  - `hybrid`: Ảnh vệ tinh Esri World Imagery + Mạng lưới đường Esri World Transportation + Nhãn địa danh Esri.
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
        { id: 'esri-places-layer', type: 'raster', source: 'esri-places', minzoom: 0, maxzoom: 22 },
      ],
    };
  }

  return {
    version: 8,
    glyphs: DONG_NAI_GLYPHS_URL,
    sources: {
      'osm-standard': {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: [{ id: 'osm-standard-layer', type: 'raster', source: 'osm-standard', minzoom: 0, maxzoom: 22 }],
  };
}
