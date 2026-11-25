import {
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
import { haversineMeters, inDongNaiBBox } from '@shared/geo';
import type { Category, ReportStatus, ReportSummary } from '@shared/types';
import { DONG_NAI_WARDS, QUICK_JUMP_REGIONS, WARD_BY_CODE } from '../../data/dongNaiWards';
import { useOnline, useScopedReports } from '../../db/hooks';
import { usePreciseLocation } from '../../hooks/usePreciseLocation';
import { useI18n } from '../../i18n';
import { api } from '../../lib/api';
import {
  resolvePlaceSuggestion,
  searchPlacesDongNai,
  type PlaceSuggestion,
} from '../../lib/geoClient';
import type { MapBbox, MapMode, MapPoint } from '../../lib/mapConfig';
import { CATEGORY_META } from '../../lib/meta';
import { useSettings } from '../../state/settings';
import { useToast } from '../../state/toast';
import { ReportDetail } from '../ReportDetail';
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

  const bboxAbortRef = useRef<AbortController | null>(null);
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

  // Dọn sạch request bbox đang bay khi unmount
  useEffect(() => () => bboxAbortRef.current?.abort(), []);

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
      if (embedded || externalReports || !online) return;
      bboxAbortRef.current?.abort();
      const ctrl = new AbortController();
      bboxAbortRef.current = ctrl;
      const bboxParam = `${bbox.minLng.toFixed(4)},${bbox.minLat.toFixed(4)},${bbox.maxLng.toFixed(4)},${bbox.maxLat.toFixed(4)}`;
      api<ReportSummary[]>(`/api/reports/summary?scope=${encodeURIComponent(settings.scope)}&bbox=${bboxParam}`, {
        signal: ctrl.signal,
      })
        .then((rows) => {
          if (!ctrl.signal.aborted) setBboxPoints(rows);
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
      pushCamera({ kind: 'fitCity' });
      setQuery('');
    } else {
      const code = nextScope.replace('ward:', '');
      const w = WARD_BY_CODE[code];
      if (w) {
        pushCamera({ kind: 'flyTo', lat: w.centerLat, lng: w.centerLng, zoom: 14 });
      }
    }
  };

  const handlePickSuggestion = async (item: PlaceSuggestion): Promise<void> => {
    setSearchFocused(false);
    setQuery(item.label);
    const resolved = await resolvePlaceSuggestion(item);
    if (!resolved) return;
    if (item.kind === 'ward' && item.wardCode) {
      set({ scope: `ward:${item.wardCode}` });
      pushCamera({ kind: 'flyTo', lat: resolved.lat, lng: resolved.lng, zoom: 14 });
    } else {
      if (resolved.wardCode) set({ scope: 'city' });
      pushCamera({ kind: 'flyTo', lat: resolved.lat, lng: resolved.lng, zoom: 17 });
    }
  };

  const resetAllFilters = (): void => {
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
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('map.mode')}>
          <button
            type="button"
            aria-pressed={mode === 'pins'}
            className={`btn !min-h-10 !px-3 !text-sm ${mode === 'pins' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setMode('pins')}
          >
            <Layers className="h-4 w-4" aria-hidden />
            {t('map.pins')}
          </button>
          <button
            type="button"
            aria-pressed={mode === 'heat'}
            className={`btn !min-h-10 !px-3 !text-sm ${mode === 'heat' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setMode('heat')}
          >
            <Thermometer className="h-4 w-4" aria-hidden />
            {t('map.heat')}
          </button>
          <button
            type="button"
            className="btn btn-soft !min-h-10 !px-3 !text-sm"
            disabled={gps.status === 'locating'}
            onClick={() => void locateMe()}
          >
            <MapPinned className="h-4 w-4" aria-hidden />
            {gps.status === 'locating' ? t('report.locating') : t('map.nearMe')}
          </button>
        </div>
      </div>

      {/* Floating Glass Filter Bar: Tìm địa chỉ/hẻm + Chọn nhanh 95 Phường/Xã + Chip Danh mục/Trạng thái */}
      <div className="rounded-2xl border border-line/90 bg-surface/95 p-3 shadow-card backdrop-blur-md">
        <div className="grid gap-2 md:grid-cols-[1fr_15rem_auto]">
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
                              30/04/2026
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
            className="field !min-h-11 text-sm font-medium"
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
        <div className="mt-2.5 flex items-center gap-1.5 overflow-x-auto pb-0.5" role="group" aria-label={t('map.quickRegions')}>
          <button
            type="button"
            className="chip shrink-0 !min-h-8 !text-xs"
            aria-pressed={settings.scope === 'city'}
            onClick={() => selectWardScope('city')}
          >
            <Globe2 className="h-3.5 w-3.5" aria-hidden /> {t('map.fitCity')}
          </button>
          {QUICK_JUMP_REGIONS.map((reg) => (
            <button
              key={reg.id}
              type="button"
              className="chip shrink-0 !min-h-8 !text-xs"
              onClick={() => {
                set({ scope: 'city' });
                pushCamera({ kind: 'flyTo', lat: reg.center[0], lng: reg.center[1], zoom: reg.zoom });
              }}
            >
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
          onViewportChange={onViewportChange}
          showArterials
          showFitCityButton
          tone={tone}
          className={className ?? 'h-[62dvh]'}
          ariaLabel={ariaLabel ?? t('map.aria')}
        />
      )}

      {/* Chú giải mức ưu tiên & tổng số phản ánh */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-semibold" aria-label={t('map.legend')}>
        <span className="text-muted">{filtered ? t('map.count', { n: filtered.length }) : ''}</span>
        {LEGEND_COLORS.map(([k, color, label]) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <i className="h-3 w-3 rounded-full" style={{ background: color }} />
            {t(label)}
          </span>
        ))}
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
    </div>
  );
}
