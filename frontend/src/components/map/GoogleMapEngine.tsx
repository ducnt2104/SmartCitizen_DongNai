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
import { useEffect, useMemo, useRef } from 'react';
import { ARTERIAL_ROADS } from '@shared/geo';
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

export interface CameraCommand {
  seq: number;
  kind: 'flyTo' | 'fitCity' | 'fitPoints' | 'zoomDelta';
  lat?: number;
  lng?: number;
  zoom?: number;
  delta?: number;
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
  accuracyM?: number | null;
  radiusM?: number | null;
  showArterials?: boolean;
  onSelect?: (r: T) => void;
  onViewportChange?: (bbox: MapBbox) => void;
  crosshairActive?: boolean;
  onCrosshairMove?: (lat: number, lng: number) => void;
  onDraggingChange?: (dragging: boolean) => void;
}

const GOOGLE_LIBRARIES = ['places', 'geocoding', 'marker'];

/** Bảng màu chuẩn 256 mức cho Canvas Heatmap (tương thích vĩnh viễn với Google Maps v3.67+ không phụ thuộc visualization cũ). */
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

/** Giám sát trạng thái tải Google Maps API — nếu lỗi xác thực/mạng hoặc quá 8s thì chuyển ngay sang MapLibre. */
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

/** Bộ điều khiển Camera mệnh lệnh (Imperative) — tránh hoàn toàn hiện tượng giật tâm ngắm khi kéo tay 60FPS. */
function GoogleCameraController<T extends MapPoint>({
  mapId,
  reports,
  fitCityOnMount,
  fitPointsOnMount,
  cameraCommand,
}: {
  mapId: string;
  reports: T[];
  fitCityOnMount?: boolean;
  fitPointsOnMount?: boolean;
  cameraCommand?: CameraCommand | null;
}) {
  const map = useMap(mapId);
  const mountedFitRef = useRef(false);
  const lastSeqRef = useRef(0);

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
      map.panTo({ lat: cameraCommand.lat, lng: cameraCommand.lng });
      if (typeof cameraCommand.zoom === 'number') {
        map.setZoom(cameraCommand.zoom);
      }
    } else if (cameraCommand.kind === 'zoomDelta' && typeof cameraCommand.delta === 'number') {
      map.setZoom(Math.min(20, Math.max(7, (map.getZoom() ?? 12) + cameraCommand.delta)));
    }
  }, [map, cameraCommand, reports]);

  return null;
}

/** Lớp Marker Clustering hiệu năng cao dùng `@googlemaps/markerclusterer` + `AdvancedMarkerElement`. */
function GoogleClusteredPins<T extends MapPoint>({
  mapId,
  reports,
  onSelect,
}: {
  mapId: string;
  reports: T[];
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
      const el = createIncidentPinElement(r, () => selectRef.current?.(r));
      const adv = new markerLib.AdvancedMarkerElement({
        position: { lat: r.lat, lng: r.lng },
        content: el,
        title: r.title,
        zIndex: r.emergencyLevel === 1 ? 900 : r.priority === 'high' ? 600 : 300,
      });
      stateMap.set(adv, getPinState(r));
      const l = adv.addListener('gmp-click', () => selectRef.current?.(r));
      clickListeners.push(l);
      createdMarkers.push(adv);
    }

    clusterer.addMarkers(createdMarkers);

    return () => {
      for (const l of clickListeners) l.remove();
      clusterer.clearMarkers();
      clusterer.setMap(null);
      for (const m of createdMarkers) m.map = null;
    };
  }, [map, markerLib, reports]);

  return null;
}

/** Lớp Bản đồ nhiệt HTML5 Canvas OverlayView tốc độ cao (tương thích Google Maps API v3.67+). */
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

export function GoogleMapEngine<T extends MapPoint = MapPoint>(p: SharedEngineProps<T>) {
  const { lang } = useI18n();
  const crosshairRef = useRef(p.onCrosshairMove);
  crosshairRef.current = p.onCrosshairMove;
  const viewportRef = useRef(p.onViewportChange);
  viewportRef.current = p.onViewportChange;
  const dragRef = useRef(p.onDraggingChange);
  dragRef.current = p.onDraggingChange;

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
        onDragstart={() => dragRef.current?.(true)}
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
        />

        {p.mode === 'pins' ? (
          <GoogleClusteredPins mapId={p.id} reports={p.reports} onSelect={p.onSelect} />
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

        {p.userPos && p.accuracyM && p.accuracyM > 0 && (
          <Circle
            center={p.userPos}
            radius={p.accuracyM}
            strokeColor="#0B57D0"
            strokeOpacity={0.65}
            strokeWeight={1.5}
            fillColor="#3B82F6"
            fillOpacity={0.14}
            clickable={false}
          />
        )}

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

        {p.userPos && (
          <AdvancedMarker position={p.userPos} zIndex={950} clickable={false}>
            <div className="sc-user-dot" aria-hidden />
          </AdvancedMarker>
        )}
      </GoogleMap>
    </APIProvider>
  );
}
