import { Compass, Globe2, Layers, LocateFixed, MapPin } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import { DONG_NAI_CITY_CENTER, DONG_NAI_MAP_BOUNDS } from '@shared/constants';
import { ARTERIAL_ROADS } from '@shared/geo';
import type { Category, Priority, ReportStatus } from '@shared/types';
import { useI18n } from '../i18n';
import { ensureHeat, L } from '../lib/leafletSetup';
import { useSettings } from '../state/settings';

export type MapMode = 'pins' | 'heat';
export type BaseLayerId = 'voyager' | 'dark' | 'satellite';

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
}

export interface MapBbox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export interface MapViewProps<T extends MapPoint = MapPoint> {
  reports: T[];
  mode?: MapMode;
  center?: readonly [number, number];
  zoom?: number;
  userPos?: { lat: number; lng: number } | null;
  /** Sai số GPS (mét) để vẽ vòng tròn Accuracy Circle */
  accuracyM?: number | null;
  radiusM?: number | null;
  onSelect?: (r: T) => void;
  /** Ghim kéo thả thủ công truyền thống */
  draggablePin?: { lat: number; lng: number; onChange: (lat: number, lng: number) => void } | null;
  /** Ghim cố định chính giữa màn hình kiểu Grab/Be — kéo bản đồ bên dưới để chỉnh chính xác từng mét */
  crosshairPin?: { onChange: (lat: number, lng: number) => void } | null;
  showArterials?: boolean;
  fitToReports?: boolean;
  /** Tự động căn toàn bộ địa giới Thành phố Đồng Nai (95 Phường/Xã) khi mở lần đầu */
  fitCityBounds?: boolean;
  /** Báo khung nhìn bbox hiện tại khi dừng kéo/zoom (hỗ trợ tải điểm theo khung nhìn) */
  onViewportChange?: (bbox: MapBbox) => void;
  tone?: 'default' | 'ioc';
  className?: string;
  onLocate?: () => void;
  showLayerSwitcher?: boolean;
  showFitCityButton?: boolean;
  ariaLabel?: string;
}

const BASE_LAYERS: Record<BaseLayerId, { url: string; attribution: string; maxZoom: number }> = {
  voyager: {
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    maxZoom: 20,
  },
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    maxZoom: 20,
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    maxZoom: 19,
  },
};

const STATE_COLOR = {
  emergency: '#E11D48', // Rose
  high: '#D97706', // Amber
  open: '#0B57D0', // Blue
  resolved: '#059669', // Emerald
} as const;

const STATE_RANK: Record<keyof typeof STATE_COLOR, number> = {
  resolved: 1,
  open: 2,
  high: 3,
  emergency: 4,
};

/** Biểu tượng vector sắc nét phân biệt từng nhóm sự cố bên trong ghim SVG. */
const CAT_GLYPH: Record<Category, string> = {
  rac_thai: '<path d="M12.5 12h9m-7.5 0 .6 8h5.8l.6-8m-5.5-2h4" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  den_duong: '<path d="M17 10.5a4 4 0 0 0-2.2 7.3V19h4.4v-1.2a4 4 0 0 0-2.2-7.3Zm-1.5 10.5h3" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  ngap_nuoc: '<path d="M17 10.5s-4 4.5-4 7a4 4 0 0 0 8 0c0-2.5-4-7-4-7Z" stroke="#fff" stroke-width="1.7" stroke-linejoin="round" fill="none"/>',
  mat_duong: '<path d="m17 10.5 5 9H12l5-9Zm0 3.5v2.5m0 1.8h.01" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
};

function pinState(r: MapPoint): keyof typeof STATE_COLOR {
  if (r.status === 'resolved') return 'resolved';
  if (r.emergencyLevel === 1 || r.priority === 'emergency') return 'emergency';
  if (r.priority === 'high' || r.status === 'received' || r.status === 'verifying') return 'high';
  return 'open';
}

function pinIcon(r: MapPoint): L.DivIcon {
  const state = pinState(r);
  const color = STATE_COLOR[state];
  const ring =
    state === 'emergency'
      ? '<span style="position:absolute;inset:-6px;border-radius:50%;border:3px solid #E11D48;opacity:.65;animation:pulseRing 1.6s infinite"></span>'
      : '';
  const html = `<div style="position:relative;width:34px;height:42px">${ring}<svg viewBox="0 0 34 42" width="34" height="42" style="filter:drop-shadow(0 2px 4px rgba(15,23,42,.38))"><path d="M17 1C8.7 1 2 7.5 2 15.8 2 27 17 41 17 41s15-14 15-25.2C32 7.5 25.3 1 17 1Z" fill="${color}" stroke="#fff" stroke-width="2"/>${CAT_GLYPH[r.category]}</svg></div>`;
  return L.divIcon({ html, className: 'sc-pin', iconSize: [34, 42], iconAnchor: [17, 40] });
}

/** Lớp ghim phân cụm thông minh (tô màu cụm theo mức ưu tiên cao nhất) hoặc bản đồ nhiệt. */
function ReportLayers<T extends MapPoint>({
  reports,
  mode,
  onSelect,
  fit,
  fitCity,
}: {
  reports: T[];
  mode: MapMode;
  onSelect?: (r: T) => void;
  fit: boolean;
  fitCity: boolean;
}) {
  const map = useMap();
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const fitted = useRef(false);

  useEffect(() => {
    let layer: L.Layer | null = null;
    let cancelled = false;
    if (mode === 'pins') {
      const cluster = L.markerClusterGroup({
        maxClusterRadius: 48,
        showCoverageOnHover: false,
        spiderfyOnMaxZoom: true,
        chunkedLoading: true,
        iconCreateFunction: (cl) => {
          const children = cl.getAllChildMarkers();
          let highest: keyof typeof STATE_COLOR = 'resolved';
          for (const m of children) {
            const st = (m.options as { scState?: keyof typeof STATE_COLOR }).scState ?? 'open';
            if (STATE_RANK[st] > STATE_RANK[highest]) highest = st;
          }
          const bg = STATE_COLOR[highest];
          const count = cl.getChildCount();
          const size = count >= 50 ? 46 : count >= 10 ? 40 : 34;
          return L.divIcon({
            html: `<div class="sc-cluster" style="width:${size}px;height:${size}px;background:${bg}"><span>${count}</span></div>`,
            className: 'sc-pin',
            iconSize: [size, size],
          });
        },
      });
      for (const r of reports) {
        const m = L.marker([r.lat, r.lng], {
          icon: pinIcon(r),
          keyboard: true,
          title: r.title,
          ...( { scState: pinState(r) } as Record<string, unknown> ),
        });
        m.on('click', () => selectRef.current?.(r));
        cluster.addLayer(m);
      }
      layer = cluster;
      map.addLayer(cluster);
    } else {
      ensureHeat()
        .then(() => {
          if (cancelled) return;
          const pts: Array<[number, number, number]> = reports
            .filter((r) => r.status !== 'resolved')
            .map((r) => [
              r.lat,
              r.lng,
              Math.min(1, (r.severity / 5) * (r.emergencyLevel === 1 ? 1.2 : 1) + (r.clusterCount - 1) * 0.1),
            ]);
          const heat = L.heatLayer(pts, {
            radius: 30,
            blur: 22,
            maxZoom: 15,
            minOpacity: 0.35,
            gradient: { 0.2: '#38bdf8', 0.45: '#facc15', 0.7: '#fb923c', 1: '#e11d48' },
          });
          layer = heat;
          map.addLayer(heat);
        })
        .catch((err) => console.warn('Không nạp được lớp bản đồ nhiệt:', err));
    }

    if (!fitted.current) {
      if (fit && reports.length) {
        fitted.current = true;
        const b = L.latLngBounds(reports.map((r) => [r.lat, r.lng] as [number, number]));
        if (b.isValid()) map.fitBounds(b.pad(0.12), { maxZoom: 15, animate: false });
      } else if (fitCity) {
        fitted.current = true;
        map.fitBounds(
          [
            [DONG_NAI_MAP_BOUNDS[0][0], DONG_NAI_MAP_BOUNDS[0][1]],
            [DONG_NAI_MAP_BOUNDS[1][0], DONG_NAI_MAP_BOUNDS[1][1]],
          ],
          { padding: [16, 16], animate: false },
        );
      }
    }
    return () => {
      cancelled = true;
      if (layer) map.removeLayer(layer);
    };
  }, [reports, mode, map, fit, fitCity]);
  return null;
}

function Recenter({ center, zoom }: { center?: readonly [number, number]; zoom?: number }) {
  const map = useMap();
  const key = center ? `${center[0].toFixed(5)},${center[1].toFixed(5)},${zoom ?? ''}` : '';
  useEffect(() => {
    if (center) {
      const cur = map.getCenter();
      // Tránh nhảy giật khi người dùng đang kéo bản đồ ở chế độ crosshairPin
      if (Math.hypot(cur.lat - center[0], cur.lng - center[1]) > 0.00005 || (zoom && map.getZoom() !== zoom)) {
        map.setView([center[0], center[1]], zoom ?? map.getZoom(), { animate: true });
      }
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function ViewportWatcher({ onChange }: { onChange?: (bbox: MapBbox) => void }) {
  const ref = useRef(onChange);
  ref.current = onChange;
  const map = useMap();
  const emit = (): void => {
    if (!ref.current) return;
    const b = map.getBounds();
    ref.current({
      minLng: b.getWest(),
      minLat: b.getSouth(),
      maxLng: b.getEast(),
      maxLat: b.getNorth(),
    });
  };
  useMapEvents({ moveend: emit, zoomend: emit });
  useEffect(() => {
    emit();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/** Bộ lắng nghe kéo bản đồ cho Center Crosshair Pin Picker (kiểu Grab/Be). */
function CrosshairTracker({
  onChange,
  onDragging,
}: {
  onChange: (lat: number, lng: number) => void;
  onDragging: (v: boolean) => void;
}) {
  const cbRef = useRef(onChange);
  cbRef.current = onChange;
  const map = useMap();
  useMapEvents({
    movestart: () => onDragging(true),
    moveend: () => {
      onDragging(false);
      const c = map.getCenter();
      cbRef.current(c.lat, c.lng);
    },
    click: (e) => {
      map.panTo(e.latlng, { animate: true });
    },
  });
  return null;
}

function DraggablePin({ pin }: { pin: NonNullable<MapViewProps['draggablePin']> }) {
  const map = useMap();
  useMapEvents({ click: (e) => pin.onChange(e.latlng.lat, e.latlng.lng) });
  useEffect(() => {
    const icon = L.divIcon({
      html: '<div style="width:40px;height:48px"><svg viewBox="0 0 34 42" width="40" height="48"><path d="M17 1C8.7 1 2 7.5 2 15.8 2 27 17 41 17 41s15-14 15-25.2C32 7.5 25.3 1 17 1Z" fill="#F59E0B" stroke="#fff" stroke-width="2"/><circle cx="17" cy="16" r="6" fill="#fff"/></svg></div>',
      className: 'sc-pin',
      iconSize: [40, 48],
      iconAnchor: [20, 46],
    });
    const m = L.marker([pin.lat, pin.lng], { draggable: true, icon, keyboard: true, title: 'Pin' }).addTo(map);
    m.on('dragend', () => {
      const p = m.getLatLng();
      pin.onChange(p.lat, p.lng);
    });
    return () => {
      m.remove();
    };
  }, [pin.lat, pin.lng, map]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function Extras({
  userPos,
  accuracyM,
  radiusM,
  showArterials,
}: Pick<MapViewProps, 'userPos' | 'accuracyM' | 'radiusM' | 'showArterials'>) {
  const map = useMap();
  useEffect(() => {
    const layers: L.Layer[] = [];
    if (showArterials) {
      for (const road of ARTERIAL_ROADS) {
        layers.push(
          L.polyline(
            road.points.map((p) => [p[0], p[1]] as [number, number]),
            { color: '#F59E0B', weight: 2.5, opacity: 0.6, dashArray: '6 6' },
          ).bindTooltip(road.name, { sticky: true }),
        );
      }
    }
    if (userPos) {
      if (accuracyM && accuracyM > 0) {
        layers.push(
          L.circle([userPos.lat, userPos.lng], {
            radius: accuracyM,
            color: '#0B57D0',
            weight: 1.5,
            dashArray: '4 4',
            fillColor: '#3B82F6',
            fillOpacity: 0.14,
          }),
        );
      }
      layers.push(
        L.circleMarker([userPos.lat, userPos.lng], {
          radius: 7,
          color: '#fff',
          weight: 3,
          fillColor: '#0B57D0',
          fillOpacity: 1,
        }),
      );
      if (radiusM) {
        layers.push(L.circle([userPos.lat, userPos.lng], { radius: radiusM, color: '#0B57D0', weight: 1.5, fillOpacity: 0.06 }));
      }
    }
    layers.forEach((l) => l.addTo(map));
    return () => layers.forEach((l) => l.remove());
  }, [map, userPos, accuracyM, radiusM, showArterials]);
  return null;
}

function FitCityControl({ label }: { label: string }) {
  const map = useMap();
  return (
    <button
      type="button"
      onClick={() =>
        map.fitBounds(
          [
            [DONG_NAI_MAP_BOUNDS[0][0], DONG_NAI_MAP_BOUNDS[0][1]],
            [DONG_NAI_MAP_BOUNDS[1][0], DONG_NAI_MAP_BOUNDS[1][1]],
          ],
          { padding: [20, 20], animate: true },
        )
      }
      className="absolute bottom-[4.5rem] right-3 z-[500] grid h-11 w-11 place-items-center rounded-full border border-line bg-surface/95 text-ink shadow-lift backdrop-blur-sm hover:bg-surface-2"
      aria-label={label}
      title={label}
    >
      <Globe2 className="h-5 w-5 text-brand" />
    </button>
  );
}

export function MapView<T extends MapPoint = MapPoint>(p: MapViewProps<T>) {
  const { t } = useI18n();
  const { settings } = useSettings();
  const defaultLayer: BaseLayerId = p.tone === 'ioc' || settings.mode === 'dark' ? 'dark' : 'voyager';
  const [baseLayer, setBaseLayer] = useState<BaseLayerId>(defaultLayer);
  const [tilesFailed, setTilesFailed] = useState(false);
  const [draggingCrosshair, setDraggingCrosshair] = useState(false);

  // Tự đồng bộ lớp nền khi người dùng đổi Sáng/Tối (trừ khi đã chọn Vệ tinh)
  useEffect(() => {
    setBaseLayer((cur) => (cur === 'satellite' ? 'satellite' : p.tone === 'ioc' || settings.mode === 'dark' ? 'dark' : 'voyager'));
  }, [p.tone, settings.mode]);

  const center = useMemo<[number, number]>(
    () => (p.center ? [p.center[0], p.center[1]] : [DONG_NAI_CITY_CENTER[0], DONG_NAI_CITY_CENTER[1]]),
    [p.center],
  );
  const tile = BASE_LAYERS[baseLayer];
  const isDarkMap = baseLayer === 'dark' || p.tone === 'ioc';

  return (
    <div
      className={`relative overflow-hidden rounded-2xl border ${isDarkMap ? 'border-ioc-line bg-ioc-bg' : 'border-line bg-surface-2'} ${p.className ?? 'h-[58dvh]'}`}
      role="application"
      aria-label={p.ariaLabel ?? t('map.aria')}
    >
      <MapContainer center={center} zoom={p.zoom ?? 10} scrollWheelZoom className="h-full w-full">
        <TileLayer
          key={baseLayer}
          attribution={tile.attribution}
          url={tile.url}
          maxZoom={tile.maxZoom}
          eventHandlers={{ tileerror: () => setTilesFailed(true), tileload: () => setTilesFailed(false) }}
        />
        <ReportLayers
          reports={p.reports}
          mode={p.mode ?? 'pins'}
          onSelect={p.onSelect}
          fit={p.fitToReports ?? false}
          fitCity={p.fitCityBounds ?? false}
        />
        <Recenter center={p.center} zoom={p.zoom} />
        <ViewportWatcher onChange={p.onViewportChange} />
        <Extras userPos={p.userPos} accuracyM={p.accuracyM} radiusM={p.radiusM} showArterials={p.showArterials} />
        {p.draggablePin && <DraggablePin pin={p.draggablePin} />}
        {p.crosshairPin && <CrosshairTracker onChange={p.crosshairPin.onChange} onDragging={setDraggingCrosshair} />}
        {p.showFitCityButton && <FitCityControl label={t('map.fitCity')} />}
      </MapContainer>

      {/* Center Crosshair Pin Picker kiểu Grab/Be */}
      {p.crosshairPin && (
        <div className="pointer-events-none absolute inset-0 z-[480] grid place-items-center" aria-hidden>
          <div className="relative -translate-y-5">
            <span
              className={`absolute left-1/2 top-10 h-2.5 w-6 -translate-x-1/2 rounded-full bg-slate-950/35 blur-[2px] transition-transform duration-150 ${draggingCrosshair ? 'scale-125 opacity-45' : 'scale-100 opacity-75'}`}
            />
            <div className={`transition-transform duration-150 ${draggingCrosshair ? '-translate-y-2.5 scale-105' : 'translate-y-0 scale-100'}`}>
              <div className="grid h-10 w-10 place-items-center rounded-full border-2 border-white bg-brand text-white shadow-lift">
                <MapPin className="h-5 w-5" />
              </div>
              <div className="mx-auto h-3 w-1 rounded-b bg-brand shadow" />
            </div>
          </div>
        </div>
      )}

      {/* Bộ chuyển lớp nền (Light Voyager / Dark Matter / Esri Satellite) */}
      {p.showLayerSwitcher !== false && (
        <div
          className="absolute right-3 top-3 z-[500] inline-flex items-center gap-1 rounded-xl border border-line/80 bg-surface/90 p-1 text-xs font-semibold shadow-lift backdrop-blur-md"
          role="group"
          aria-label={t('map.baseLayer')}
        >
          {(
            [
              ['voyager', t('map.layer.light')],
              ['dark', t('map.layer.dark')],
              ['satellite', t('map.layer.satellite')],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={baseLayer === id}
              onClick={() => setBaseLayer(id)}
              className={`min-h-8 rounded-lg px-2.5 transition-colors ${
                baseLayer === id ? 'bg-brand text-brand-ink' : 'text-ink hover:bg-surface-2'
              }`}
            >
              {id === 'satellite' ? <Compass className="mr-1 inline h-3.5 w-3.5" aria-hidden /> : id === 'voyager' ? <Layers className="mr-1 inline h-3.5 w-3.5" aria-hidden /> : null}
              {label}
            </button>
          ))}
        </div>
      )}

      {tilesFailed && (
        <p className="pointer-events-none absolute inset-x-3 bottom-8 z-[500] rounded-xl bg-slate-900/85 px-3 py-2 text-center text-xs font-semibold text-white">
          {t('map.tilesOffline')}
        </p>
      )}
      {p.onLocate && (
        <button
          type="button"
          onClick={p.onLocate}
          className="absolute bottom-3 right-3 z-[500] grid h-11 w-11 place-items-center rounded-full border border-line bg-surface/95 text-brand shadow-lift backdrop-blur-sm hover:bg-surface-2"
          aria-label={t('map.locate')}
          title={t('map.locate')}
        >
          <LocateFixed className="h-5 w-5" />
        </button>
      )}
    </div>
  );
}
