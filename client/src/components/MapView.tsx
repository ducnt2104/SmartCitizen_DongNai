import { LocateFixed } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import { ARTERIAL_ROADS } from '@shared/geo';
import type { ClientReport } from '@shared/types';
import { useI18n } from '../i18n';
import { ensureHeat, L } from '../lib/leafletSetup';
import { CATEGORY_META, PIN_COLOR } from '../lib/meta';

export type MapMode = 'pins' | 'heat';

export interface MapViewProps {
  reports: ClientReport[];
  mode?: MapMode;
  center?: [number, number];
  zoom?: number;
  userPos?: { lat: number; lng: number } | null;
  radiusM?: number | null;
  onSelect?: (r: ClientReport) => void;
  /** Ghim kéo thả thủ công (bước 2 báo cáo / GPS bị từ chối) */
  draggablePin?: { lat: number; lng: number; onChange: (lat: number, lng: number) => void } | null;
  showArterials?: boolean;
  fitToReports?: boolean;
  tone?: 'default' | 'ioc';
  className?: string;
  onLocate?: () => void;
  ariaLabel?: string;
}

function pinState(r: ClientReport): keyof typeof PIN_COLOR {
  if (r.status === 'resolved') return 'resolved';
  if (r.emergencyLevel === 1 || r.priority === 'emergency') return 'emergency';
  if (r.priority === 'high') return 'high';
  return 'open';
}

function pinIcon(r: ClientReport): L.DivIcon {
  const state = pinState(r);
  const color = PIN_COLOR[state];
  const cat = CATEGORY_META[r.category].color;
  const ring = state === 'emergency' ? '<span style="position:absolute;inset:-6px;border-radius:50%;border:3px solid #ef4444;opacity:.6;animation:pulseRing 1.6s infinite"></span>' : '';
  const html = `<div style="position:relative;width:34px;height:42px">${ring}<svg viewBox="0 0 34 42" width="34" height="42" style="filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))"><path d="M17 1C8.700 1 2 7.500 2 15.800 2 27 17 41 17 41s15-14 15-25.200C32 7.500 25.300 1 17 1Z" fill="${color}" stroke="#fff" stroke-width="2"/><circle cx="17" cy="16" r="7" fill="#fff"/><circle cx="17" cy="16" r="4.500" fill="${cat}"/></svg></div>`;
  return L.divIcon({ html, className: 'sc-pin', iconSize: [34, 42], iconAnchor: [17, 40] });
}

/** Lớp ghim phân cụm (markercluster) hoặc bản đồ nhiệt (leaflet.heat) — quản lý imperatively trong react-leaflet. */
function ReportLayers({ reports, mode, onSelect, fit }: { reports: ClientReport[]; mode: MapMode; onSelect?: (r: ClientReport) => void; fit: boolean }) {
  const map = useMap();
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const fitted = useRef(false);

  useEffect(() => {
    let layer: L.Layer | null = null;
    let cancelled = false;
    if (mode === 'pins') {
      const cluster = L.markerClusterGroup({ maxClusterRadius: 48, showCoverageOnHover: false, spiderfyOnMaxZoom: true });
      for (const r of reports) {
        const m = L.marker([r.lat, r.lng], { icon: pinIcon(r), keyboard: true, title: r.title });
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
            .map((r) => [r.lat, r.lng, Math.min(1, (r.severity / 5) * (r.emergencyLevel === 1 ? 1.2 : 1) + (r.clusterCount - 1) * 0.1)]);
          const heat = L.heatLayer(pts, {
            radius: 32, blur: 24, maxZoom: 15, minOpacity: 0.35,
            gradient: { 0.2: '#38bdf8', 0.45: '#facc15', 0.7: '#fb923c', 1: '#dc2626' },
          });
          layer = heat;
          map.addLayer(heat);
        })
        .catch((err) => console.warn('Không nạp được lớp bản đồ nhiệt:', err));
    }
    if (fit && reports.length && !fitted.current) {
      fitted.current = true;
      const b = L.latLngBounds(reports.map((r) => [r.lat, r.lng] as [number, number]));
      if (b.isValid()) map.fitBounds(b.pad(0.15), { maxZoom: 16, animate: false });
    }
    return () => {
      cancelled = true;
      if (layer) map.removeLayer(layer);
    };
  }, [reports, mode, map, fit]);
  return null;
}

function Recenter({ center, zoom }: { center?: [number, number]; zoom?: number }) {
  const map = useMap();
  const key = center ? `${center[0].toFixed(5)},${center[1].toFixed(5)},${zoom ?? ''}` : '';
  useEffect(() => {
    if (center) map.setView(center, zoom ?? map.getZoom(), { animate: true });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function DraggablePin({ pin }: { pin: NonNullable<MapViewProps['draggablePin']> }) {
  const map = useMap();
  const markerRef = useRef<L.Marker | null>(null);
  useMapEvents({
    click: (e) => pin.onChange(e.latlng.lat, e.latlng.lng),
  });
  useEffect(() => {
    const icon = L.divIcon({
      html: '<div style="width:40px;height:48px"><svg viewBox="0 0 34 42" width="40" height="48"><path d="M17 1C8.700 1 2 7.500 2 15.800 2 27 17 41 17 41s15-14 15-25.200C32 7.500 25.300 1 17 1Z" fill="#F59E0B" stroke="#fff" stroke-width="2"/><circle cx="17" cy="16" r="6" fill="#fff"/></svg></div>',
      className: 'sc-pin', iconSize: [40, 48], iconAnchor: [20, 46],
    });
    const m = L.marker([pin.lat, pin.lng], { draggable: true, icon, keyboard: true, title: 'Pin' }).addTo(map);
    m.on('dragend', () => {
      const p = m.getLatLng();
      pin.onChange(p.lat, p.lng);
    });
    markerRef.current = m;
    return () => {
      m.remove();
    };
    // marker được dựng lại khi toạ độ đổi từ bên ngoài
  }, [pin.lat, pin.lng, map]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function Extras({ userPos, radiusM, showArterials }: Pick<MapViewProps, 'userPos' | 'radiusM' | 'showArterials'>) {
  const map = useMap();
  useEffect(() => {
    const layers: L.Layer[] = [];
    if (showArterials) {
      for (const road of ARTERIAL_ROADS) {
        layers.push(L.polyline(road.points.map((p) => [p[0], p[1]] as [number, number]), { color: '#F59E0B', weight: 3, opacity: 0.55, dashArray: '6 6' }).bindTooltip(road.name, { sticky: true }));
      }
    }
    if (userPos) {
      layers.push(L.circleMarker([userPos.lat, userPos.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }));
      if (radiusM) layers.push(L.circle([userPos.lat, userPos.lng], { radius: radiusM, color: '#2563eb', weight: 1.500, fillOpacity: 0.07 }));
    }
    layers.forEach((l) => l.addTo(map));
    return () => layers.forEach((l) => l.remove());
  }, [map, userPos, radiusM, showArterials]);
  return null;
}

export function MapView(p: MapViewProps) {
  const { t } = useI18n();
  const [tilesFailed, setTilesFailed] = useState(false);
  const center = useMemo<[number, number]>(() => p.center ?? [10.9465, 106.8243], [p.center]);
  return (
    <div className={`relative overflow-hidden rounded-2xl border ${p.tone === 'ioc' ? 'border-ioc-line' : 'border-line'} ${p.className ?? 'h-[55dvh]'}`} role="application" aria-label={p.ariaLabel ?? t('map.aria')}>
      <MapContainer center={center} zoom={p.zoom ?? 14} scrollWheelZoom className={`h-full w-full ${p.tone === 'ioc' ? 'ioc-map' : ''}`}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={19}
          eventHandlers={{ tileerror: () => setTilesFailed(true), tileload: () => setTilesFailed(false) }}
        />
        <ReportLayers reports={p.reports} mode={p.mode ?? 'pins'} onSelect={p.onSelect} fit={p.fitToReports ?? false} />
        <Recenter center={p.center} zoom={p.zoom} />
        <Extras userPos={p.userPos} radiusM={p.radiusM} showArterials={p.showArterials} />
        {p.draggablePin && <DraggablePin pin={p.draggablePin} />}
      </MapContainer>
      {tilesFailed && (
        <p className="pointer-events-none absolute inset-x-3 bottom-8 z-[500] rounded-xl bg-slate-900/85 px-3 py-2 text-center text-xs font-semibold text-white">{t('map.tilesOffline')}</p>
      )}
      {p.onLocate && (
        <button type="button" onClick={p.onLocate} className="absolute bottom-3 right-3 z-[500] grid h-12 w-12 place-items-center rounded-full border border-line bg-surface text-brand shadow-lift" aria-label={t('map.locate')}>
          <LocateFixed className="h-6 w-6" />
        </button>
      )}
    </div>
  );
}
