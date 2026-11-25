import { useSyncExternalStore } from 'react';
import type { StyleSpecification } from 'maplibre-gl';
import { DONG_NAI_CITY_BOUNDS, DONG_NAI_CITY_CENTER } from '@shared/constants';
import type { Category, Priority, ReportStatus } from '@shared/types';

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
export function createIncidentPinElement(r: MapPoint, onActivate?: () => void): HTMLButtonElement {
  const state = getPinState(r);
  const color = PIN_STATE_COLOR[state];
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sc-map-pin group';
  btn.setAttribute('aria-label', r.title);
  btn.title = r.title;

  const pulse =
    state === 'emergency'
      ? '<span class="sc-map-pin-pulse" aria-hidden="true"></span>'
      : '';
  const badge =
    r.clusterCount > 1
      ? `<span class="sc-map-pin-badge" aria-hidden="true">${Math.min(99, r.clusterCount)}</span>`
      : '';

  btn.innerHTML = `${pulse}${badge}<svg viewBox="0 0 34 42" width="36" height="44" aria-hidden="true" class="sc-map-pin-svg"><path d="M17 1C8.7 1 2 7.5 2 15.8 2 27 17 41 17 41s15-14 15-25.2C32 7.5 25.3 1 17 1Z" fill="${color}" stroke="#ffffff" stroke-width="2.2"/>${CAT_SVG_MARKUP[r.category]}</svg>`;

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
  ((import.meta.env as Record<string, string | undefined>).VITE_GOOGLE_MAPS_MAP_ID ?? '').trim() || 'DEMO_MAP_ID';

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

export const OPENFREEMAP_VECTOR_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
export const OPENFREEMAP_DARK_STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';

const cachedVectorStylePromises: Partial<Record<'roadmap' | 'dark', Promise<StyleSpecification | null>>> = {};

function cloneAndLocalizeVectorStyle(base: StyleSpecification, lang: 'vi' | 'en'): StyleSpecification {
  const nameExpr: unknown =
    lang === 'en'
      ? ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name']]
      : ['coalesce', ['get', 'name:vi'], ['get', 'name'], ['get', 'name:latin']];

  return {
    ...base,
    layers: base.layers.map((layer) => {
      if (layer.type !== 'symbol') return layer;
      const layout = layer.layout as Record<string, unknown> | undefined;
      if (!layout || !('text-field' in layout) || layer.id.includes('shield')) return layer;
      if (JSON.stringify(layout['text-field']).includes('"ref"')) return layer;
      return {
        ...layer,
        layout: {
          ...layout,
          'text-field': nameExpr,
        },
      } as typeof layer;
    }),
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
    const timer = typeof window !== 'undefined' ? window.setTimeout(() => ctrl.abort(), 3500) : null;
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
  return cloneAndLocalizeVectorStyle(base, lang);
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

  if (surface === 'dark') {
    return {
      version: 8,
      sources: {
        'esri-dark': {
          type: 'raster',
          tiles: [
            'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
          ],
          tileSize: 256,
          maxzoom: 16,
          attribution: '© Esri, HERE, Garmin, OpenStreetMap contributors',
        },
        'esri-dark-ref': {
          type: 'raster',
          tiles: [
            'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
          ],
          tileSize: 256,
          maxzoom: 16,
          attribution: '© Esri',
        },
      },
      layers: [
        { id: 'esri-dark-layer', type: 'raster', source: 'esri-dark', minzoom: 0, maxzoom: 22 },
        { id: 'esri-dark-ref-layer', type: 'raster', source: 'esri-dark-ref', minzoom: 0, maxzoom: 22 },
      ],
    };
  }

  return {
    version: 8,
    sources: {
      'esri-street': {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© Esri, HERE, Garmin, OpenStreetMap contributors',
      },
    },
    layers: [{ id: 'esri-street-layer', type: 'raster', source: 'esri-street', minzoom: 0, maxzoom: 22 }],
  };
}
