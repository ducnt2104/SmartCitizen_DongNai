import { MarkerClusterer, SuperClusterAlgorithm, type Cluster } from '@googlemaps/markerclusterer';
import {
  AdvancedMarker,
  APILoadingStatus,
  APIProvider,
  Circle,
  ColorScheme,
  Map as GoogleMap,
  Polyline,
  useApiLoadingStatus,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ARTERIAL_ROADS, haversineMeters } from '@shared/geo';
import { useI18n } from '../../i18n';
import {
  createClusterElement,
  createIncidentPinElement,
  DONG_NAI_CAMERA_RESTRICTION,
  DONG_NAI_DEFAULT_CENTER,
  DONG_NAI_GOOGLE_BOUNDS,
  getPinState,
  GOOGLE_MAPS_API_KEY,
  GOOGLE_MAPS_MAP_ID,
  markGoogleMapsFailed,
  PIN_STATE_RANK,
  type MapBbox,
  type MapMode,
  type MapPoint,
  type MapSurfaceStyle,
  type PinPriorityState,
} from '../../lib/mapConfig';
import { shortestAngleDeltaDeg } from '../../lib/navigationEngine';

export interface CameraCommand {
  seq: number;
  kind: 'flyTo' | 'fitCity' | 'fitPoints' | 'zoomDelta';
  lat?: number;
  lng?: number;
  zoom?: number;
  delta?: number;
}

export interface RouteOverlaySpec {
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  fallbackPath?: Array<{ lat: number; lng: number }>;
  travelMode?: 'rescue_truck' | 'motorcycle' | 'walking';
  strokeColor?: string;
  preserveViewport?: boolean;
  onRouteResolved?: (info: { distanceKm: number; durationMin: number; source: 'google_directions' | 'osrm' | 'geodesic' }) => void;
}

export interface DraggablePinSpec {
  lat: number;
  lng: number;
  onDragEnd: (lat: number, lng: number) => void;
}

export interface FollowPaddingSpec {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

export interface SharedEngineProps<T extends MapPoint = MapPoint> {
  id: string;
  reports: T[];
  mode: MapMode;
  surface: MapSurfaceStyle;
  initialCenter: { lat: number; lng: number };
  initialZoom: number;
  fitCityOnMount?: boolean;
  fitPointsOnMount?: boolean;
  cameraCommand?: CameraCommand | null;
  userPos?: { lat: number; lng: number } | null;
  userHeadingDeg?: number | null;
  navigationMode?: boolean;
  accuracyM?: number | null;
  radiusM?: number | null;
  showArterials?: boolean;
  activeDestinationId?: string | null;
  autoFollow?: boolean;
  followPadding?: FollowPaddingSpec;
  fitRouteSeq?: number;
  onSelect?: (r: T) => void;
  onViewportChange?: (bbox: MapBbox) => void;
  crosshairActive?: boolean;
  onCrosshairMove?: (lat: number, lng: number) => void;
  onDraggingChange?: (dragging: boolean) => void;
  onUserPan?: () => void;
  draggablePin?: DraggablePinSpec | null;
  routeOverlay?: RouteOverlaySpec | null;
}

const GOOGLE_LIBRARIES = ['places', 'geocoding', 'marker', 'routes'];

/** Bảng màu chuẩn 256 mức cho Canvas Heatmap. */
const HEAT_PALETTE: Uint8ClampedArray = (() => {
  const lut = new Uint8ClampedArray(256 * 4);
  const stops: Array<[number, [number, number, number]]> = [
    [0, [56, 189, 248]],
    [90, [56, 189, 248]],
    [150, [250, 204, 21]],
    [205, [251, 146, 60]],
    [255, [225, 29, 72]],
  ];
  for (let i = 0; i < 256; i++) {
    let s0 = stops[0];
    let s1 = stops[stops.length - 1];
    for (let j = 0; j < stops.length - 1; j++) {
      if (i >= stops[j][0] && i <= stops[j + 1][0]) {
        s0 = stops[j];
        s1 = stops[j + 1];
        break;
      }
    }
    const span = Math.max(1, s1[0] - s0[0]);
    const t = (i - s0[0]) / span;
    lut[i * 4] = Math.round(s0[1][0] + (s1[1][0] - s0[1][0]) * t);
    lut[i * 4 + 1] = Math.round(s0[1][1] + (s1[1][1] - s0[1][1]) * t);
    lut[i * 4 + 2] = Math.round(s0[1][2] + (s1[1][2] - s0[1][2]) * t);
    lut[i * 4 + 3] = i < 12 ? 0 : Math.min(215, Math.round(i * 0.92));
  }
  return lut;
})();

/** Dịch chuyển tọa độ tâm camera để trừ phần chiều cao Bottom Sheet (`paddingBottom`) & Top Banner (`paddingTop`). */
function offsetLatLngByPadding(
  lat: number,
  lng: number,
  zoom: number,
  padding?: FollowPaddingSpec,
): { lat: number; lng: number } {
  if (!padding) return { lat, lng };
  const dyPx = ((padding.bottom ?? 0) - (padding.top ?? 0)) * 0.5;
  const dxPx = ((padding.right ?? 0) - (padding.left ?? 0)) * 0.5;
  if (Math.abs(dyPx) < 2 && Math.abs(dxPx) < 2) return { lat, lng };

  const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const metersPerPx = (156543.03392 * cosLat) / Math.pow(2, zoom);
  const dLat = -(dyPx * metersPerPx) / 110574;
  const dLng = (dxPx * metersPerPx) / (111320 * cosLat);
  return { lat: lat + dLat, lng: lng + dLng };
}

function ApiHealthMonitor() {
  const status = useApiLoadingStatus();
  useEffect(() => {
    if (status === APILoadingStatus.AUTH_FAILURE || status === APILoadingStatus.FAILED) {
      markGoogleMapsFailed(status);
      return;
    }
    if (status === APILoadingStatus.LOADED) return;

    const timer = window.setTimeout(() => {
      markGoogleMapsFailed('load_timeout');
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [status]);
  return null;
}

/** Bộ điều khiển Camera mệnh lệnh + Auto-Follow trừ chiều cao Bottom Sheet + ResizeObserver chống đen/méo khung. */
function GoogleCameraController<T extends MapPoint>({
  mapId,
  reports,
  fitCityOnMount,
  fitPointsOnMount,
  cameraCommand,
  autoFollow,
  userPos,
  followPadding,
  routeOverlay,
  fitRouteSeq,
}: {
  mapId: string;
  reports: T[];
  fitCityOnMount?: boolean;
  fitPointsOnMount?: boolean;
  cameraCommand?: CameraCommand | null;
  autoFollow?: boolean;
  userPos?: { lat: number; lng: number } | null;
  followPadding?: FollowPaddingSpec;
  routeOverlay?: RouteOverlaySpec | null;
  fitRouteSeq?: number;
}) {
  const map = useMap(mapId);
  const mountedFitRef = useRef(false);
  const lastSeqRef = useRef(0);
  const lastFitRouteRef = useRef(0);

  // Tự động trigger resize khi khung bản đồ hoặc bottom sheet thay đổi kích thước
  useEffect(() => {
    if (!map || typeof google === 'undefined') return;
    const div = map.getDiv();
    const triggerResize = () => {
      google.maps.event.trigger(map, 'resize');
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(triggerResize) : null;
    if (div) ro?.observe(div);
    window.addEventListener('resize', triggerResize);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', triggerResize);
    };
  }, [map]);

  useEffect(() => {
    if (!map || mountedFitRef.current) return;
    if (fitPointsOnMount && reports.length > 0) {
      mountedFitRef.current = true;
      const bounds = new google.maps.LatLngBounds();
      for (const r of reports) bounds.extend({ lat: r.lat, lng: r.lng });
      map.fitBounds(bounds, 44);
      const listener = google.maps.event.addListenerOnce(map, 'idle', () => {
        if ((map.getZoom() ?? 10) > 16) map.setZoom(16);
      });
      return () => google.maps.event.removeListener(listener);
    }
    if (fitCityOnMount) {
      mountedFitRef.current = true;
      map.fitBounds(DONG_NAI_GOOGLE_BOUNDS, 24);
    }
  }, [map, fitCityOnMount, fitPointsOnMount, reports]);

  useEffect(() => {
    if (!map || !cameraCommand || cameraCommand.seq === lastSeqRef.current) return;
    lastSeqRef.current = cameraCommand.seq;

    if (cameraCommand.kind === 'fitCity') {
      map.fitBounds(DONG_NAI_GOOGLE_BOUNDS, 24);
    } else if (cameraCommand.kind === 'fitPoints' && reports.length > 0) {
      const bounds = new google.maps.LatLngBounds();
      for (const r of reports) bounds.extend({ lat: r.lat, lng: r.lng });
      map.fitBounds(bounds, 44);
    } else if (
      cameraCommand.kind === 'flyTo' &&
      typeof cameraCommand.lat === 'number' &&
      typeof cameraCommand.lng === 'number'
    ) {
      const targetZoom = typeof cameraCommand.zoom === 'number' ? cameraCommand.zoom : (map.getZoom() ?? 15);
      if (typeof cameraCommand.zoom === 'number') {
        map.setZoom(cameraCommand.zoom);
      }
      const shifted = offsetLatLngByPadding(cameraCommand.lat, cameraCommand.lng, targetZoom, followPadding);
      map.panTo(shifted);
    } else if (cameraCommand.kind === 'zoomDelta' && typeof cameraCommand.delta === 'number') {
      map.setZoom(Math.min(20, Math.max(7, (map.getZoom() ?? 12) + cameraCommand.delta)));
    }
  }, [map, cameraCommand, reports, followPadding]);

  // Auto-Follow mượt theo vị trí xe cứu hộ (có bù paddingBottom của Bottom Sheet)
  useEffect(() => {
    if (!map || !autoFollow || !userPos) return;
    const curZoom = map.getZoom() ?? 16;
    if (curZoom < 15) map.setZoom(16);
    const effectiveZoom = Math.max(curZoom, 15);
    const shifted = offsetLatLngByPadding(userPos.lat, userPos.lng, effectiveZoom, followPadding);
    map.panTo(shifted);
  }, [map, autoFollow, userPos?.lat, userPos?.lng, followPadding?.bottom, followPadding?.top, followPadding?.left]);

  // Fit toàn cảnh tuyến đường CHỈ khi đổi đơn preview (`fitRouteSeq` tăng), tuyệt đối không giật ngược khi user kéo map
  useEffect(() => {
    if (!map || !routeOverlay || !fitRouteSeq || fitRouteSeq === lastFitRouteRef.current) return;
    lastFitRouteRef.current = fitRouteSeq;
    const bounds = new google.maps.LatLngBounds();
    bounds.extend(routeOverlay.origin);
    bounds.extend(routeOverlay.destination);
    if (routeOverlay.fallbackPath) {
      for (const pt of routeOverlay.fallbackPath) bounds.extend(pt);
    }
    map.fitBounds(bounds, {
      top: Math.max(40, (followPadding?.top ?? 64) + 16),
      bottom: Math.max(60, (followPadding?.bottom ?? 220) + 20),
      left: Math.max(32, (followPadding?.left ?? 24) + 16),
      right: Math.max(32, (followPadding?.right ?? 24) + 16),
    });
  }, [map, fitRouteSeq, routeOverlay, followPadding]);

  return null;
}

/** Marker Xe / Mũi tên điều hướng 60FPS (`requestAnimationFrame` ~800ms) + Vòng tròn xanh báo sai số GPS. */
function GoogleSmoothUserPuck({
  mapId,
  userPos,
  userHeadingDeg,
  navigationMode,
  accuracyM,
}: {
  mapId: string;
  userPos?: { lat: number; lng: number } | null;
  userHeadingDeg?: number | null;
  navigationMode?: boolean;
  accuracyM?: number | null;
}) {
  const map = useMap(mapId);
  const markerLib = useMapsLibrary('marker');
  const markerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const rotatorRef = useRef<HTMLDivElement | null>(null);
  const circleRef = useRef<google.maps.Circle | null>(null);
  const animStateRef = useRef<{ lat: number; lng: number; heading: number } | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!map || !markerLib) return;
    const root = document.createElement('div');
    const isNav = Boolean(navigationMode || (typeof userHeadingDeg === 'number' && Number.isFinite(userHeadingDeg)));
    if (isNav) {
      root.className = 'sc-nav-puck';
      root.innerHTML =
        '<span class="sc-nav-puck-radar"></span><div data-puck-rotator="1" style="position:relative;display:grid;place-items:center;"><span class="sc-nav-puck-cone"></span><span class="sc-nav-puck-arrow"><svg viewBox="0 0 24 24" width="16" height="16" fill="#ffffff" aria-hidden="true"><path d="M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z"/></svg></span></div>';
      rotatorRef.current = root.querySelector('[data-puck-rotator="1"]') as HTMLDivElement | null;
    } else {
      root.className = 'sc-user-dot';
      rotatorRef.current = null;
    }

    const mk = new markerLib.AdvancedMarkerElement({
      map: userPos ? map : null,
      position: userPos ?? undefined,
      content: root,
      zIndex: 965,
    });
    markerRef.current = mk;

    const circle = new google.maps.Circle({
      map: userPos && accuracyM && accuracyM > 0 ? map : null,
      center: userPos ?? undefined,
      radius: Math.max(5, accuracyM ?? 15),
      strokeColor: '#1A73E8',
      strokeOpacity: 0.55,
      strokeWeight: 1.5,
      fillColor: '#3B82F6',
      fillOpacity: 0.15,
      clickable: false,
    });
    circleRef.current = circle;

    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      mk.map = null;
      circle.setMap(null);
      markerRef.current = null;
      circleRef.current = null;
      rotatorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, markerLib, Boolean(navigationMode || typeof userHeadingDeg === 'number')]);

  useEffect(() => {
    const mk = markerRef.current;
    const circle = circleRef.current;
    if (!map || !mk) return;
    if (!userPos) {
      mk.map = null;
      circle?.setMap(null);
      return;
    }
    if (!mk.map) mk.map = map;
    if (circle) {
      if (accuracyM && accuracyM > 0) {
        if (!circle.getMap()) circle.setMap(map);
        circle.setRadius(Math.max(5, accuracyM));
      } else {
        circle.setMap(null);
      }
    }

    const targetHeading = typeof userHeadingDeg === 'number' && Number.isFinite(userHeadingDeg) ? userHeadingDeg : 0;
    const cur = animStateRef.current;

    if (!cur || haversineMeters(cur.lat, cur.lng, userPos.lat, userPos.lng) > 1500) {
      animStateRef.current = { lat: userPos.lat, lng: userPos.lng, heading: targetHeading };
      mk.position = { lat: userPos.lat, lng: userPos.lng };
      circle?.setCenter({ lat: userPos.lat, lng: userPos.lng });
      if (rotatorRef.current) {
        rotatorRef.current.style.transform = `rotate(${targetHeading.toFixed(1)}deg)`;
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

    const stepFrame = (now: number) => {
      const rawT = Math.min(1, (now - startTime) / durationMs);
      const easeT = 1 - Math.pow(1 - rawT, 2);
      const lat = startLat + (userPos.lat - startLat) * easeT;
      const lng = startLng + (userPos.lng - startLng) * easeT;
      const heading = (startHeading + dHeading * easeT + 360) % 360;

      animStateRef.current = { lat, lng, heading };
      mk.position = { lat, lng };
      circle?.setCenter({ lat, lng });
      if (rotatorRef.current) {
        rotatorRef.current.style.transform = `rotate(${heading.toFixed(1)}deg)`;
      }

      if (rawT < 1) {
        rafRef.current = window.requestAnimationFrame(stepFrame);
      } else {
        rafRef.current = null;
      }
    };

    rafRef.current = window.requestAnimationFrame(stepFrame);
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [map, userPos?.lat, userPos?.lng, userHeadingDeg, accuracyM]);

  return null;
}

/** Lớp Marker Clustering hiệu năng cao + Ghim Đích đến (Sự cố) nhấp nháy nổi bật không bao giờ bị gộp cụm. */
function GoogleClusteredPins<T extends MapPoint>({
  mapId,
  reports,
  activeDestinationId,
  onSelect,
}: {
  mapId: string;
  reports: T[];
  activeDestinationId?: string | null;
  onSelect?: (r: T) => void;
}) {
  const map = useMap(mapId);
  const markerLib = useMapsLibrary('marker');
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

  useEffect(() => {
    if (!map || !markerLib) return;
    const stateMap = new WeakMap<object, PinPriorityState>();
    const createdMarkers: google.maps.marker.AdvancedMarkerElement[] = [];
    const directMarkers: google.maps.marker.AdvancedMarkerElement[] = [];
    const clickListeners: google.maps.MapsEventListener[] = [];

    const clusterer = new MarkerClusterer({
      map,
      algorithm: new SuperClusterAlgorithm({ radius: 56, maxZoom: 15 }),
      renderer: {
        render(cluster: Cluster) {
          let highest: PinPriorityState = 'resolved';
          for (const m of cluster.markers) {
            const st = stateMap.get(m) ?? 'open';
            if (PIN_STATE_RANK[st] > PIN_STATE_RANK[highest]) highest = st;
          }
          const content = createClusterElement(cluster.count, highest, () => {
            if (cluster.bounds) map.fitBounds(cluster.bounds, 48);
          });
          return new markerLib.AdvancedMarkerElement({
            position: cluster.position,
            content,
            zIndex: 1000 + cluster.count,
          });
        },
      },
      onClusterClick: (_ev, cluster, targetMap) => {
        if (cluster.bounds) targetMap.fitBounds(cluster.bounds, 48);
      },
    });

    for (const r of reports) {
      const isDest = Boolean(activeDestinationId && r.id === activeDestinationId);
      const el = createIncidentPinElement(r, () => selectRef.current?.(r), isDest);
      const adv = new markerLib.AdvancedMarkerElement({
        map: isDest ? map : null,
        position: { lat: r.lat, lng: r.lng },
        content: el,
        title: r.title,
        zIndex: isDest ? 950 : r.emergencyLevel === 1 ? 900 : r.priority === 'high' ? 600 : 300,
      });
      const l = adv.addListener('gmp-click', () => selectRef.current?.(r));
      clickListeners.push(l);
      if (isDest) {
        directMarkers.push(adv);
      } else {
        stateMap.set(adv, getPinState(r));
        createdMarkers.push(adv);
      }
    }

    clusterer.addMarkers(createdMarkers);

    return () => {
      for (const l of clickListeners) l.remove();
      clusterer.clearMarkers();
      clusterer.setMap(null);
      for (const m of createdMarkers) m.map = null;
      for (const m of directMarkers) m.map = null;
    };
  }, [map, markerLib, reports, activeDestinationId]);

  return null;
}

function GoogleHeatmapLayer<T extends MapPoint>({ mapId, reports }: { mapId: string; reports: T[] }) {
  const map = useMap(mapId);

  useEffect(() => {
    if (!map || typeof google === 'undefined' || !google.maps?.OverlayView) return;
    const active = reports
      .filter((r) => r.status !== 'resolved')
      .map((r) => ({
        lat: r.lat,
        lng: r.lng,
        weight: Math.min(1, Math.max(0.35, (r.severity / 5) * (r.emergencyLevel === 1 ? 1.35 : 1) + (r.clusterCount - 1) * 0.15)),
      }));

    class HeatCanvasOverlay extends google.maps.OverlayView {
      private canvas: HTMLCanvasElement | null = null;

      onAdd(): void {
        const c = document.createElement('canvas');
        c.style.position = 'absolute';
        c.style.pointerEvents = 'none';
        this.canvas = c;
        this.getPanes()?.overlayLayer.appendChild(c);
      }

      draw(): void {
        const c = this.canvas;
        const proj = this.getProjection();
        const m = this.getMap() as google.maps.Map | null;
        if (!c || !proj || !m) return;
        const bounds = m.getBounds();
        if (!bounds) return;
        const ne = proj.fromLatLngToDivPixel(bounds.getNorthEast());
        const sw = proj.fromLatLngToDivPixel(bounds.getSouthWest());
        if (!ne || !sw) return;

        const left = Math.min(sw.x, ne.x);
        const top = Math.min(ne.y, sw.y);
        const w = Math.max(1, Math.min(3072, Math.round(Math.abs(ne.x - sw.x))));
        const h = Math.max(1, Math.min(3072, Math.round(Math.abs(sw.y - ne.y))));

        c.style.left = `${left}px`;
        c.style.top = `${top}px`;
        c.style.width = `${w}px`;
        c.style.height = `${h}px`;
        c.width = w;
        c.height = h;

        const ctx = c.getContext('2d');
        if (!ctx || active.length === 0) return;
        ctx.clearRect(0, 0, w, h);

        const radius = Math.max(22, Math.min(44, ((m.getZoom() ?? 11) - 6) * 4.5));
        for (const pt of active) {
          const px = proj.fromLatLngToDivPixel(new google.maps.LatLng(pt.lat, pt.lng));
          if (!px) continue;
          const x = px.x - left;
          const y = px.y - top;
          if (x < -radius || y < -radius || x > w + radius || y > h + radius) continue;
          const grad = ctx.createRadialGradient(x, y, 2, x, y, radius);
          grad.addColorStop(0, `rgba(0,0,0,${pt.weight})`);
          grad.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.fill();
        }

        const img = ctx.getImageData(0, 0, w, h);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          const a = d[i + 3];
          if (a === 0) continue;
          const idx = a * 4;
          d[i] = HEAT_PALETTE[idx];
          d[i + 1] = HEAT_PALETTE[idx + 1];
          d[i + 2] = HEAT_PALETTE[idx + 2];
          d[i + 3] = HEAT_PALETTE[idx + 3];
        }
        ctx.putImageData(img, 0, 0);
      }

      onRemove(): void {
        this.canvas?.remove();
        this.canvas = null;
      }
    }

    const overlay = new HeatCanvasOverlay();
    overlay.setMap(map);
    const idleSub = map.addListener('idle', () => overlay.draw());

    return () => {
      idleSub.remove();
      overlay.setMap(null);
    };
  }, [map, reports]);

  return null;
}

/** Chỉ dùng DirectionsRenderer khi người gọi không truyền sẵn `fallbackPath` đã tính từ `computeNavigationRoute`. */
function GoogleDirectionsLayer({
  mapId,
  route,
  onDirectionsActive,
}: {
  mapId: string;
  route: RouteOverlaySpec;
  onDirectionsActive?: (active: boolean) => void;
}) {
  const map = useMap(mapId);
  const routesLib = useMapsLibrary('routes');
  const cbRef = useRef(route.onRouteResolved);
  cbRef.current = route.onRouteResolved;
  const activeRef = useRef(onDirectionsActive);
  activeRef.current = onDirectionsActive;

  useEffect(() => {
    if (!map || !routesLib || (route.fallbackPath && route.fallbackPath.length >= 2)) {
      activeRef.current?.(false);
      return;
    }
    let cancelled = false;
    const primaryColor = route.strokeColor ?? '#1A73E8';
    const renderer = new routesLib.DirectionsRenderer({
      map,
      suppressMarkers: true,
      preserveViewport: true,
      polylineOptions: {
        strokeColor: primaryColor,
        strokeOpacity: 0.96,
        strokeWeight: 6,
        zIndex: 420,
      },
    });
    const svc = new routesLib.DirectionsService();
    const tm = google.maps.TravelMode as unknown as Record<string, google.maps.TravelMode>;
    const travelMode =
      route.travelMode === 'walking'
        ? google.maps.TravelMode.WALKING
        : route.travelMode === 'motorcycle' && tm.TWO_WHEELER
          ? tm.TWO_WHEELER
          : google.maps.TravelMode.DRIVING;

    svc
      .route({
        origin: route.origin,
        destination: route.destination,
        travelMode,
        region: 'VN',
        language: 'vi',
      })
      .then((res) => {
        if (cancelled) return;
        renderer.setDirections(res);
        activeRef.current?.(true);
        const leg = res.routes?.[0]?.legs?.[0];
        if (leg?.distance?.value && leg?.duration?.value) {
          cbRef.current?.({
            distanceKm: Math.round((leg.distance.value / 1000) * 100) / 100,
            durationMin: Math.max(1, Math.round(leg.duration.value / 60)),
            source: 'google_directions',
          });
        }
      })
      .catch(() => {
        if (!cancelled) activeRef.current?.(false);
      });

    return () => {
      cancelled = true;
      activeRef.current?.(false);
      renderer.setMap(null);
    };
  }, [
    map,
    routesLib,
    route.destination.lat,
    route.destination.lng,
    route.travelMode,
    route.strokeColor,
    Boolean(route.fallbackPath && route.fallbackPath.length >= 2),
  ]);

  return null;
}

export function GoogleMapEngine<T extends MapPoint = MapPoint>(p: SharedEngineProps<T>) {
  const { lang } = useI18n();
  const crosshairRef = useRef(p.onCrosshairMove);
  crosshairRef.current = p.onCrosshairMove;
  const viewportRef = useRef(p.onViewportChange);
  viewportRef.current = p.onViewportChange;
  const dragRef = useRef(p.onDraggingChange);
  dragRef.current = p.onDraggingChange;
  const userPanRef = useRef(p.onUserPan);
  userPanRef.current = p.onUserPan;
  const [googleDirActive, setGoogleDirActive] = useState(false);

  const mapTypeId = p.surface === 'hybrid' ? 'hybrid' : 'roadmap';
  const colorScheme = p.surface === 'dark' ? ColorScheme.DARK : ColorScheme.LIGHT;

  const arterialPaths = useMemo(
    () =>
      p.showArterials
        ? ARTERIAL_ROADS.map((road) => ({
            name: road.name,
            path: road.points.map(([lat, lng]) => ({ lat, lng })),
          }))
        : [],
    [p.showArterials],
  );

  return (
    <div
      className="h-full w-full"
      onWheel={() => userPanRef.current?.()}
      onTouchStart={(ev) => {
        if (ev.touches.length >= 2) userPanRef.current?.();
      }}
    >
      <APIProvider
        apiKey={GOOGLE_MAPS_API_KEY}
        language={lang === 'en' ? 'en' : 'vi'}
        region="VN"
        libraries={GOOGLE_LIBRARIES}
        onError={(err) => {
          console.warn('[GoogleMaps] Lỗi nạp script, chuyển sang MapLibre dự phòng:', err);
          markGoogleMapsFailed('api_provider_error');
        }}
      >
        <ApiHealthMonitor />
        <GoogleMap
          id={p.id}
          reuseMaps
          mapId={GOOGLE_MAPS_MAP_ID}
          defaultCenter={p.initialCenter ?? DONG_NAI_DEFAULT_CENTER}
          defaultZoom={p.initialZoom}
          mapTypeId={mapTypeId}
          colorScheme={colorScheme}
          gestureHandling="greedy"
          disableDefaultUI
          scaleControl
          clickableIcons={!p.crosshairActive}
          minZoom={7}
          maxZoom={20}
          restriction={{
            latLngBounds: DONG_NAI_CAMERA_RESTRICTION,
            strictBounds: false,
          }}
          className="h-full w-full"
          onDragstart={() => {
            dragRef.current?.(true);
            userPanRef.current?.();
          }}
          onIdle={(ev) => {
            dragRef.current?.(false);
            const m = ev.map;
            const c = m.getCenter();
            if (p.crosshairActive && c) {
              crosshairRef.current?.(c.lat(), c.lng());
            }
            const b = m.getBounds();
            if (b && viewportRef.current) {
              const ne = b.getNorthEast();
              const sw = b.getSouthWest();
              viewportRef.current({
                minLng: sw.lng(),
                minLat: sw.lat(),
                maxLng: ne.lng(),
                maxLat: ne.lat(),
              });
            }
          }}
          onClick={(ev) => {
            if (p.crosshairActive && ev.detail.latLng) {
              ev.map.panTo(ev.detail.latLng);
              if ((ev.map.getZoom() ?? 12) < 14) {
                ev.map.setZoom(15);
              }
            }
          }}
        >
          <GoogleCameraController
            mapId={p.id}
            reports={p.reports}
            fitCityOnMount={p.fitCityOnMount}
            fitPointsOnMount={p.fitPointsOnMount}
            cameraCommand={p.cameraCommand}
            autoFollow={p.autoFollow}
            userPos={p.userPos}
            followPadding={p.followPadding}
            routeOverlay={p.routeOverlay}
            fitRouteSeq={p.fitRouteSeq}
          />

          {p.mode === 'pins' ? (
            <GoogleClusteredPins
              mapId={p.id}
              reports={p.reports}
              activeDestinationId={p.activeDestinationId}
              onSelect={p.onSelect}
            />
          ) : (
            <GoogleHeatmapLayer mapId={p.id} reports={p.reports} />
          )}

          {arterialPaths.map((r) => (
            <Polyline
              key={r.name}
              path={r.path}
              strokeColor="#F59E0B"
              strokeOpacity={0.68}
              strokeWeight={2.6}
              clickable={false}
            />
          ))}

          {p.userPos && p.radiusM && p.radiusM > 0 && (
            <Circle
              center={p.userPos}
              radius={p.radiusM}
              strokeColor="#0B57D0"
              strokeOpacity={0.75}
              strokeWeight={1.5}
              fillColor="#0B57D0"
              fillOpacity={0.06}
              clickable={false}
            />
          )}

          <GoogleSmoothUserPuck
            mapId={p.id}
            userPos={p.userPos}
            userHeadingDeg={p.userHeadingDeg}
            navigationMode={p.navigationMode}
            accuracyM={p.accuracyM}
          />

          {p.draggablePin && (
            <AdvancedMarker
              position={{ lat: p.draggablePin.lat, lng: p.draggablePin.lng }}
              draggable
              zIndex={980}
              title="Kéo thả ghim để chỉnh vị trí chính xác"
              onDragEnd={(ev) => {
                const ll = ev.latLng;
                if (ll) p.draggablePin?.onDragEnd(ll.lat(), ll.lng());
              }}
            >
              <div className="flex flex-col items-center">
                <div className="grid h-10 w-10 place-items-center rounded-full border-2 border-white bg-rose-600 text-xs font-extrabold text-white shadow-lift">
                  SOS
                </div>
                <div className="h-3 w-1 rounded-b-full bg-rose-600 shadow" />
              </div>
            </AdvancedMarker>
          )}

          {p.routeOverlay && (
            <>
              <GoogleDirectionsLayer
                mapId={p.id}
                route={p.routeOverlay}
                onDirectionsActive={setGoogleDirActive}
              />
              {!googleDirActive && p.routeOverlay.fallbackPath && p.routeOverlay.fallbackPath.length >= 2 && (
                <>
                  <Polyline
                    path={p.routeOverlay.fallbackPath}
                    strokeColor="#ffffff"
                    strokeOpacity={0.95}
                    strokeWeight={10}
                    zIndex={418}
                    clickable={false}
                  />
                  <Polyline
                    path={p.routeOverlay.fallbackPath}
                    strokeColor={p.routeOverlay.strokeColor ?? '#1A73E8'}
                    strokeOpacity={0.98}
                    strokeWeight={6.5}
                    zIndex={420}
                    clickable={false}
                  />
                </>
              )}
            </>
          )}
        </GoogleMap>
      </APIProvider>
    </div>
  );
}
