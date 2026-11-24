import { Flame, Layers, MapPinned, Thermometer } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { haversineMeters } from '@shared/geo';
import type { Category, ClientReport } from '@shared/types';
import { MapView, type MapMode } from '../components/MapView';
import { ReportDetail } from '../components/ReportDetail';
import { EmptyState, SkeletonBlock } from '../components/ui';
import { WARD_BY_CODE } from '../data/dongNaiWards';
import { useScopedReports } from '../db/hooks';
import { useI18n } from '../i18n';
import { getGps, GpsError } from '../lib/geoClient';
import { CATEGORY_META, PIN_COLOR } from '../lib/meta';
import { useSettings } from '../state/settings';
import { useToast } from '../state/toast';

const CATS: Category[] = ['rac_thai', 'den_duong', 'ngap_nuoc', 'mat_duong'];
const RADII: Array<{ v: number | null; k: 'r500' | 'r1k' | 'r5k' | 'rall' }> = [
  { v: 500, k: 'r500' }, { v: 1000, k: 'r1k' }, { v: 5000, k: 'r5k' }, { v: null, k: 'rall' },
];

export default function MapPage() {
  const { t } = useI18n();
  const toast = useToast();
  const { settings } = useSettings();
  const reports = useScopedReports(settings.scope);
  const [mode, setMode] = useState<MapMode>('pins');
  const [cats, setCats] = useState<Category[]>([]);
  const [radius, setRadius] = useState<number | null>(null);
  const [me, setMe] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const filtered = useMemo<ClientReport[] | undefined>(() => {
    if (!reports) return undefined;
    return reports.filter((r) => {
      if (r.status === 'rejected') return false;
      if (cats.length && !cats.includes(r.category)) return false;
      if (radius !== null && me && haversineMeters(me.lat, me.lng, r.lat, r.lng) > radius) return false;
      return true;
    });
  }, [reports, cats, radius, me]);

  const locate = async (): Promise<void> => {
    setLocating(true);
    try {
      const f = await getGps();
      setMe({ lat: f.lat, lng: f.lng });
    } catch (err) {
      toast('error', err instanceof GpsError && err.kind === 'denied' ? t('map.gpsDenied') : t('map.gpsError'), t('map.gpsFallbackHint'));
    } finally {
      setLocating(false);
    }
  };

  const wardCode = settings.scope.replace('ward:', '');
  const center: [number, number] = me && radius !== null ? [me.lat, me.lng] : settings.scope === 'city' ? [10.93, 107.05] : [WARD_BY_CODE[wardCode]?.centerLat ?? 10.9465, WARD_BY_CODE[wardCode]?.centerLng ?? 106.8243];
  const zoom = me && radius !== null ? (radius <= 500 ? 16 : radius <= 1000 ? 15 : 13) : settings.scope === 'city' ? 10 : 14;
  const clear = (): void => { setCats([]); setRadius(null); };

  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-extrabold">{t('map.title')}</h1>

      <div className="flex flex-wrap gap-2" role="group" aria-label={t('map.mode')}>
        <button type="button" aria-pressed={mode === 'pins'} className={`btn !min-h-11 !text-sm ${mode === 'pins' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('pins')}><Layers className="h-4 w-4" aria-hidden />{t('map.pins')}</button>
        <button type="button" aria-pressed={mode === 'heat'} className={`btn !min-h-11 !text-sm ${mode === 'heat' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('heat')}><Thermometer className="h-4 w-4" aria-hidden />{t('map.heat')}</button>
        <button type="button" className="btn btn-soft !min-h-11 !text-sm" disabled={locating} onClick={() => void locate()}><MapPinned className="h-4 w-4" aria-hidden />{locating ? t('report.locating') : t('map.nearMe')}</button>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label={t('map.filterCat')}>
        {CATS.map((c) => {
          const Icon = CATEGORY_META[c].icon;
          return (
            <button key={c} type="button" className="chip !min-h-10" aria-pressed={cats.includes(c)} onClick={() => setCats((l) => (l.includes(c) ? l.filter((x) => x !== c) : [...l, c]))}>
              <Icon className="h-4 w-4" aria-hidden />{t(CATEGORY_META[c].labelKey)}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('map.radius')}>
        <span className="text-sm font-semibold text-muted">{t('map.radius')}:</span>
        {RADII.map((r) => (
          <button
            key={r.k}
            type="button"
            className="chip !min-h-10"
            aria-pressed={radius === r.v}
            onClick={() => {
              if (r.v !== null && !me) {
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

      {!filtered ? (
        <SkeletonBlock className="h-[55dvh]" />
      ) : (
        <MapView key={settings.scope} reports={filtered} mode={mode} center={center} zoom={zoom} userPos={me} radiusM={radius} onSelect={(r) => setOpenId(r.id)} onLocate={() => void locate()} fitToReports={settings.scope === 'city' && !me} />
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-semibold" aria-label={t('map.legend')}>
        <span className="text-muted">{filtered ? t('map.count', { n: filtered.length }) : ''}</span>
        {([['emergency', 'legend.emergency'], ['high', 'legend.high'], ['open', 'legend.open'], ['resolved', 'legend.resolved']] as const).map(([k, label]) => (
          <span key={k} className="inline-flex items-center gap-1"><i className="h-3 w-3 rounded-full" style={{ background: PIN_COLOR[k] }} />{t(label)}</span>
        ))}
      </div>

      {filtered && filtered.length === 0 && (
        <div className="card">
          <EmptyState
            kind="search"
            title={t('empty.map.title')}
            text={t('empty.map.text')}
            action={<button type="button" className="btn btn-primary" onClick={clear}>{t('empty.clearFilters')}</button>}
            secondary={<Link to="/report" className="btn btn-ghost"><Flame className="h-4 w-4" aria-hidden />{t('empty.reports.cta')}</Link>}
          />
        </div>
      )}
      <ReportDetail id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
