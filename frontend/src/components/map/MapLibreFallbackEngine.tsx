import * as maplibregl from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { useEffect, useRef, useState } from 'react';

maplibregl.setWorkerUrl(maplibreWorkerUrl);
import { ARTERIAL_ROADS } from '@shared/geo';
import { useI18n } from '../../i18n';
import { QUICK_PLACES } from '../../lib/geoClient';
import {
  buildMapLibreStyle,
  createClusterElement,
  createGeoJsonCircle,
  createIncidentPinElement,
  DONG_NAI_CAMERA_RESTRICTION,
  DONG_NAI_MAPLIBRE_BOUNDS,
  getPinState,
  loadDetailedVectorRoadmapStyle,
  PIN_STATE_COLOR,
  PIN_STATE_RANK,
  type MapPoint,
  type PinPriorityState,
} from '../../lib/mapConfig';
import type { SharedEngineProps } from './GoogleMapEngine';

interface Bucket<T extends MapPoint> {
  items: T[];
  latSum: number;
  lngSum: number;
  highest: PinPriorityState;
}

/** Gom cụm không gian O(N) siêu nhanh theo mức zoom thực tế cho chế độ MapLibre Marker. */
function clusterPointsByZoom<T extends MapPoint>(points: T[], zoom: number): Array<Bucket<T>> {
  if (zoom >= 15.5 || points.length <= 1) {
    return points.map((p) => ({
      items: [p],
      latSum: p.lat,
      lngSum: p.lng,
      highest: getPinState(p),
    }));
  }
  const cellDeg = 48 / (256 * Math.pow(2, Math.max(5, zoom))) * 360;
  const grid = new Map<string, Bucket<T>>();
  for (const p of points) {
    const gx = Math.floor(p.lng / cellDeg);
    const gy = Math.floor(p.lat / cellDeg);
    const key = `${gx}:${gy}`;
    const st = getPinState(p);
    const existing = grid.get(key);
    if (existing) {
      existing.items.push(p);
      existing.latSum += p.lat;
      existing.lngSum += p.lng;
      if (PIN_STATE_RANK[st] > PIN_STATE_RANK[existing.highest]) existing.highest = st;
    } else {
      grid.set(key, { items: [p], latSum: p.lat, lngSum: p.lng, highest: st });
    }
  }
  return [...grid.values()];
}

function buildOverlaysGeoJson(
  userPos: { lat: number; lng: number } | null | undefined,
  accuracyM: number | null | undefined,
  radiusM: number | null | undefined,
  showArterials: boolean | undefined,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  if (showArterials) {
    for (const road of ARTERIAL_ROADS) {
      features.push({
        type: 'Feature',
        properties: { kind: 'arterial', name: road.name },
        geometry: {
          type: 'LineString',
          coordinates: road.points.map(([lat, lng]) => [lng, lat]),
        },
      });
    }
  }
  if (userPos && accuracyM && accuracyM > 0) {
    const f = createGeoJsonCircle(userPos.lat, userPos.lng, accuracyM);
    f.properties = { kind: 'accuracy' };
    features.push(f);
  }
  if (userPos && radiusM && radiusM > 0) {
    const f = createGeoJsonCircle(userPos.lat, userPos.lng, radiusM);
    f.properties = { kind: 'radius' };
    features.push(f);
  }
  return { type: 'FeatureCollection', features };
}

function buildHeatmapGeoJson<T extends MapPoint>(reports: T[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: reports
      .filter((r) => r.status !== 'resolved')
      .map((r) => ({
        type: 'Feature',
        properties: {
          weight: Math.min(1, (r.severity / 5) * (r.emergencyLevel === 1 ? 1.4 : 1) + (r.clusterCount - 1) * 0.15),
        },
        geometry: {
          type: 'Point',
          coordinates: [r.lng, r.lat],
        },
      })),
  };
}

/**
 * Engine Dự phòng MapLibre GL JS (WebGL 60FPS):
 * - Tự động kích hoạt khi chưa cấu hình `VITE_GOOGLE_MAPS_API_KEY`, bị chặn domain, hoặc mất kết nối Google.
 * - Nếu trình duyệt tắt cả WebGL, tự động rơi xuống bảng lưới tọa độ dự phòng cấp 2 — tuyệt đối 0% crash.
 */
export function MapLibreFallbackEngine<T extends MapPoint = MapPoint>(p: SharedEngineProps<T>) {
  const { lang } = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const [zoomTick, setZoomTick] = useState(0);
  const [styleReadySeq, setStyleReadySeq] = useState(0);
  const [webglUnavailable, setWebglUnavailable] = useState(false);

  const selectRef = useRef(p.onSelect);
  selectRef.current = p.onSelect;
  const crosshairRef = useRef(p.onCrosshairMove);
  crosshairRef.current = p.onCrosshairMove;
  const viewportRef = useRef(p.onViewportChange);
  viewportRef.current = p.onViewportChange;
  const dragRef = useRef(p.onDraggingChange);
  dragRef.current = p.onDraggingChange;
  const crosshairActiveRef = useRef(p.crosshairActive);
  crosshairActiveRef.current = p.crosshairActive;

  const surfaceRef = useRef(p.surface);
  const langRef = useRef(lang);
  const vectorActiveRef = useRef(false);
  const vectorLoadedRef = useRef(false);
  const vectorFailedRef = useRef(false);
  const lastCmdSeqRef = useRef(0);

  // 1) Khởi tạo MapLibre một lần duy nhất mỗi lần mount; dọn sạch 100% tài nguyên khi chuyển route SPA
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: el,
        style: buildMapLibreStyle(p.surface),
        center: [p.initialCenter.lng, p.initialCenter.lat],
        zoom: p.initialZoom,
        minZoom: 7,
        maxZoom: 20,
        maxBounds: [
          [DONG_NAI_CAMERA_RESTRICTION.west, DONG_NAI_CAMERA_RESTRICTION.south],
          [DONG_NAI_CAMERA_RESTRICTION.east, DONG_NAI_CAMERA_RESTRICTION.north],
        ],
        attributionControl: { compact: true },
      });
      map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');
    } catch (err) {
      console.warn('[MapLibre] Thiết bị không hỗ trợ WebGL, kích hoạt khung dự phòng 2D:', err);
      setWebglUnavailable(true);
      return;
    }

    mapRef.current = map;
    surfaceRef.current = p.surface;
    langRef.current = lang;
    let vectorDisposed = false;
    const vectorAbort = new AbortController();

    const applyDetailedVectorIfRoadmap = (targetSurface: typeof p.surface, targetLang: 'vi' | 'en'): void => {
      if (targetSurface !== 'roadmap' || vectorFailedRef.current) {
        vectorActiveRef.current = false;
        vectorLoadedRef.current = false;
        return;
      }
      void loadDetailedVectorRoadmapStyle(targetLang, vectorAbort.signal).then((vecStyle) => {
        if (vectorDisposed || !vecStyle || surfaceRef.current !== 'roadmap' || vectorFailedRef.current) return;
        vectorActiveRef.current = true;
        vectorLoadedRef.current = false;
        map.setStyle(vecStyle);
      });
    };

    const emitViewport = (): void => {
      if (viewportRef.current) {
        const b = map.getBounds();
        viewportRef.current({
          minLng: b.getWest(),
          minLat: b.getSouth(),
          maxLng: b.getEast(),
          maxLat: b.getNorth(),
        });
      }
    };

    map.on('load', () => {
      if (p.fitPointsOnMount && p.reports.length > 0) {
        const bounds = new maplibregl.LngLatBounds();
        for (const r of p.reports) bounds.extend([r.lng, r.lat]);
        map.fitBounds(bounds, { padding: 44, maxZoom: 15.5, duration: 0 });
      } else if (p.fitCityOnMount) {
        map.fitBounds(DONG_NAI_MAPLIBRE_BOUNDS, { padding: 24, duration: 0 });
      }
      setStyleReadySeq((n) => n + 1);
      emitViewport();
      applyDetailedVectorIfRoadmap(p.surface, lang);
    });

    map.on('style.load', () => {
      if (vectorActiveRef.current) vectorLoadedRef.current = true;
      setStyleReadySeq((n) => n + 1);
    });

    map.on('styledata', () => {
      if (map.isStyleLoaded()) setStyleReadySeq((n) => n + 1);
    });

    map.on('error', () => {
      if (vectorActiveRef.current && !vectorLoadedRef.current && !vectorFailedRef.current) {
        vectorFailedRef.current = true;
        vectorActiveRef.current = false;
        if (surfaceRef.current === 'roadmap') {
          map.setStyle(buildMapLibreStyle('roadmap'));
        }
      }
    });

    map.on('movestart', () => dragRef.current?.(true));
    map.on('moveend', () => {
      dragRef.current?.(false);
      if (crosshairActiveRef.current) {
        const c = map.getCenter();
        crosshairRef.current?.(c.lat, c.lng);
      }
      setZoomTick((n) => n + 1);
      emitViewport();
    });

    map.on('click', (ev) => {
      if (crosshairActiveRef.current) {
        const curZoom = map.getZoom();
        map.easeTo({
          center: ev.lngLat,
          zoom: curZoom < 14 ? 15 : curZoom,
          duration: curZoom < 14 ? 320 : 220,
        });
      }
    });

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => map.resize()) : null;
    ro?.observe(el);

    return () => {
      vectorDisposed = true;
      vectorAbort.abort();
      ro?.disconnect();
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      mapRef.current = null;
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2) Đổi lớp nền (Đường phố Vector / Vệ tinh + Đường / Tối) mượt không hủy instance Map
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const surfaceChanged = surfaceRef.current !== p.surface;
    const langChanged = langRef.current !== lang;
    if (!surfaceChanged && !langChanged) return;
    surfaceRef.current = p.surface;
    langRef.current = lang;

    if (p.surface === 'roadmap' && !vectorFailedRef.current) {
      let cancelled = false;
      const ctrl = new AbortController();
      if (surfaceChanged) {
        vectorActiveRef.current = false;
        map.setStyle(buildMapLibreStyle('roadmap'));
      }
      void loadDetailedVectorRoadmapStyle(lang, ctrl.signal).then((vecStyle) => {
        if (cancelled || !vecStyle || surfaceRef.current !== 'roadmap' || vectorFailedRef.current) return;
        vectorActiveRef.current = true;
        vectorLoadedRef.current = false;
        map.setStyle(vecStyle);
      });
      return () => {
        cancelled = true;
        ctrl.abort();
      };
    }

    if (surfaceChanged) {
      vectorActiveRef.current = false;
      map.setStyle(buildMapLibreStyle(p.surface));
    }
  }, [p.surface, lang]);

  // 3) Điều khiển camera mệnh lệnh (flyTo, fitCity, fitPoints, zoomDelta)
  useEffect(() => {
    const map = mapRef.current;
    const cmd = p.cameraCommand;
    if (!map || !cmd || cmd.seq === lastCmdSeqRef.current) return;
    lastCmdSeqRef.current = cmd.seq;

    if (cmd.kind === 'fitCity') {
      map.fitBounds(DONG_NAI_MAPLIBRE_BOUNDS, { padding: 24, duration: 420 });
    } else if (cmd.kind === 'fitPoints' && p.reports.length > 0) {
      const bounds = new maplibregl.LngLatBounds();
      for (const r of p.reports) bounds.extend([r.lng, r.lat]);
      map.fitBounds(bounds, { padding: 44, maxZoom: 15.5, duration: 420 });
    } else if (cmd.kind === 'flyTo' && typeof cmd.lat === 'number' && typeof cmd.lng === 'number') {
      map.easeTo({
        center: [cmd.lng, cmd.lat],
        zoom: cmd.zoom ?? map.getZoom(),
        duration: 380,
      });
    } else if (cmd.kind === 'zoomDelta' && typeof cmd.delta === 'number') {
      map.easeTo({
        zoom: Math.min(20, Math.max(7, map.getZoom() + cmd.delta)),
        duration: 180,
      });
    }
  }, [p.cameraCommand, p.reports]);

  // 4) Vẽ lớp phủ GeoJSON (Trục huyết mạch, Vòng tròn sai số GPS ±m, Bán kính lọc & Bản đồ nhiệt)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleReadySeq === 0) return;
    try {
      if (!map.getStyle()) return;
    } catch {
      return;
    }

    const overlayData = buildOverlaysGeoJson(p.userPos, p.accuracyM, p.radiusM, p.showArterials);
    const existingOverlay = map.getSource('sc-overlays') as maplibregl.GeoJSONSource | undefined;
    if (existingOverlay) {
      existingOverlay.setData(overlayData);
    } else {
      map.addSource('sc-overlays', { type: 'geojson', data: overlayData });
      map.addLayer({
        id: 'sc-accuracy-fill',
        type: 'fill',
        source: 'sc-overlays',
        filter: ['==', ['get', 'kind'], 'accuracy'],
        paint: { 'fill-color': '#3B82F6', 'fill-opacity': 0.14 },
      });
      map.addLayer({
        id: 'sc-accuracy-line',
        type: 'line',
        source: 'sc-overlays',
        filter: ['==', ['get', 'kind'], 'accuracy'],
        paint: { 'line-color': '#0B57D0', 'line-width': 1.5, 'line-dasharray': [3, 3] },
      });
      map.addLayer({
        id: 'sc-radius-fill',
        type: 'fill',
        source: 'sc-overlays',
        filter: ['==', ['get', 'kind'], 'radius'],
        paint: { 'fill-color': '#0B57D0', 'fill-opacity': 0.06 },
      });
      map.addLayer({
        id: 'sc-radius-line',
        type: 'line',
        source: 'sc-overlays',
        filter: ['==', ['get', 'kind'], 'radius'],
        paint: { 'line-color': '#0B57D0', 'line-width': 1.5 },
      });
      map.addLayer({
        id: 'sc-arterial-line',
        type: 'line',
        source: 'sc-overlays',
        filter: ['==', ['get', 'kind'], 'arterial'],
        paint: {
          'line-color': '#F59E0B',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 14, 2.8, 18, 4],
          'line-opacity': 0.68,
          'line-dasharray': [4, 2],
        },
      });
    }

    const heatData = p.mode === 'heat' ? buildHeatmapGeoJson(p.reports) : { type: 'FeatureCollection' as const, features: [] };
    const existingHeat = map.getSource('sc-heat') as maplibregl.GeoJSONSource | undefined;
    if (existingHeat) {
      existingHeat.setData(heatData);
    } else {
      map.addSource('sc-heat', { type: 'geojson', data: heatData });
      map.addLayer({
        id: 'sc-heat-layer',
        type: 'heatmap',
        source: 'sc-heat',
        paint: {
          'heatmap-weight': ['coalesce', ['get', 'weight'], 0.6],
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 7, 1, 15, 2.5],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 7, 18, 15, 34],
          'heatmap-opacity': 0.8,
          'heatmap-color': [
            'interpolate',
            ['linear'],
            ['heatmap-density'],
            0,
            'rgba(56, 189, 248, 0)',
            0.25,
            '#38bdf8',
            0.5,
            '#facc15',
            0.75,
            '#fb923c',
            1,
            '#e11d48',
          ],
        },
      });
    }
  }, [styleReadySeq, p.userPos, p.accuracyM, p.radiusM, p.showArterials, p.mode, p.reports]);

  // 5) Chấm xanh vị trí người dùng
  useEffect(() => {
    const map = mapRef.current;
    userMarkerRef.current?.remove();
    userMarkerRef.current = null;
    if (!map || !p.userPos) return;
    const dot = document.createElement('div');
    dot.className = 'sc-user-dot';
    userMarkerRef.current = new maplibregl.Marker({ element: dot, anchor: 'center' })
      .setLngLat([p.userPos.lng, p.userPos.lat])
      .addTo(map);
  }, [p.userPos, styleReadySeq]);

  // 6) Các ghim sự cố và cụm gom nhóm thông minh
  useEffect(() => {
    const map = mapRef.current;
    for (const m of markersRef.current) m.remove();
    markersRef.current = [];
    if (!map || p.mode !== 'pins') return;

    const buckets = clusterPointsByZoom(p.reports, map.getZoom());
    for (const b of buckets) {
      if (b.items.length === 1) {
        const r = b.items[0];
        const el = createIncidentPinElement(r, () => selectRef.current?.(r));
        const mk = new maplibregl.Marker({ element: el, anchor: 'bottom' })
          .setLngLat([r.lng, r.lat])
          .addTo(map);
        markersRef.current.push(mk);
      } else {
        const cLat = b.latSum / b.items.length;
        const cLng = b.lngSum / b.items.length;
        const el = createClusterElement(b.items.length, b.highest, () => {
          map.easeTo({ center: [cLng, cLat], zoom: Math.min(18, map.getZoom() + 2.2), duration: 280 });
        });
        const mk = new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat([cLng, cLat])
          .addTo(map);
        markersRef.current.push(mk);
      }
    }
  }, [p.reports, p.mode, zoomTick, styleReadySeq]);

  // Dự phòng cấp cuối cùng nếu môi trường tắt cứng WebGL (ví dụ trình duyệt cổ / kiểm thử không GPU)
  if (webglUnavailable) {
    return (
      <div className="flex h-full w-full flex-col justify-between bg-surface-2 p-4 text-xs">
        <div>
          <p className="font-bold text-ink">Chế độ danh sách tọa độ an toàn (Thiết bị tắt tăng tốc phần cứng WebGL)</p>
          <p className="mt-0.5 text-muted">Toàn bộ dữ liệu phản ánh và định vị 95 Phường/Xã vẫn hoạt động đầy đủ:</p>
        </div>
        {p.crosshairActive ? (
          <div className="my-2 flex flex-wrap gap-1.5">
            {QUICK_PLACES.map((pl) => (
              <button
                key={pl.wardCode}
                type="button"
                className="chip !min-h-8 !text-xs"
                onClick={() => p.onCrosshairMove?.(pl.lat, pl.lng)}
              >
                {pl.name}
              </button>
            ))}
          </div>
        ) : (
          <div className="my-2 grid max-h-48 gap-1.5 overflow-y-auto sm:grid-cols-2">
            {p.reports.slice(0, 20).map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => p.onSelect?.(r)}
                className="flex items-center gap-2 rounded-xl border border-line bg-surface px-2.5 py-2 text-left hover:bg-surface-2"
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PIN_STATE_COLOR[getPinState(r)] }} />
                <span className="truncate font-semibold text-ink">{r.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return <div ref={containerRef} className="h-full w-full" />;
}
