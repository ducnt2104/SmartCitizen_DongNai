import {
  ExternalLink,
  Flame,
  Globe2,
  Layers,
  MapPin,
  MapPinned,
  Search,
  SlidersHorizontal,
  Thermometer,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { DONG_NAI_CITY_CENTER } from '@shared/constants';
import { haversineMeters, inDongNaiBBox, matchArterial, nearestWard } from '@shared/geo';
import type { Category, ReportStatus, ReportSummary } from '@shared/types';
import { DONG_NAI_WARDS, QUICK_JUMP_REGIONS, WARD_BY_CODE } from '../../data/dongNaiWards';
import { useOnline, useScopedReports } from '../../db/hooks';
import { usePreciseLocation } from '../../hooks/usePreciseLocation';
import { useI18n } from '../../i18n';
import { api } from '../../lib/api';
import { getSwrEntry, setSwrEntry } from '../../lib/swrCache';
import {
  resolvePlaceSuggestion,
  reverseGeocode,
  searchPlacesDongNai,
  type PlaceSuggestion,
} from '../../lib/geoClient';
import { googleMapsPlaceUrl, type MapBbox, type MapMode, type MapPoint } from '../../lib/mapConfig';
import { CATEGORY_META } from '../../lib/meta';
import { useSettings } from '../../state/settings';
import { useToast } from '../../state/toast';
import { ReportDetail } from '../ReportDetail';
import { WardInspectorDrawer } from '../WardInspectorDrawer';
import { EmptyState, SkeletonBlock } from '../ui';
import type { CameraCommand } from './GoogleMapEngine';
import { UnifiedMapCanvas } from './UnifiedMapCanvas';

const CATS: Category[] = ['rac_thai', 'den_duong', 'ngap_nuoc', 'mat_duong', 'khac'];
const WARDS_PHUONG = DONG_NAI_WARDS.filter((w) => w.kind === 'Phường');
const WARDS_XA = DONG_NAI_WARDS.filter((w) => w.kind === 'Xã');

const STATUS_FILTERS: Array<{
  v: ReportStatus | 'all';
  k: 'map.statusAll' | 'status.received' | 'status.processing' | 'status.resolved';
}> = [
  { v: 'all', k: 'map.statusAll' },
  { v: 'received', k: 'status.received' },
  { v: 'processing', k: 'status.processing' },
  { v: 'resolved', k: 'status.resolved' },
];

const RADII: Array<{ v: number | null; k: 'r500' | 'r1k' | 'r5k' | 'rall' }> = [
  { v: 500, k: 'r500' },
  { v: 1000, k: 'r1k' },
  { v: 5000, k: 'r5k' },
  { v: null, k: 'rall' },
];

interface InspectedSpot {
  lat: number;
  lng: number;
  label: string;
  address: string;
  wardCode?: string;
  wardName?: string;
  arterialName?: string;
  loading?: boolean;
}

interface LiveZoomAddress {
  lat: number;
  lng: number;
  zoom: number;
  address: string;
  wardName?: string;
  loading?: boolean;
}

const REGION_DOT_COLOR: Record<string, string> = {
  trung_tam: '#2563EB',
  nam_san_bay_cang: '#0891B2',
  dong_xuan_loc: '#D97706',
  dong_bac_cat_tien: '#059669',
  bac_dong_nai: '#6366F1',
};

const LEGEND_COLORS = [
  ['emergency', '#E11D48', 'legend.emergency'],
  ['high', '#D97706', 'legend.high'],
  ['open', '#0B57D0', 'legend.open'],
  ['resolved', '#059669', 'legend.resolved'],
] as const;

export interface CityIncidentMapProps<T extends MapPoint = MapPoint> {
  /** Nếu truyền `externalReports` (ví dụ từ IOC Admin hoặc Volunteer), hiển thị bộ điểm này thay cho bộ tự nạp. */
  externalReports?: T[];
  /** Chế độ rút gọn cho khung nhúng trong IOC Dashboard hoặc Volunteer Tasks */
  embedded?: boolean;
  defaultMode?: MapMode;
  tone?: 'default' | 'ioc';
  fitPointsOnMount?: boolean;
  className?: string;
  onSelectPoint?: (r: T) => void;
  ariaLabel?: string;
}

/**
 * Component Bản đồ Khám phá & Điều phối Sự cố Toàn Thành phố Đồng Nai (`CityIncidentMap`):
 * - Bao phủ trọn vẹn 95 ĐVHC (33 Phường, 62 Xã).
 * - Floating Glass Filter Bar: tìm địa chỉ/con hẻm + lọc nhanh 95 Phường/Xã + chip danh mục/trạng thái/bán kính.
 * - Tự bay đến vị trí người dùng nếu đã cấp quyền GPS; ngược lại `fitBounds` toàn Thành phố Đồng Nai.
 * - Khi bấm vào ghim: mở mượt Bottom Sheet (Mobile) / Slide-over Drawer (Desktop).
 */
export function CityIncidentMap<T extends MapPoint = MapPoint>({
  externalReports,
  embedded = false,
  defaultMode = 'pins',
  tone = 'default',
  fitPointsOnMount = false,
  className,
  onSelectPoint,
  ariaLabel,
}: CityIncidentMapProps<T>) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const online = useOnline();
  const { settings, set } = useSettings();
  const localReports = useScopedReports(settings.scope);
  const gps = usePreciseLocation();

  const [mode, setMode] = useState<MapMode>(defaultMode);
  const [cats, setCats] = useState<Category[]>([]);
  const [statusFilter, setStatusFilter] = useState<ReportStatus | 'all'>('all');
  const [radius, setRadius] = useState<number | null>(null);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [searchFocused, setSearchFocused] = useState(false);
  const [bboxPoints, setBboxPoints] = useState<ReportSummary[] | null>(null);
  const [cameraCmd, setCameraCmd] = useState<CameraCommand | null>(null);
  const [inspectedSpot, setInspectedSpot] = useState<InspectedSpot | null>(null);
  const [liveAddress, setLiveAddress] = useState<LiveZoomAddress | null>(null);
  const [inspectorWardCode, setInspectorWardCode] = useState<string | null>(null);

  const bboxAbortRef = useRef<AbortController | null>(null);
  const inspectAbortRef = useRef<AbortController | null>(null);
  const liveGeoAbortRef = useRef<AbortController | null>(null);
  const liveGeoTimerRef = useRef<number | null>(null);
  const liveGeoCacheRef = useRef<Map<string, { address: string; wardName?: string }>>(new Map());
  const autoLocatedRef = useRef(false);

  const pushCamera = useCallback((cmd: Omit<CameraCommand, 'seq'>) => {
    setCameraCmd((prev) => ({ ...cmd, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

  useEffect(() => {
    setMode(defaultMode);
  }, [defaultMode]);

  // Nếu người dùng ĐÃ cấp quyền GPS trước đó -> tự động định vị và bay mượt về vị trí người dùng (nếu thuộc TP. Đồng Nai)
  useEffect(() => {
    if (embedded || autoLocatedRef.current) return;
    autoLocatedRef.current = true;
    if (settings.scope !== 'city' || typeof navigator === 'undefined' || !navigator.permissions?.query) return;

    let cancelled = false;
    navigator.permissions
      .query({ name: 'geolocation' as PermissionName })
      .then(async (perm) => {
        if (cancelled || perm.state !== 'granted') return;
        const f = await gps.locate();
        if (!cancelled && f && inDongNaiBBox(f.lat, f.lng)) {
          pushCamera({ kind: 'flyTo', lat: f.lat, lng: f.lng, zoom: 14 });
        }
      })
      .catch(() => {
        /* Giữ nguyên chế độ fitBounds toàn TP. Đồng Nai */
      });

    return () => {
      cancelled = true;
    };
  }, [embedded, gps, pushCamera, settings.scope]);

  // Dọn sạch request bbox & reverse-geocode đang bay khi unmount
  useEffect(
    () => () => {
      bboxAbortRef.current?.abort();
      inspectAbortRef.current?.abort();
      liveGeoAbortRef.current?.abort();
      if (liveGeoTimerRef.current !== null) window.clearTimeout(liveGeoTimerRef.current);
    },
    [],
  );

  // Autocomplete Địa chỉ + 95 Phường/Xã có debounce 250ms & AbortController
  useEffect(() => {
    if (embedded) return;
    const q = query.trim();
    if (!q) {
      setSuggestions([]);
      return;
    }
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      void searchPlacesDongNai(q, ctrl.signal).then((items) => {
        if (!ctrl.signal.aborted) setSuggestions(items);
      });
    }, 220);
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [query, embedded]);

  const onViewportChange = useCallback(
    (bbox: MapBbox) => {
      // Cập nhật thanh địa chỉ chi tiết trực tiếp khi người dùng phóng to (zoom >= 14.5) ở bất kỳ vị trí nào
      if (!embedded && typeof bbox.zoom === 'number' && typeof bbox.centerLat === 'number' && typeof bbox.centerLng === 'number') {
        if (bbox.zoom < 14.5) {
          liveGeoAbortRef.current?.abort();
          if (liveGeoTimerRef.current !== null) {
            window.clearTimeout(liveGeoTimerRef.current);
            liveGeoTimerRef.current = null;
          }
          setLiveAddress(null);
        } else {
          const lat = bbox.centerLat;
          const lng = bbox.centerLng;
          const z = bbox.zoom;
          const gridKey = `${lat.toFixed(4)}:${lng.toFixed(4)}`;
          const cachedAddr = liveGeoCacheRef.current.get(gridKey);
          if (cachedAddr) {
            liveGeoAbortRef.current?.abort();
            if (liveGeoTimerRef.current !== null) {
              window.clearTimeout(liveGeoTimerRef.current);
              liveGeoTimerRef.current = null;
            }
            setLiveAddress({ lat, lng, zoom: z, address: cachedAddr.address, wardName: cachedAddr.wardName, loading: false });
          } else {
            setLiveAddress((prev) => ({
              lat,
              lng,
              zoom: z,
              address: bbox.localHint || prev?.address || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
              wardName: prev?.wardName,
              loading: true,
            }));
            if (liveGeoTimerRef.current !== null) window.clearTimeout(liveGeoTimerRef.current);
            liveGeoTimerRef.current = window.setTimeout(() => {
              liveGeoAbortRef.current?.abort();
              const ctrl = new AbortController();
              liveGeoAbortRef.current = ctrl;
              void reverseGeocode(lat, lng, ctrl.signal)
                .then((res) => {
                  if (ctrl.signal.aborted) return;
                  const niceAddr =
                    res.source === 'out_of_bounds'
                      ? bbox.localHint || `${lat.toFixed(5)}, ${lng.toFixed(5)}`
                      : res.address;
                  const entry = { address: niceAddr, wardName: res.wardName ?? undefined };
                  if (liveGeoCacheRef.current.size > 120) liveGeoCacheRef.current.clear();
                  liveGeoCacheRef.current.set(gridKey, entry);
                  setLiveAddress({ lat, lng, zoom: z, address: entry.address, wardName: entry.wardName, loading: false });
                })
                .catch(() => {
                  if (ctrl.signal.aborted) return;
                  setLiveAddress((prev) => (prev ? { ...prev, loading: false } : null));
                });
            }, 520);
          }
        }
      }

      if (embedded || externalReports || !online) return;
      bboxAbortRef.current?.abort();
      const bboxParam = `${bbox.minLng.toFixed(4)},${bbox.minLat.toFixed(4)},${bbox.maxLng.toFixed(4)},${bbox.maxLat.toFixed(4)}`;
      const cacheKey = `map:${settings.scope}:${bboxParam}`;
      const cached = getSwrEntry<ReportSummary[]>(cacheKey);
      if (cached) {
        setBboxPoints(cached.data);
        if (!cached.isStale) return;
      }
      const ctrl = new AbortController();
      bboxAbortRef.current = ctrl;
      api<ReportSummary[]>(`/api/incidents/map?scope=${encodeURIComponent(settings.scope)}&bbox=${bboxParam}`, {
        signal: ctrl.signal,
      })
        .then((rows) => {
          if (!ctrl.signal.aborted) {
            setSwrEntry(cacheKey, rows, 15_000);
            setBboxPoints(rows);
          }
        })
        .catch(() => {
          /* Giữ bản lưu IndexedDB cục bộ */
        });
    },
    [embedded, externalReports, online, settings.scope],
  );

  const sourcePoints = useMemo<T[] | undefined>(() => {
    if (externalReports) return externalReports;
    if (online && bboxPoints && bboxPoints.length > 0) return bboxPoints as unknown as T[];
    return localReports as unknown as T[] | undefined;
  }, [externalReports, online, bboxPoints, localReports]);

  const filtered = useMemo<T[] | undefined>(() => {
    if (!sourcePoints) return undefined;
    if (embedded) return sourcePoints;
    return sourcePoints.filter((r) => {
      if (r.status === 'rejected' || r.status === 'quarantined') return false;
      if (cats.length && !cats.includes(r.category)) return false;
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (radius !== null && gps.fix && haversineMeters(gps.fix.lat, gps.fix.lng, r.lat, r.lng) > radius) return false;
      return true;
    });
  }, [sourcePoints, embedded, cats, statusFilter, radius, gps.fix]);

  const locateMe = async (): Promise<void> => {
    const f = await gps.locate();
    if (f) {
      pushCamera({ kind: 'flyTo', lat: f.lat, lng: f.lng, zoom: 16 });
      if (f.accuracy > 50) {
        toast('info', t('map.lowAccuracy', { m: f.accuracy }));
      }
    } else {
      toast(
        'error',
        gps.errorKind === 'denied' ? t('map.gpsDenied') : t('map.gpsError'),
        t('map.gpsFallbackHint'),
      );
    }
  };

  const selectWardScope = (nextScope: string): void => {
    set({ scope: nextScope });
    if (nextScope === 'city') {
      inspectAbortRef.current?.abort();
      setInspectedSpot(null);
      setInspectorWardCode(null);
      pushCamera({ kind: 'fitCity' });
      setQuery('');
    } else {
      const code = nextScope.replace('ward:', '');
      const w = WARD_BY_CODE[code];
      if (w) {
        pushCamera({ kind: 'flyTo', lat: w.centerLat, lng: w.centerLng, zoom: 14 });
        setInspectorWardCode(w.wardCode);
      }
    }
  };

  const inspectLocation = useCallback(
    async (lat: number, lng: number, labelHint?: string, zoomTo?: number): Promise<void> => {
      inspectAbortRef.current?.abort();
      const ctrl = new AbortController();
      inspectAbortRef.current = ctrl;

      const inBounds = inDongNaiBBox(lat, lng);
      const arterial = inBounds ? matchArterial(lat, lng, 80) : null;
      const fallbackW = inBounds ? nearestWard(lat, lng) : null;
      setInspectedSpot({
        lat,
        lng,
        label: labelHint ?? 'Đang dò địa chỉ chi tiết…',
        address: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        wardCode: fallbackW?.wardCode,
        wardName: fallbackW?.name,
        arterialName: arterial?.name,
        loading: true,
      });

      if (typeof zoomTo === 'number') {
        pushCamera({ kind: 'flyTo', lat, lng, zoom: zoomTo });
      }

      try {
        const res = await reverseGeocode(lat, lng, ctrl.signal);
        if (ctrl.signal.aborted) return;
        const resolvedAddress =
          res.source === 'out_of_bounds'
            ? labelHint || `${lat.toFixed(6)}, ${lng.toFixed(6)}`
            : res.address;
        const firstPart = resolvedAddress.split(',')[0]?.trim();
        setInspectedSpot({
          lat,
          lng,
          label: labelHint || (firstPart && firstPart !== res.wardName ? firstPart : res.wardName ?? 'Vị trí đã chọn'),
          address: resolvedAddress,
          wardCode: res.wardCode ?? fallbackW?.wardCode,
          wardName: res.wardName ?? fallbackW?.name,
          arterialName: arterial?.name,
          loading: false,
        });
      } catch {
        if (ctrl.signal.aborted) return;
        setInspectedSpot((prev) => (prev ? { ...prev, loading: false } : null));
      }
    },
    [pushCamera],
  );

  const handlePickSuggestion = async (item: PlaceSuggestion): Promise<void> => {
    setSearchFocused(false);
    setQuery(item.label);
    const resolved = await resolvePlaceSuggestion(item);
    if (!resolved) return;
    if (item.kind === 'ward' && item.wardCode) {
      set({ scope: `ward:${item.wardCode}` });
      setInspectorWardCode(item.wardCode);
      void inspectLocation(resolved.lat, resolved.lng, item.label, 14.5);
    } else {
      if (resolved.wardCode) set({ scope: 'city' });
      void inspectLocation(resolved.lat, resolved.lng, resolved.label, 17);
    }
  };

  const resetAllFilters = (): void => {
    inspectAbortRef.current?.abort();
    setInspectedSpot(null);
    setCats([]);
    setStatusFilter('all');
    setRadius(null);
    setQuery('');
    set({ scope: 'city' });
    pushCamera({ kind: 'fitCity' });
  };

  const activeWardCode = settings.scope.startsWith('ward:') ? settings.scope.slice(5) : '';
  const initialCenter: readonly [number, number] =
    activeWardCode && WARD_BY_CODE[activeWardCode]
      ? [WARD_BY_CODE[activeWardCode].centerLat, WARD_BY_CODE[activeWardCode].centerLng]
      : DONG_NAI_CITY_CENTER;
  const initialZoom = activeWardCode ? 14 : 9;

  // Chế độ nhúng gọn cho IOC Dashboard / Tình nguyện viên
  if (embedded) {
    if (!filtered) return <SkeletonBlock className={className ?? 'h-72'} />;
    return (
      <UnifiedMapCanvas
        reports={filtered}
        mode={mode}
        initialCenter={initialCenter}
        initialZoom={initialZoom}
        fitPointsOnMount={fitPointsOnMount}
        fitCityOnMount={!fitPointsOnMount && !activeWardCode}
        cameraCommand={cameraCmd}
        onRequestCamera={pushCamera}
        onSelect={onSelectPoint}
        showArterials
        showFitCityButton
        tone={tone}
        className={className ?? 'h-72'}
        ariaLabel={ariaLabel}
      />
    );
  }

  const activeFilterCount =
    cats.length + (statusFilter !== 'all' ? 1 : 0) + (radius !== null ? 1 : 0) + (settings.scope !== 'city' ? 1 : 0);

  return (
    <div className="space-y-3">
      {/* Tiêu đề & Nút chuyển nhanh Điểm ghim / Bản đồ nhiệt / Vị trí của tôi */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-extrabold">{t('map.title')}</h1>
          <p className="text-xs font-medium text-muted">
            {t('map.subtitle95')}
            {gps.fix ? ` · GPS ±${gps.fix.accuracy}m` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('map.mode')}>
          <div className="inline-flex rounded-xl border border-line bg-surface p-0.5 shadow-sm">
            <button
              type="button"
              aria-pressed={mode === 'pins'}
              className={`btn !min-h-9 !rounded-lg !px-3 !text-xs sm:!text-sm ${mode === 'pins' ? 'btn-primary' : '!bg-transparent text-muted hover:text-ink'}`}
              onClick={() => setMode('pins')}
            >
              <Layers className="h-4 w-4" aria-hidden />
              {t('map.pins')}
            </button>
            <button
              type="button"
              aria-pressed={mode === 'heat'}
              className={`btn !min-h-9 !rounded-lg !px-3 !text-xs sm:!text-sm ${mode === 'heat' ? 'btn-primary' : '!bg-transparent text-muted hover:text-ink'}`}
              onClick={() => setMode('heat')}
            >
              <Thermometer className="h-4 w-4" aria-hidden />
              {t('map.heat')}
            </button>
          </div>
          <button
            type="button"
            className="btn btn-soft !min-h-10 !px-3 !text-xs sm:!text-sm"
            disabled={gps.status === 'locating'}
            onClick={() => void locateMe()}
          >
            <MapPinned className="h-4 w-4" aria-hidden />
            {gps.status === 'locating' ? t('report.locating') : t('map.nearMe')}
          </button>
        </div>
      </div>

      {/* Floating Glass Filter Bar: Tìm địa chỉ/hẻm + Chọn nhanh 95 Phường/Xã + Chip Danh mục/Trạng thái */}
      <div className="rounded-[1.35rem] border border-line/75 bg-surface/90 p-3.5 shadow-[0_10px_32px_-8px_rgba(15,23,42,0.08)] backdrop-blur-xl">
        <div className="grid gap-2 md:grid-cols-[1fr_20rem]">
          {/* Ô tìm kiếm Địa chỉ / Con hẻm / 95 Phường Xã */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
            <input
              type="search"
              className="field !min-h-11 !pl-9 !pr-9 text-sm"
              placeholder={t('map.searchWardPlaceholder')}
              value={query}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => window.setTimeout(() => setSearchFocused(false), 180)}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t('map.searchWardPlaceholder')}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-muted hover:bg-surface-2"
                aria-label={t('common.close')}
              >
                <X className="h-4 w-4" />
              </button>
            )}
            {searchFocused && suggestions.length > 0 && (
              <ul
                role="listbox"
                className="absolute inset-x-0 top-full z-[70] mt-1 max-h-64 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-lift"
              >
                {suggestions.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => void handlePickSuggestion(s)}
                      className="flex w-full items-start justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2"
                    >
                      <span className="flex min-w-0 items-start gap-2">
                        <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
                        <span className="min-w-0">
                          <span className="font-semibold text-ink">{s.label}</span>
                          {s.upgradedOn2026 && (
                            <span className="ml-1.5 rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-bold text-brand">
                              Phường mới
                            </span>
                          )}
                          <span className="block truncate text-[11px] text-muted">{s.sublabel}</span>
                        </span>
                      </span>
                      {s.wardCode && <span className="mono shrink-0 text-[11px] text-muted">{s.wardCode}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Bộ chọn nhanh 95 Phường/Xã (33 Phường, 62 Xã) */}
          <select
            className="field !h-11 !min-h-11 !py-0 leading-normal text-sm font-medium"
            value={settings.scope}
            onChange={(e) => selectWardScope(e.target.value)}
            aria-label={t('scope.label')}
          >
            <option value="city">{t('scope.city')}</option>
            <optgroup label={t('scope.groupPhuong')}>
              {WARDS_PHUONG.map((w) => (
                <option key={w.wardCode} value={`ward:${w.wardCode}`}>
                  {w.name}
                </option>
              ))}
            </optgroup>
            <optgroup label={t('scope.groupXa')}>
              {WARDS_XA.map((w) => (
                <option key={w.wardCode} value={`ward:${w.wardCode}`}>
                  {w.name}
                </option>
              ))}
            </optgroup>
          </select>

          {/* Nút bật/tắt bộ lọc nâng cao trên Mobile */}
          <button
            type="button"
            aria-expanded={filtersExpanded}
            onClick={() => setFiltersExpanded((v) => !v)}
            className={`btn !min-h-11 !px-3 !text-sm md:hidden ${activeFilterCount > 0 ? 'btn-soft' : 'btn-ghost'}`}
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden />
            <span>Bộ lọc{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}</span>
          </button>
        </div>

        {/* Nhảy nhanh 5 vùng toàn Thành phố Đồng Nai */}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5" role="group" aria-label={t('map.quickRegions')}>
          <button
            type="button"
            className="chip !min-h-8 !text-xs"
            aria-pressed={settings.scope === 'city'}
            onClick={() => selectWardScope('city')}
          >
            <Globe2 className="h-3.5 w-3.5" aria-hidden /> {t('map.fitCity')}
          </button>
          {QUICK_JUMP_REGIONS.map((reg) => (
            <button
              key={reg.id}
              type="button"
              className="chip !min-h-8 !text-xs"
              onClick={() => {
                set({ scope: 'city' });
                pushCamera({ kind: 'flyTo', lat: reg.center[0], lng: reg.center[1], zoom: reg.zoom });
              }}
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: REGION_DOT_COLOR[reg.id] ?? '#2563EB' }}
                aria-hidden
              />
              {lang === 'en' ? reg.labelEn : reg.labelVi}
            </button>
          ))}
        </div>

        {/* Hàng chip Danh mục + Trạng thái + Bán kính (luôn hiện trên Desktop, đóng/mở gọn trên Mobile) */}
        <div className={`mt-2.5 space-y-2 ${filtersExpanded ? 'block' : 'hidden md:block'}`}>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('map.filterCat')}>
            {CATS.map((c) => {
              const Icon = CATEGORY_META[c].icon;
              return (
                <button
                  key={c}
                  type="button"
                  className="chip !min-h-9 !text-xs"
                  aria-pressed={cats.includes(c)}
                  onClick={() => setCats((l) => (l.includes(c) ? l.filter((x) => x !== c) : [...l, c]))}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden />
                  {t(CATEGORY_META[c].labelKey)}
                </button>
              );
            })}
            <span className="mx-1 hidden h-6 w-px self-center bg-line sm:inline-block" aria-hidden />
            {STATUS_FILTERS.map((sf) => (
              <button
                key={sf.v}
                type="button"
                className="chip !min-h-9 !text-xs"
                aria-pressed={statusFilter === sf.v}
                onClick={() => setStatusFilter(sf.v)}
              >
                {t(sf.k)}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('map.radius')}>
              <span className="text-xs font-semibold text-muted">{t('map.radius')}:</span>
              {RADII.map((r) => (
                <button
                  key={r.k}
                  type="button"
                  className="chip !min-h-8 !text-xs"
                  aria-pressed={radius === r.v}
                  onClick={() => {
                    if (r.v !== null && !gps.fix) {
                      toast('info', t('map.needGps'));
                      void locateMe();
                    }
                    setRadius(r.v);
                  }}
                >
                  {t(`map.${r.k}`)}
                </button>
              ))}
            </div>
            {activeFilterCount > 0 && (
              <button type="button" onClick={resetAllFilters} className="text-xs font-semibold text-brand underline">
                {t('empty.clearFilters')}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Khung Bản đồ Chính (Google Maps Primary + MapLibre Fallback) */}
      {!filtered ? (
        <SkeletonBlock className={className ?? 'h-[62dvh]'} />
      ) : (
        <UnifiedMapCanvas
          reports={filtered}
          mode={mode}
          initialCenter={initialCenter}
          initialZoom={initialZoom}
          fitCityOnMount={settings.scope === 'city' && !gps.fix}
          cameraCommand={cameraCmd}
          onRequestCamera={pushCamera}
          userPos={gps.fix ? { lat: gps.fix.lat, lng: gps.fix.lng } : null}
          accuracyM={gps.fix?.accuracy ?? null}
          radiusM={radius}
          onSelect={(r) => {
            if (onSelectPoint) onSelectPoint(r);
            else setOpenId(r.id);
          }}
          onLocate={() => void locateMe()}
          locating={gps.status === 'locating'}
          selectedPin={inspectedSpot ? { lat: inspectedSpot.lat, lng: inspectedSpot.lng, label: inspectedSpot.label } : null}
          onMapClick={(lat, lng, labelHint) => {
            void inspectLocation(lat, lng, labelHint);
          }}
          onWardClick={(wc) => setInspectorWardCode(wc)}
          onViewportChange={onViewportChange}
          bottomLeftOverlay={
            liveAddress ? (
              <button
                type="button"
                onClick={() => void inspectLocation(liveAddress.lat, liveAddress.lng)}
                className="pointer-events-auto flex max-w-[min(78vw,28rem)] items-center gap-2 rounded-2xl border border-line/80 bg-surface/95 px-3 py-2 text-left shadow-lift backdrop-blur-xl transition-colors hover:border-brand/40"
                title="Bấm để ghim & xem chi tiết địa chỉ này"
              >
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-xl bg-brand/12 text-brand">
                  <MapPin className="h-3.5 w-3.5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[11px] font-bold text-ink">
                    <span className="truncate">{liveAddress.address}</span>
                    {liveAddress.loading && (
                      <span className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-brand" aria-hidden />
                    )}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-muted">
                    Z{liveAddress.zoom.toFixed(1)} · {liveAddress.lat.toFixed(5)}, {liveAddress.lng.toFixed(5)}
                  </span>
                </span>
              </button>
            ) : undefined
          }
          showArterials
          showFitCityButton
          tone={tone}
          className={className ?? 'h-[66dvh] min-h-[26rem]'}
          ariaLabel={ariaLabel ?? t('map.aria')}
        />
      )}

      {/* Thẻ địa chỉ chi tiết khi bấm vào bản đồ hoặc chọn kết quả tìm kiếm */}
      {inspectedSpot && (
        <div
          className="rounded-2xl border border-brand/25 bg-surface px-3.5 py-3 shadow-sm"
          role="region"
          aria-label="Địa chỉ vị trí đã chọn"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-1 items-start gap-2.5">
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-rose-500/10 text-rose-600">
                <MapPinned className="h-4 w-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="text-sm font-extrabold text-ink">{inspectedSpot.label}</p>
                  {inspectedSpot.wardName && inspectedSpot.wardName !== inspectedSpot.label && (
                    <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-bold text-brand">
                      {inspectedSpot.wardName}
                    </span>
                  )}
                  {inspectedSpot.arterialName && (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-bold text-amber-800 dark:text-amber-200">
                      {inspectedSpot.arterialName}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  {inspectedSpot.loading ? 'Đang tra cứu số nhà, tên đường…' : inspectedSpot.address}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                inspectAbortRef.current?.abort();
                setInspectedSpot(null);
              }}
              aria-label="Đóng địa chỉ đang xem"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-line/60 pt-2 pl-10">
            <p className="font-mono text-[11px] text-muted">
              {inspectedSpot.lat.toFixed(6)}, {inspectedSpot.lng.toFixed(6)}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {inspectedSpot.wardCode && (
                <button
                  type="button"
                  onClick={() => setInspectorWardCode(inspectedSpot.wardCode!)}
                  className="btn btn-primary !min-h-8 !px-3 !text-xs"
                >
                  <MapPinned className="h-3.5 w-3.5" aria-hidden />
                  Xem Hồ sơ {WARD_BY_CODE[inspectedSpot.wardCode]?.shortName ?? 'Xã/Phường'}
                </button>
              )}
              <a
                href={googleMapsPlaceUrl(inspectedSpot.lat, inspectedSpot.lng)}
                target="_blank"
                rel="noreferrer"
                className="btn btn-soft !min-h-8 !px-3 !text-xs"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                {t('map.openGoogleMaps')}
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Chú giải mức ưu tiên, ĐVHC 2 cấp & tổng số phản ánh */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 rounded-2xl border border-line/85 bg-surface/90 px-3.5 py-2.5 text-xs font-semibold shadow-sm" aria-label={t('map.legend')}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className="text-muted">{filtered ? t('map.count', { n: filtered.length }) : ''}</span>
          {LEGEND_COLORS.map(([k, color, label]) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <i className="h-3 w-3 rounded-full" style={{ background: color }} />
              {t(label)}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-bold text-muted">
          <span className="inline-flex items-center gap-1.5 text-[#0B57D0]">
            <i className="h-2.5 w-2.5 rounded-full bg-[#0B57D0]" /> 33 Phường
          </span>
          <span className="inline-flex items-center gap-1.5 text-[#0F766E]">
            <i className="h-2.5 w-2.5 rounded-full bg-[#0F766E]" /> 62 Xã
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-3.5 rounded-full bg-[#1A73E8]" /> Ranh giới 2 cấp (95 ĐVHC)
          </span>
        </div>
      </div>

      {filtered && filtered.length === 0 && (
        <div className="card">
          <EmptyState
            kind="search"
            title={t('empty.map.title')}
            text={t('empty.map.text')}
            action={
              <button type="button" className="btn btn-primary" onClick={resetAllFilters}>
                {t('empty.clearFilters')}
              </button>
            }
            secondary={
              <Link to="/report" className="btn btn-ghost">
                <Flame className="h-4 w-4" aria-hidden />
                {t('empty.reports.cta')}
              </Link>
            }
          />
        </div>
      )}

      {/* Bottom Sheet (Mobile) / Slide-over Drawer (Desktop) khi bấm vào ghim */}
      <ReportDetail id={openId} onClose={() => setOpenId(null)} variant="drawer" />
      <WardInspectorDrawer wardCode={inspectorWardCode} onClose={() => setInspectorWardCode(null)} />
    </div>
  );
}
