import { Flame, Globe2, Layers, MapPinned, Search, Thermometer, X } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { DONG_NAI_CITY_CENTER } from '@shared/constants';
import { haversineMeters } from '@shared/geo';
import type { Category, ReportStatus, ReportSummary } from '@shared/types';
import { MapView, type MapBbox, type MapMode, type MapPoint } from '../components/MapView';
import { ReportDetail } from '../components/ReportDetail';
import { EmptyState, SkeletonBlock } from '../components/ui';
import { QUICK_JUMP_REGIONS, searchWards, WARD_BY_CODE } from '../data/dongNaiWards';
import { useOnline, useScopedReports } from '../db/hooks';
import { usePreciseLocation } from '../hooks/usePreciseLocation';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { CATEGORY_META } from '../lib/meta';
import { useSettings } from '../state/settings';
import { useToast } from '../state/toast';

const CATS: Category[] = ['rac_thai', 'den_duong', 'ngap_nuoc', 'mat_duong'];
const STATUS_FILTERS: Array<{ v: ReportStatus | 'all'; k: 'map.statusAll' | 'status.received' | 'status.processing' | 'status.resolved' }> = [
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

export default function MapPage() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const online = useOnline();
  const { settings, set } = useSettings();
  const localReports = useScopedReports(settings.scope);
  const gps = usePreciseLocation();

  const [mode, setMode] = useState<MapMode>('pins');
  const [cats, setCats] = useState<Category[]>([]);
  const [statusFilter, setStatusFilter] = useState<ReportStatus | 'all'>('all');
  const [radius, setRadius] = useState<number | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [focusView, setFocusView] = useState<{ center: [number, number]; zoom: number } | null>(null);
  const [bboxPoints, setBboxPoints] = useState<ReportSummary[] | null>(null);

  // Tải nhẹ các điểm trong khung nhìn bbox từ server khi online (giữ IndexedDB làm fallback 0ms)
  const onViewportChange = useCallback(
    (bbox: MapBbox) => {
      if (!online) return;
      const bboxParam = `${bbox.minLng.toFixed(4)},${bbox.minLat.toFixed(4)},${bbox.maxLng.toFixed(4)},${bbox.maxLat.toFixed(4)}`;
      api<ReportSummary[]>(`/api/reports/summary?scope=${encodeURIComponent(settings.scope)}&bbox=${bboxParam}`)
        .then((rows) => setBboxPoints(rows))
        .catch(() => {
          /* Giữ dữ liệu IndexedDB cục bộ */
        });
    },
    [online, settings.scope],
  );

  const sourcePoints: MapPoint[] | undefined = useMemo(() => {
    if (online && bboxPoints && bboxPoints.length > 0) return bboxPoints;
    return localReports;
  }, [online, bboxPoints, localReports]);

  const filtered = useMemo<MapPoint[] | undefined>(() => {
    if (!sourcePoints) return undefined;
    return sourcePoints.filter((r) => {
      if (r.status === 'rejected' || r.status === 'quarantined') return false;
      if (cats.length && !cats.includes(r.category)) return false;
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (radius !== null && gps.fix && haversineMeters(gps.fix.lat, gps.fix.lng, r.lat, r.lng) > radius) return false;
      return true;
    });
  }, [sourcePoints, cats, statusFilter, radius, gps.fix]);

  const wardSuggestions = useMemo(() => searchWards(query, 8), [query]);

  const locate = async (): Promise<void> => {
    const f = await gps.locate();
    if (f) {
      setFocusView({ center: [f.lat, f.lng], zoom: 15 });
      if (f.accuracy > 50) {
        toast('info', t('map.lowAccuracy', { m: f.accuracy }));
      }
    } else {
      toast('error', gps.errorKind === 'denied' ? t('map.gpsDenied') : t('map.gpsError'), t('map.gpsFallbackHint'));
    }
  };

  const jumpToWard = (wardCode: string): void => {
    const w = WARD_BY_CODE[wardCode];
    if (!w) return;
    set({ scope: `ward:${w.wardCode}` });
    setFocusView({ center: [w.centerLat, w.centerLng], zoom: 14 });
    setQuery(w.name);
    setSearchFocused(false);
  };

  const resetToCity = (): void => {
    set({ scope: 'city' });
    setFocusView({ center: [DONG_NAI_CITY_CENTER[0], DONG_NAI_CITY_CENTER[1]], zoom: 9 });
    setQuery('');
  };

  const wardCode = settings.scope.replace('ward:', '');
  const defaultCenter: [number, number] =
    focusView?.center ??
    (gps.fix && radius !== null
      ? [gps.fix.lat, gps.fix.lng]
      : settings.scope === 'city'
        ? [DONG_NAI_CITY_CENTER[0], DONG_NAI_CITY_CENTER[1]]
        : [WARD_BY_CODE[wardCode]?.centerLat ?? DONG_NAI_CITY_CENTER[0], WARD_BY_CODE[wardCode]?.centerLng ?? DONG_NAI_CITY_CENTER[1]]);
  const defaultZoom =
    focusView?.zoom ??
    (gps.fix && radius !== null ? (radius <= 500 ? 16 : radius <= 1000 ? 15 : 13) : settings.scope === 'city' ? 9 : 14);

  const clear = (): void => {
    setCats([]);
    setStatusFilter('all');
    setRadius(null);
    resetToCity();
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-extrabold">{t('map.title')}</h1>
          <p className="text-xs font-medium text-muted">
            {t('map.subtitle95')}
            {gps.fix ? ` · GPS ±${gps.fix.accuracy}m` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('map.mode')}>
          <button type="button" aria-pressed={mode === 'pins'} className={`btn !min-h-10 !px-3 !text-sm ${mode === 'pins' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('pins')}>
            <Layers className="h-4 w-4" aria-hidden />{t('map.pins')}
          </button>
          <button type="button" aria-pressed={mode === 'heat'} className={`btn !min-h-10 !px-3 !text-sm ${mode === 'heat' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('heat')}>
            <Thermometer className="h-4 w-4" aria-hidden />{t('map.heat')}
          </button>
          <button type="button" className="btn btn-soft !min-h-10 !px-3 !text-sm" disabled={gps.status === 'locating'} onClick={() => void locate()}>
            <MapPinned className="h-4 w-4" aria-hidden />{gps.status === 'locating' ? t('report.locating') : t('map.nearMe')}
          </button>
        </div>
      </div>

      {/* Thanh tìm kiếm không dấu 95 Phường/Xã + Nhảy nhanh 5 vùng toàn TP. Đồng Nai */}
      <div className="card space-y-2.5 p-3">
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
          {searchFocused && wardSuggestions.length > 0 && (
            <ul
              role="listbox"
              className="absolute inset-x-0 top-full z-[650] mt-1 max-h-64 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-lift"
            >
              {wardSuggestions.map((w) => (
                <li key={w.wardCode}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => jumpToWard(w.wardCode)}
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2"
                  >
                    <span className="min-w-0">
                      <span className="font-semibold text-ink">{w.name}</span>
                      {w.upgradedOn2026 && (
                        <span className="ml-1.5 rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-bold text-brand">30/04/2026</span>
                      )}
                      {w.legacyAliases.length > 0 && (
                        <span className="block truncate text-[11px] text-muted">{w.legacyAliases.slice(0, 3).join(' · ')}</span>
                      )}
                    </span>
                    <span className="mono shrink-0 text-[11px] text-muted">{w.wardCode}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Nhảy nhanh 5 vùng toàn Thành phố Đồng Nai */}
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('map.quickRegions')}>
          <button
            type="button"
            className="chip !min-h-8 !text-xs"
            aria-pressed={settings.scope === 'city' && !focusView}
            onClick={resetToCity}
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
                setFocusView({ center: [reg.center[0], reg.center[1]], zoom: reg.zoom });
              }}
            >
              {lang === 'en' ? reg.labelEn : reg.labelVi}
            </button>
          ))}
        </div>

        {/* Bộ lọc danh mục + trạng thái + bán kính */}
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
                <Icon className="h-3.5 w-3.5" aria-hidden />{t(CATEGORY_META[c].labelKey)}
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
                  void locate();
                }
                setRadius(r.v);
              }}
            >
              {t(`map.${r.k}`)}
            </button>
          ))}
        </div>
      </div>

      {!filtered ? (
        <SkeletonBlock className="h-[60dvh]" />
      ) : (
        <MapView
          reports={filtered}
          mode={mode}
          center={defaultCenter}
          zoom={defaultZoom}
          userPos={gps.fix ? { lat: gps.fix.lat, lng: gps.fix.lng } : null}
          accuracyM={gps.fix?.accuracy ?? null}
          radiusM={radius}
          onSelect={(r) => setOpenId(r.id)}
          onLocate={() => void locate()}
          onViewportChange={onViewportChange}
          fitCityBounds={settings.scope === 'city' && !focusView && !gps.fix}
          showArterials
          showFitCityButton
          className="h-[60dvh]"
        />
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-semibold" aria-label={t('map.legend')}>
        <span className="text-muted">{filtered ? t('map.count', { n: filtered.length }) : ''}</span>
        {LEGEND_COLORS.map(([k, color, label]) => (
          <span key={k} className="inline-flex items-center gap-1">
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
              <button type="button" className="btn btn-primary" onClick={clear}>
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
      <ReportDetail id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
