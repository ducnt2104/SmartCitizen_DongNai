import * as maplibregl from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { useEffect, useRef, useState } from 'react';
import { ARTERIAL_ROADS, haversineMeters } from '@shared/geo';
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
  loadDetailedVectorStyle,
  PIN_STATE_COLOR,
  PIN_STATE_RANK,
  type MapPoint,
  type PinPriorityState,
} from '../../lib/mapConfig';
import { shortestAngleDeltaDeg } from '../../lib/navigationEngine';
import type { DraggablePinSpec, RouteOverlaySpec, SharedEngineProps } from './GoogleMapEngine';

maplibregl.setWorkerUrl(maplibreWorkerUrl);

interface Bucket<T extends MapPoint> {
  items: T[];
  latSum: number;
  lngSum: number;
  highest: PinPriorityState;
}

/** Gom cụm không gian O(N) theo mức zoom thực tế cho các ghim thường (không gộp ghim đích đang điều hướng). */
function clusterPointsByZoom<T extends MapPoint>(points: T[], zoom: number): Array<Bucket<T>> {
  if (zoom >= 15.5 || points.length <= 1) {
    return points.map((p) => ({
      items: [p],
      latSum: p.lat,
      lngSum: p.lng,
      highest: getPinState(p),
    }));
  }
  const cellDeg = (48 / (256 * Math.pow(2, Math.max(5, zoom)))) * 360;
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
  routeOverlay: RouteOverlaySpec | null | undefined,
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
  if (routeOverlay) {
    const pts =
      routeOverlay.fallbackPath && routeOverlay.fallbackPath.length >= 2
        ? routeOverlay.fallbackPath
        : [routeOverlay.origin, routeOverlay.destination];
    features.push({
      type: 'Feature',
      properties: { kind: 'rescue_route' },
      geometry: {
        type: 'LineString',
        coordinates: pts.map((pt) => [pt.lng, pt.lat]),
      },
    });
  }
  if (userPos && accuracyM && accuracyM > 0) {
    const f = createGeoJsonCircle(userPos.lat, userPos.lng, Math.max(6, accuracyM));
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
 * Engine MapLibre GL JS (WebGL 60FPS):
 * - Nội suy Marker xe cứu hộ 60FPS bằng `requestAnimationFrame` (~800ms) không tạo lại DOM Marker.
 * - Auto-Follow bù chiều cao Bottom Sheet (`followPadding`) & tự nhả ngay lập tức khi người dùng chạm kéo/zoom (`originalEvent`).
 */
export function MapLibreFallbackEngine<T extends MapPoint = MapPoint>(p: SharedEngineProps<T>) {
  const { lang } = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const userRotatorRef = useRef<HTMLDivElement | null>(null);
  const userMarkerModeRef = useRef<'nav' | 'dot' | null>(null);
  const animStateRef = useRef<{ lat: number; lng: number; heading: number } | null>(null);
  const rafRef = useRef<number | null>(null);

  const draggableMarkerRef = useRef<maplibregl.Marker | null>(null);
  const selectedMarkerRef = useRef<maplibregl.Marker | null>(null);
  const draggablePinRef = useRef<DraggablePinSpec | null | undefined>(p.draggablePin);
  draggablePinRef.current = p.draggablePin;
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
  const userPanRef = useRef(p.onUserPan);
  userPanRef.current = p.onUserPan;
  const crosshairActiveRef = useRef(p.crosshairActive);
  crosshairActiveRef.current = p.crosshairActive;
  const onMapClickRef = useRef(p.onMapClick);
  onMapClickRef.current = p.onMapClick;

  const surfaceRef = useRef(p.surface);
  const langRef = useRef(lang);
  const vectorActiveRef = useRef(false);
  const vectorLoadedRef = useRef(false);
  const vectorFailedRef = useRef(false);
  const vectorWatchdogRef = useRef<number | null>(null);
  const lastCmdSeqRef = useRef(0);
  const lastFitRouteSeqRef = useRef(0);

  const clearVectorWatchdog = (): void => {
    if (vectorWatchdogRef.current !== null) {
      window.clearTimeout(vectorWatchdogRef.current);
      vectorWatchdogRef.current = null;
    }
  };

  const fallbackToRasterStyle = (map: maplibregl.Map, reason: string): void => {
    clearVectorWatchdog();
    if (vectorFailedRef.current) return;
    console.warn('[MapLibre] Chuyển sang nền Esri World_Street_Map do:', reason);
    vectorFailedRef.current = true;
    vectorActiveRef.current = false;
    vectorLoadedRef.current = false;
    if (surfaceRef.current === 'roadmap' || surfaceRef.current === 'dark') {
      map.setStyle(buildMapLibreStyle(surfaceRef.current));
    }
  };

  const applyVectorStyleWithWatchdog = (map: maplibregl.Map, vecStyle: maplibregl.StyleSpecification): void => {
    clearVectorWatchdog();
    vectorActiveRef.current = true;
    vectorLoadedRef.current = false;
    map.setStyle(vecStyle);
    vectorWatchdogRef.current = window.setTimeout(() => {
      if (vectorActiveRef.current && !vectorLoadedRef.current && !vectorFailedRef.current) {
        fallbackToRasterStyle(map, 'vector load timeout (4.5s)');
      }
    }, 4500);
  };

  // 1) Khởi tạo MapLibre một lần duy nhất mỗi lần mount; dọn sạch 100% tài nguyên khi unmount
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
      const collapseMobileAttrib = (): void => {
        if (el.clientWidth >= 640) return;
        el.querySelectorAll('details.maplibregl-ctrl-attrib[open]').forEach((d) => d.removeAttribute('open'));
        el.querySelectorAll('.maplibregl-ctrl-attrib.maplibregl-compact-show').forEach((d) =>
          d.classList.remove('maplibregl-compact-show'),
        );
      };
      requestAnimationFrame(collapseMobileAttrib);
      map.on('resize', collapseMobileAttrib);
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

    const applyDetailedVectorIfSupported = (targetSurface: typeof p.surface, targetLang: 'vi' | 'en'): void => {
      if ((targetSurface !== 'roadmap' && targetSurface !== 'dark') || vectorFailedRef.current) {
        clearVectorWatchdog();
        vectorActiveRef.current = false;
        vectorLoadedRef.current = false;
        return;
      }
      void loadDetailedVectorStyle(targetSurface, targetLang, vectorAbort.signal).then((vecStyle) => {
        if (vectorDisposed || !vecStyle || surfaceRef.current !== targetSurface || vectorFailedRef.current) return;
        applyVectorStyleWithWatchdog(map, vecStyle);
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
      applyDetailedVectorIfSupported(p.surface, lang);
    });

    map.on('style.load', () => {
      setStyleReadySeq((n) => n + 1);
    });

    map.on('sourcedata', (ev) => {
      if (
        vectorActiveRef.current &&
        !vectorLoadedRef.current &&
        ev.sourceId === 'openmaptiles' &&
        ev.isSourceLoaded &&
        map.areTilesLoaded()
      ) {
        vectorLoadedRef.current = true;
        clearVectorWatchdog();
      }
    });

    map.on('styledata', () => {
      if (map.isStyleLoaded()) setStyleReadySeq((n) => n + 1);
    });

    map.on('error', (ev) => {
      if (vectorActiveRef.current && !vectorLoadedRef.current && !vectorFailedRef.current) {
        const msg =
          (ev as { error?: { message?: string }; sourceId?: string }).error?.message ??
          (ev as { sourceId?: string }).sourceId ??
          'style/tile load error';
        fallbackToRasterStyle(map, msg);
      }
    });

    // Hủy tức thì Auto-Follow chỉ khi có tương tác vật lý thật từ người dùng (`originalEvent` tồn tại)
    const onHumanGesture = (ev: { originalEvent?: Event }) => {
      if (!ev.originalEvent) return;
      userPanRef.current?.();
    };
    map.on('dragstart', onHumanGesture);
    map.on('zoomstart', onHumanGesture);
    map.on('rotatestart', onHumanGesture);
    map.on('pitchstart', onHumanGesture);

    const onPointerInterrupt = () => {
      // Hủy ngay animation camera tự động đang chạy để ngón tay/chuột kéo mượt không bị khựng
      if (map.isMoving()) map.stop();
    };
    el.addEventListener('pointerdown', onPointerInterrupt, { passive: true });

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
        return;
      }
      const target = ev.originalEvent?.target as HTMLElement | null;
      if (target?.closest('.sc-map-pin, .sc-cluster, .maplibregl-ctrl, .maplibregl-marker')) {
        return;
      }
      onMapClickRef.current?.(ev.lngLat.lat, ev.lngLat.lng);
    });

    const handleResize = () => map.resize();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(handleResize) : null;
    ro?.observe(el);
    window.addEventListener('resize', handleResize);

    return () => {
      vectorDisposed = true;
      clearVectorWatchdog();
      vectorAbort.abort();
      ro?.disconnect();
      window.removeEventListener('resize', handleResize);
      el.removeEventListener('pointerdown', onPointerInterrupt);
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      userRotatorRef.current = null;
      userMarkerModeRef.current = null;
      draggableMarkerRef.current?.remove();
      draggableMarkerRef.current = null;
      selectedMarkerRef.current?.remove();
      selectedMarkerRef.current = null;
      mapRef.current = null;
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Đảm bảo invalidate kích thước khung vẽ khi mở/đóng Bottom Sheet hoặc Sidebar
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const id = window.requestAnimationFrame(() => map.resize());
    return () => window.cancelAnimationFrame(id);
  }, [p.followPadding?.bottom, p.followPadding?.top, p.followPadding?.left]);

  // 2) Đổi lớp nền (Đường phố Vector / Vệ tinh + Đường) mượt không hủy instance Map
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const surfaceChanged = surfaceRef.current !== p.surface;
    const langChanged = langRef.current !== lang;
    if (!surfaceChanged && !langChanged) return;
    surfaceRef.current = p.surface;
    langRef.current = lang;

    if ((p.surface === 'roadmap' || p.surface === 'dark') && !vectorFailedRef.current) {
      let cancelled = false;
      const ctrl = new AbortController();
      const targetSurface = p.surface;
      if (surfaceChanged) {
        clearVectorWatchdog();
        vectorActiveRef.current = false;
        vectorLoadedRef.current = false;
        map.setStyle(buildMapLibreStyle(targetSurface));
      }
      void loadDetailedVectorStyle(targetSurface, lang, ctrl.signal).then((vecStyle) => {
        if (cancelled || !vecStyle || surfaceRef.current !== targetSurface || vectorFailedRef.current) return;
        applyVectorStyleWithWatchdog(map, vecStyle);
      });
      return () => {
        cancelled = true;
        clearVectorWatchdog();
        ctrl.abort();
      };
    }

    if (surfaceChanged) {
      clearVectorWatchdog();
      vectorActiveRef.current = false;
      vectorLoadedRef.current = false;
      map.setStyle(buildMapLibreStyle(p.surface));
    }
  }, [p.surface, lang]);

  // 3) Điều khiển camera mệnh lệnh (flyTo có tính bù paddingBottom, fitCity, fitPoints, zoomDelta)
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
        padding: {
          top: p.followPadding?.top ?? 0,
          bottom: p.followPadding?.bottom ?? 0,
          left: p.followPadding?.left ?? 0,
          right: p.followPadding?.right ?? 0,
        },
        duration: 420,
        essential: true,
      });
    } else if (cmd.kind === 'zoomDelta' && typeof cmd.delta === 'number') {
      map.easeTo({
        zoom: Math.min(20, Math.max(7, map.getZoom() + cmd.delta)),
        duration: 180,
      });
    }
  }, [p.cameraCommand, p.reports, p.followPadding]);

  // 3b) Smart Camera Auto-Follow: tự bám mượt vị trí xe cứu hộ và giữ xe ở khoảng giữa vùng nhìn trống
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !p.autoFollow || !p.userPos) return;
    map.easeTo({
      center: [p.userPos.lng, p.userPos.lat],
      zoom: Math.max(map.getZoom(), 15.8),
      padding: {
        top: p.followPadding?.top ?? 24,
        bottom: p.followPadding?.bottom ?? 24,
        left: p.followPadding?.left ?? 0,
        right: p.followPadding?.right ?? 0,
      },
      duration: 680,
      essential: true,
    });
  }, [
    p.autoFollow,
    p.userPos?.lat,
    p.userPos?.lng,
    p.followPadding?.bottom,
    p.followPadding?.top,
    p.followPadding?.left,
  ]);

  // 4) Vẽ lớp phủ GeoJSON (Tuyến đường xanh dương đậm có viền sáng, vòng tròn sai số GPS, trục chính)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleReadySeq === 0) return;
    try {
      if (!map.getStyle() || !map.isStyleLoaded()) return;
    } catch {
      return;
    }

    try {
      const overlayData = buildOverlaysGeoJson(p.userPos, p.accuracyM, p.radiusM, p.showArterials, p.routeOverlay);
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
          paint: { 'fill-color': '#3B82F6', 'fill-opacity': 0.15 },
        });
        map.addLayer({
          id: 'sc-accuracy-line',
          type: 'line',
          source: 'sc-overlays',
          filter: ['==', ['get', 'kind'], 'accuracy'],
          paint: { 'line-color': '#1A73E8', 'line-width': 1.5, 'line-opacity': 0.6 },
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
        map.addLayer({
          id: 'sc-rescue-route-halo',
          type: 'line',
          source: 'sc-overlays',
          filter: ['==', ['get', 'kind'], 'rescue_route'],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#ffffff', 'line-width': 10.5, 'line-opacity': 0.92 },
        });
        map.addLayer({
          id: 'sc-rescue-route-line',
          type: 'line',
          source: 'sc-overlays',
          filter: ['==', ['get', 'kind'], 'rescue_route'],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': p.routeOverlay?.strokeColor ?? '#1A73E8', 'line-width': 6.5, 'line-opacity': 0.98 },
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
    } catch {
      // Sẽ tự động chạy lại ngay khi style.load tăng styleReadySeq
    }
  }, [styleReadySeq, p.userPos, p.accuracyM, p.radiusM, p.showArterials, p.routeOverlay, p.mode, p.reports]);

  // Fit toàn cảnh tuyến đường CHỈ khi `fitRouteSeq` tăng (hoặc khi preview chưa bật autoFollow lần đầu),
  // TUYỆT ĐỐI KHÔNG phụ thuộc `preserveViewport` để không bao giờ giật ngược tay khi người dùng kéo bản đồ!
  useEffect(() => {
    const map = mapRef.current;
    const el = containerRef.current;
    if (!map || !el || !p.routeOverlay) return;
    if (!p.fitRouteSeq || p.fitRouteSeq === lastFitRouteSeqRef.current) return;
    if (el.clientWidth < 80 || el.clientHeight < 80) return;

    lastFitRouteSeqRef.current = p.fitRouteSeq;
    const bounds = new maplibregl.LngLatBounds();
    bounds.extend([p.routeOverlay.origin.lng, p.routeOverlay.origin.lat]);
    bounds.extend([p.routeOverlay.destination.lng, p.routeOverlay.destination.lat]);
    if (p.routeOverlay.fallbackPath) {
      for (const pt of p.routeOverlay.fallbackPath) bounds.extend([pt.lng, pt.lat]);
    }

    const padTop = Math.min(160, Math.max(36, (p.followPadding?.top ?? 64) + 16));
    const padBottom = Math.min(340, Math.max(48, (p.followPadding?.bottom ?? 220) + 20));
    const padLeft = Math.min(380, Math.max(24, (p.followPadding?.left ?? 20) + 16));
    const padRight = Math.min(96, Math.max(24, (p.followPadding?.right ?? 20) + 16));

    try {
      map.fitBounds(bounds, {
        padding: { top: padTop, bottom: padBottom, left: padLeft, right: padRight },
        maxZoom: 16.2,
        duration: 450,
      });
    } catch {
      map.easeTo({
        center: [p.routeOverlay.destination.lng, p.routeOverlay.destination.lat],
        zoom: 15,
        duration: 320,
      });
    }
  }, [p.fitRouteSeq, p.routeOverlay, p.followPadding]);

  // Ghim kéo thả trực tiếp (Interactive Pin Drop)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !p.draggablePin) {
      draggableMarkerRef.current?.remove();
      draggableMarkerRef.current = null;
      return;
    }
    if (!draggableMarkerRef.current) {
      const wrap = document.createElement('div');
      wrap.style.cursor = 'grab';
      wrap.title = 'Kéo thả ghim để chỉnh vị trí chính xác';
      wrap.innerHTML =
        '<div style="display:flex;flex-direction:column;align-items:center;"><div style="width:36px;height:36px;border-radius:9999px;background:#E11D48;border:2.5px solid #fff;color:#fff;font-weight:800;font-size:10px;display:grid;place-items:center;box-shadow:0 6px 16px rgba(0,0,0,0.32);">GHIM</div><div style="width:4px;height:10px;background:#E11D48;border-radius:0 0 4px 4px;"></div></div>';
      const mk = new maplibregl.Marker({ element: wrap, anchor: 'bottom', draggable: true })
        .setLngLat([p.draggablePin.lng, p.draggablePin.lat])
        .addTo(map);
      mk.on('dragend', () => {
        const ll = mk.getLngLat();
        draggablePinRef.current?.onDragEnd(ll.lat, ll.lng);
      });
      draggableMarkerRef.current = mk;
    } else {
      draggableMarkerRef.current.setLngLat([p.draggablePin.lng, p.draggablePin.lat]);
    }
  }, [p.draggablePin?.lat, p.draggablePin?.lng, styleReadySeq]);

  // Ghim vị trí đang chọn hoặc kết quả tìm kiếm địa chỉ
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !p.selectedPin) {
      selectedMarkerRef.current?.remove();
      selectedMarkerRef.current = null;
      return;
    }
    if (!selectedMarkerRef.current) {
      const wrap = document.createElement('div');
      wrap.style.pointerEvents = 'none';
      if (p.selectedPin.label) wrap.title = p.selectedPin.label;
      wrap.innerHTML =
        '<div style="display:flex;flex-direction:column;align-items:center;filter:drop-shadow(0 4px 8px rgba(0,0,0,0.28));"><div style="width:28px;height:28px;border-radius:9999px;background:#DC2626;border:2.5px solid #fff;display:grid;place-items:center;"><span style="width:9px;height:9px;border-radius:9999px;background:#fff;display:block;"></span></div><div style="width:3.5px;height:9px;margin-top:-2px;background:#DC2626;border-radius:0 0 4px 4px;"></div></div>';
      selectedMarkerRef.current = new maplibregl.Marker({ element: wrap, anchor: 'bottom' })
        .setLngLat([p.selectedPin.lng, p.selectedPin.lat])
        .addTo(map);
    } else {
      selectedMarkerRef.current.setLngLat([p.selectedPin.lng, p.selectedPin.lat]);
      if (p.selectedPin.label) {
        selectedMarkerRef.current.getElement().title = p.selectedPin.label;
      }
    }
  }, [p.selectedPin?.lat, p.selectedPin?.lng, p.selectedPin?.label, styleReadySeq]);

  // 5) Chuyển động Marker Xe Cứu Hộ mượt 60FPS (`requestAnimationFrame` ~800ms, tái sử dụng DOM 100%)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !p.userPos) {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      userRotatorRef.current = null;
      userMarkerModeRef.current = null;
      animStateRef.current = null;
      return;
    }

    const wantMode: 'nav' | 'dot' =
      p.navigationMode || (typeof p.userHeadingDeg === 'number' && Number.isFinite(p.userHeadingDeg)) ? 'nav' : 'dot';

    if (!userMarkerRef.current || userMarkerModeRef.current !== wantMode) {
      userMarkerRef.current?.remove();
      const el = document.createElement('div');
      if (wantMode === 'nav') {
        el.className = 'sc-nav-puck';
        el.innerHTML =
          '<span class="sc-nav-puck-radar"></span><div data-puck-rotator="1" style="position:relative;display:grid;place-items:center;"><span class="sc-nav-puck-cone"></span><span class="sc-nav-puck-arrow"><svg viewBox="0 0 24 24" width="16" height="16" fill="#ffffff" aria-hidden="true"><path d="M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z"/></svg></span></div>';
        userRotatorRef.current = el.querySelector('[data-puck-rotator="1"]') as HTMLDivElement | null;
      } else {
        el.className = 'sc-user-dot';
        userRotatorRef.current = null;
      }
      userMarkerModeRef.current = wantMode;
      userMarkerRef.current = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([p.userPos.lng, p.userPos.lat])
        .addTo(map);
    }

    const mk = userMarkerRef.current;
    const targetLat = p.userPos.lat;
    const targetLng = p.userPos.lng;
    const targetHeading = typeof p.userHeadingDeg === 'number' && Number.isFinite(p.userHeadingDeg) ? p.userHeadingDeg : 0;
    const cur = animStateRef.current;

    if (!cur || haversineMeters(cur.lat, cur.lng, targetLat, targetLng) > 1500) {
      animStateRef.current = { lat: targetLat, lng: targetLng, heading: targetHeading };
      mk.setLngLat([targetLng, targetLat]);
      if (userRotatorRef.current) {
        userRotatorRef.current.style.transform = `rotate(${targetHeading.toFixed(1)}deg)`;
      }
      return;
    }

    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    const startLat = cur.lat;
    const startLng = cur.lng;
    const startHeading = cur.heading;
    const dHeading = shortestAngleDeltaDeg(startHeading, targetHeading);
    const startTime = performance.now();
    const durationMs = 780;

    const animateFrame = (now: number) => {
      const rawT = Math.min(1, (now - startTime) / durationMs);
      const easeT = 1 - Math.pow(1 - rawT, 2);
      const lat = startLat + (targetLat - startLat) * easeT;
      const lng = startLng + (targetLng - startLng) * easeT;
      const heading = (startHeading + dHeading * easeT + 360) % 360;

      animStateRef.current = { lat, lng, heading };
      mk.setLngLat([lng, lat]);
      if (userRotatorRef.current) {
        userRotatorRef.current.style.transform = `rotate(${heading.toFixed(1)}deg)`;
      }

      if (rawT < 1) {
        rafRef.current = window.requestAnimationFrame(animateFrame);
      } else {
        rafRef.current = null;
      }
    };

    rafRef.current = window.requestAnimationFrame(animateFrame);
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [p.userPos?.lat, p.userPos?.lng, p.userHeadingDeg, p.navigationMode]);

  // 6) Các ghim sự cố (tách riêng Ghim Đích đến nhấp nháy không bị gom cụm)
  useEffect(() => {
    const map = mapRef.current;
    for (const m of markersRef.current) m.remove();
    markersRef.current = [];
    if (!map || p.mode !== 'pins') return;

    const destReport = p.activeDestinationId ? p.reports.find((r) => r.id === p.activeDestinationId) : undefined;
    const normalReports = destReport ? p.reports.filter((r) => r.id !== destReport.id) : p.reports;

    const buckets = clusterPointsByZoom(normalReports, map.getZoom());
    for (const b of buckets) {
      if (b.items.length === 1) {
        const r = b.items[0];
        const el = createIncidentPinElement(r, () => selectRef.current?.(r), false);
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

    if (destReport) {
      const destEl = createIncidentPinElement(destReport, () => selectRef.current?.(destReport), true);
      const destMk = new maplibregl.Marker({ element: destEl, anchor: 'bottom' })
        .setLngLat([destReport.lng, destReport.lat])
        .addTo(map);
      markersRef.current.push(destMk);
    }
  }, [p.reports, p.mode, p.activeDestinationId, zoomTick, styleReadySeq]);

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
