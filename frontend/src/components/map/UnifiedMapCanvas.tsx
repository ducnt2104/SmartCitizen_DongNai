import { Compass, Globe2, Layers, LocateFixed, MapPin, Maximize2, Minimize2, Minus, Plus, ShieldCheck } from 'lucide-react';
import { Suspense, useCallback, useEffect, useId, useState, type ComponentType, type ReactNode } from 'react';
import { DONG_NAI_CITY_CENTER } from '@shared/constants';
import type { CivicAlertItem } from '@shared/types';
import { useI18n } from '../../i18n';
import {
  markGoogleMapsFailed,
  useGoogleMapsAvailable,
  type MapBbox,
  type MapMode,
  type MapPoint,
  type MapSurfaceStyle,
} from '../../lib/mapConfig';
import { lazyWithRetry } from '../../utils/lazyWithRetry';
import type { CameraCommand, DraggablePinSpec, RouteOverlaySpec, SharedEngineProps } from './GoogleMapEngine';
import { MapErrorBoundary, MapSkeleton } from './MapErrorBoundary';

const LazyGoogleMapEngine = lazyWithRetry(
  () =>
    import('./GoogleMapEngine').then((m) => ({
      default: m.GoogleMapEngine as ComponentType<SharedEngineProps<MapPoint>>,
    })),
  'GoogleMapEngine',
);

const LazyMapLibreFallbackEngine = lazyWithRetry(
  () =>
    import('./MapLibreFallbackEngine').then((m) => ({
      default: m.MapLibreFallbackEngine as ComponentType<SharedEngineProps<MapPoint>>,
    })),
  'MapLibreFallbackEngine',
);

export interface UnifiedMapCanvasProps<T extends MapPoint = MapPoint> {
  reports: T[];
  mode?: MapMode;
  initialCenter?: readonly [number, number];
  initialZoom?: number;
  fitCityOnMount?: boolean;
  fitPointsOnMount?: boolean;
  cameraCommand?: CameraCommand | null;
  onRequestCamera?: (cmd: Omit<CameraCommand, 'seq'>) => void;
  userPos?: { lat: number; lng: number } | null;
  userHeadingDeg?: number | null;
  navigationMode?: boolean;
  accuracyM?: number | null;
  radiusM?: number | null;
  showArterials?: boolean;
  activeDestinationId?: string | null;
  autoFollow?: boolean;
  followPadding?: { top?: number; bottom?: number; left?: number; right?: number };
  fitRouteSeq?: number;
  onSelect?: (r: T) => void;
  onViewportChange?: (bbox: MapBbox) => void;
  onUserPan?: () => void;
  crosshairPin?: { onChange: (lat: number, lng: number) => void } | null;
  draggablePin?: DraggablePinSpec | null;
  selectedPin?: { lat: number; lng: number; label?: string } | null;
  onMapClick?: (lat: number, lng: number, labelHint?: string) => void;
  routeOverlay?: RouteOverlaySpec | null;
  alerts?: CivicAlertItem[];
  onSelectAlert?: (a: CivicAlertItem) => void;
  onWardClick?: (wardCode: string) => void;
  draftPolyline?: Array<[number, number]>;
  draftCircle?: { lat: number; lng: number; radiusM: number } | null;
  onLocate?: () => void;
  locating?: boolean;
  tone?: 'default' | 'ioc';
  className?: string;
  controlsBottomClassName?: string;
  showLayerSwitcher?: boolean;
  showFitCityButton?: boolean;
  showZoomButtons?: boolean;
  showFullscreenButton?: boolean;
  showFallbackBadge?: boolean;
  topOverlay?: ReactNode;
  bottomLeftOverlay?: ReactNode;
  ariaLabel?: string;
}

/**
 * Khung bản đồ hợp nhất:
 *  - Primary: Google Maps JavaScript API (`@vis.gl/react-google-maps` + `@googlemaps/markerclusterer`).
 *  - Zero-Crash Fallback: Tự động chuyển sang MapLibre GL JS nếu thiếu/lỗi `VITE_GOOGLE_MAPS_API_KEY`.
 */
export function UnifiedMapCanvas<T extends MapPoint = MapPoint>(p: UnifiedMapCanvasProps<T>) {
  const { t } = useI18n();
  const rawId = useId();
  const mapInstanceId = `sc-map-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const googleAvailable = useGoogleMapsAvailable();

  const [surface, setSurface] = useState<MapSurfaceStyle>('roadmap');
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [internalCmd, setInternalCmd] = useState<CameraCommand | null>(null);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const dispatchCamera = useCallback(
    (cmd: Omit<CameraCommand, 'seq'>) => {
      if (p.onRequestCamera) {
        p.onRequestCamera(cmd);
      } else {
        setInternalCmd((prev) => ({ ...cmd, seq: (prev?.seq ?? 0) + 1 }));
      }
    },
    [p.onRequestCamera],
  );

  const activeCommand = p.cameraCommand ?? internalCmd;
  const centerObj = {
    lat: p.initialCenter ? p.initialCenter[0] : DONG_NAI_CITY_CENTER[0],
    lng: p.initialCenter ? p.initialCenter[1] : DONG_NAI_CITY_CENTER[1],
  };
  const zoomVal = p.initialZoom ?? 10;
  const isDarkFrame = p.tone === 'ioc';

  const sharedProps = {
    id: mapInstanceId,
    reports: p.reports,
    mode: p.mode ?? 'pins',
    surface,
    initialCenter: centerObj,
    initialZoom: zoomVal,
    fitCityOnMount: p.fitCityOnMount,
    fitPointsOnMount: p.fitPointsOnMount,
    cameraCommand: activeCommand,
    userPos: p.userPos,
    userHeadingDeg: p.userHeadingDeg,
    navigationMode: p.navigationMode,
    accuracyM: p.accuracyM,
    radiusM: p.radiusM,
    showArterials: p.showArterials,
    activeDestinationId: p.activeDestinationId,
    autoFollow: p.autoFollow,
    followPadding: p.followPadding,
    fitRouteSeq: p.fitRouteSeq,
    onSelect: p.onSelect,
    onViewportChange: p.onViewportChange,
    crosshairActive: Boolean(p.crosshairPin),
    onCrosshairMove: p.crosshairPin?.onChange,
    onDraggingChange: setDragging,
    onUserPan: p.onUserPan,
    draggablePin: p.draggablePin,
    selectedPin: p.selectedPin,
    onMapClick: p.onMapClick,
    routeOverlay: p.routeOverlay,
    alerts: p.alerts,
    onSelectAlert: p.onSelectAlert,
    onWardClick: p.onWardClick,
    draftPolyline: p.draftPolyline,
    draftCircle: p.draftCircle,
  };

  return (
    <div
      className={`${
        expanded
          ? 'fixed inset-0 z-[90] h-[100dvh] w-[100vw] rounded-none border-0'
          : `relative overflow-hidden rounded-[1.35rem] border ${p.className ?? 'h-[58dvh]'}`
      } ${
        isDarkFrame
          ? 'border-ioc-line bg-ioc-bg shadow-[0_18px_48px_-14px_rgba(2,6,23,0.65)]'
          : 'border-line/80 bg-surface-2 shadow-[0_18px_48px_-14px_rgba(15,23,42,0.16)]'
      }`}
      role="application"
      aria-label={p.ariaLabel ?? t('map.aria')}
    >
      <MapErrorBoundary
        extraResetKey={googleAvailable ? 'google' : 'maplibre'}
        onCaughtError={() => {
          if (googleAvailable) markGoogleMapsFailed('render_exception');
        }}
      >
        <Suspense fallback={<MapSkeleton className="h-full w-full !rounded-none !border-0" />}>
          {googleAvailable ? (
            <LazyGoogleMapEngine {...(sharedProps as SharedEngineProps<MapPoint>)} />
          ) : (
            <LazyMapLibreFallbackEngine {...(sharedProps as SharedEngineProps<MapPoint>)} />
          )}
        </Suspense>
      </MapErrorBoundary>

      {/* Tâm ngắm cố định giữa màn hình kiểu Google Maps / Grab (mũi kim chạm chính xác điểm (50%, 50%) = map.getCenter()) */}
      {p.crosshairPin && (
        <div className="pointer-events-none absolute inset-0 z-[30] grid place-items-center" aria-hidden>
          <div className="relative flex items-center justify-center">
            <span className="h-2.5 w-2.5 rounded-full border-2 border-white bg-brand shadow" />
            <span
              className={`absolute h-3 w-7 rounded-full bg-slate-950/35 blur-[2px] transition-transform duration-150 ${
                dragging ? 'scale-125 opacity-40' : 'scale-90 opacity-75'
              }`}
            />
            <div
              className={`absolute bottom-1/2 left-1/2 -translate-x-1/2 transition-transform duration-150 ${
                dragging ? '-translate-y-3 scale-105' : 'translate-y-0 scale-100'
              }`}
            >
              <div className="grid h-11 w-11 place-items-center rounded-full border-[2.5px] border-white bg-brand text-white shadow-lift">
                <MapPin className="h-5 w-5" />
              </div>
              <div className="mx-auto h-3.5 w-1 rounded-b-full bg-brand shadow" />
            </div>
          </div>
        </div>
      )}

      {/* Thanh trên của bản đồ: sắp xếp thông tin GPS (trái) + bộ chuyển lớp bản đồ (phải) không chồng lấn trên mobile */}
      {(p.topOverlay || p.showLayerSwitcher !== false) && (
        <div className="pointer-events-none absolute inset-x-2.5 top-2.5 z-[35] flex flex-wrap items-start justify-between gap-1.5 sm:inset-x-3 sm:top-3">
          {p.topOverlay && <div className="pointer-events-auto max-w-full">{p.topOverlay}</div>}

          {p.showLayerSwitcher !== false && (
            <div
              className="no-scrollbar pointer-events-auto ml-auto inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-2xl border border-line/75 bg-surface/90 p-1 text-[11px] font-semibold shadow-lift backdrop-blur-xl sm:text-xs"
              role="group"
              aria-label={t('map.baseLayer')}
            >
              {(
                [
                  ['roadmap', t('map.layer.light'), Layers],
                  ['hybrid', t('map.layer.satellite'), Compass],
                ] as const
              ).map(([id, label, Icon]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={surface === id}
                  onClick={() => setSurface(id)}
                  className={`inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-xl px-2.5 transition-all sm:min-h-9 sm:px-3 ${
                    surface === id
                      ? 'bg-gradient-to-r from-brand to-brand-2 text-brand-ink shadow-sm'
                      : 'text-ink/85 hover:bg-surface-2 hover:text-ink'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="whitespace-nowrap">{label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Cụm nút điều khiển nổi bên phải (Toàn màn hình, Zoom +/-, Toàn TP. Đồng Nai, Vị trí của tôi) */}
      <div
        className={`absolute ${p.controlsBottomClassName ?? 'bottom-2.5 sm:bottom-3'} right-2.5 z-[35] flex flex-col items-end gap-2 sm:right-3`}
      >
        {p.showFullscreenButton !== false && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="grid h-9 w-9 place-items-center rounded-2xl border border-line bg-surface/95 text-ink shadow-lift backdrop-blur-sm hover:bg-surface-2 sm:h-10 sm:w-10"
            aria-label={expanded ? 'Thu gọn bản đồ' : 'Mở rộng toàn màn hình'}
            title={expanded ? 'Thu gọn bản đồ (Esc)' : 'Mở rộng toàn màn hình'}
          >
            {expanded ? <Minimize2 className="h-4 w-4 text-brand" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        )}

        {p.showZoomButtons !== false && (
          <div className="flex flex-col overflow-hidden rounded-2xl border border-line bg-surface/95 shadow-lift backdrop-blur-sm">
            <button
              type="button"
              onClick={() => dispatchCamera({ kind: 'zoomDelta', delta: 1 })}
              className="grid h-9 w-9 place-items-center border-b border-line text-ink hover:bg-surface-2 sm:h-10 sm:w-10"
              aria-label="Phóng to bản đồ"
              title="Phóng to"
            >
              <Plus className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => dispatchCamera({ kind: 'zoomDelta', delta: -1 })}
              className="grid h-9 w-9 place-items-center text-ink hover:bg-surface-2 sm:h-10 sm:w-10"
              aria-label="Thu nhỏ bản đồ"
              title="Thu nhỏ"
            >
              <Minus className="h-4 w-4" />
            </button>
          </div>
        )}

        {p.showFitCityButton && (
          <button
            type="button"
            onClick={() => dispatchCamera({ kind: 'fitCity' })}
            className="grid h-10 w-10 place-items-center rounded-full border border-line bg-surface/95 text-ink shadow-lift backdrop-blur-sm hover:bg-surface-2 sm:h-11 sm:w-11"
            aria-label={t('map.fitCity')}
            title={t('map.fitCity')}
          >
            <Globe2 className="h-5 w-5 text-brand" />
          </button>
        )}

        {p.onLocate && (
          <button
            type="button"
            onClick={p.onLocate}
            disabled={p.locating}
            className="grid h-10 w-10 place-items-center rounded-full border border-line bg-surface/95 text-brand shadow-lift backdrop-blur-sm hover:bg-surface-2 disabled:opacity-60 sm:h-11 sm:w-11"
            aria-label={t('map.locate')}
            title={t('map.locate')}
          >
            <LocateFixed className={`h-5 w-5 ${p.locating ? 'animate-spin' : ''}`} />
          </button>
        )}
      </div>

      {/* Nhãn nhỏ tinh tế báo hiệu chế độ dự phòng Vector khi chưa cấu hình VITE_GOOGLE_MAPS_API_KEY */}
      {!googleAvailable && p.showFallbackBadge !== false && (
        <div
          title={t('map.fallbackHint')}
          className="pointer-events-auto absolute bottom-2.5 left-2.5 z-[32] inline-flex items-center gap-1.5 rounded-full border border-line/80 bg-surface/90 px-2.5 py-1 text-[11px] font-semibold text-muted shadow-card backdrop-blur-sm sm:bottom-3 sm:left-3"
        >
          <ShieldCheck className="h-3.5 w-3.5 text-brand" aria-hidden />
          <span>{t('map.fallbackBadge')}</span>
        </div>
      )}

      {p.bottomLeftOverlay && (
        <div
          className={`pointer-events-none absolute left-2.5 z-[33] sm:left-3 ${
            !googleAvailable && p.showFallbackBadge !== false ? 'bottom-12' : 'bottom-2.5 sm:bottom-3'
          }`}
        >
          {p.bottomLeftOverlay}
        </div>
      )}
    </div>
  );
}
