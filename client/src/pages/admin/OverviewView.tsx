import { Activity, AlertOctagon, CheckCircle2, Timer } from 'lucide-react';
import { useMemo } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Category, ClientReport } from '@shared/types';
import { MapView } from '../../components/MapView';
import { SkeletonBlock } from '../../components/ui';
import { inScope } from '../../db/hooks';
import { useI18n } from '../../i18n';
import { CATEGORY_META } from '../../lib/meta';
import { useOverview } from './useAdminData';

const CATS: Category[] = ['rac_thai', 'den_duong', 'ngap_nuoc', 'mat_duong'];
const CAT_COLOR: Record<Category, string> = { rac_thai: '#FBBF24', den_duong: '#22D3EE', ngap_nuoc: '#60A5FA', mat_duong: '#A3A3A3' };

function Spark({ data, color }: { data: Array<{ v: number }>; color: string }) {
  return (
    <ResponsiveContainer width="100%" height={36}>
      <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} fill={color} fillOpacity={0.12} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function Kpi({ icon, label, value, unit, sub, color, spark, tone }: {
  icon: React.ReactNode; label: string; value: string; unit?: string; sub?: string; color: string; spark: Array<{ v: number }>; tone?: string;
}) {
  return (
    <div className="ioc-panel min-w-0 p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ioc-dim">{icon}<span className="truncate">{label}</span></div>
      <p className={`mono mt-1 text-3xl font-bold leading-none ${tone ?? 'text-ioc-text'}`}>{value}<span className="ml-1 text-sm font-medium text-ioc-dim">{unit}</span></p>
      {sub && <p className="mono mt-1 truncate text-[11px] text-ioc-dim">{sub}</p>}
      <div className="mt-1"><Spark data={spark} color={color} /></div>
    </div>
  );
}

/** Dashboard KPI + biểu đồ + bản đồ nhiệt + bảng xếp hạng xã/phường. */
export function OverviewView({ scope, reports, isCity }: { scope: string; reports: ClientReport[] | undefined; isCity: boolean }) {
  const { t, fmtNum } = useI18n();
  const ov = useOverview(scope);
  const rows = useMemo(() => reports?.filter((r) => inScope(r, scope) && r.status !== 'rejected'), [reports, scope]);

  const daily = useMemo(() => {
    const m = new Map<string, { created: number; resolved: number }>();
    for (const r of rows ?? []) {
      const d = r.createdAt.slice(5, 10);
      const e = m.get(d) ?? { created: 0, resolved: 0 };
      e.created += 1;
      if (r.status === 'resolved') e.resolved += 1;
      m.set(d, e);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-14).map(([d, e]) => ({ d, ...e }));
  }, [rows]);

  if (!ov.data) return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="ioc-skeleton h-32" />)}</div>;
  const s = ov.data.stats;
  const catData = CATS.map((c) => ({ key: c, name: t(CATEGORY_META[c].labelKey), value: s.byCategory[c] }));
  const sparkTotal = daily.map((x) => ({ v: x.created }));
  const sparkDone = daily.map((x) => ({ v: x.resolved }));
  const sparkAvg = ov.data.trend.map((x) => ({ v: x.avgDays }));
  const reached = s.avgDays <= ov.data.targetDays;

  return (
    <div className="space-y-3">
      {ov.stale && <p className="rounded border border-ioc-amber/40 bg-ioc-amber/10 px-3 py-2 text-xs font-semibold text-ioc-amber">{t('ioc.staleData')}</p>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi icon={<Activity className="h-3.5 w-3.5" aria-hidden />} label={t('ioc.kpiTotal')} value={fmtNum(s.total)} sub={`${t('ioc.kpiOpen')}: ${s.open}`} color="#22D3EE" spark={sparkTotal} />
        <Kpi icon={<CheckCircle2 className="h-3.5 w-3.5" aria-hidden />} label={t('ioc.kpiDone')} value={fmtNum(s.resolvedPct, 1)} unit="%" sub={`${s.resolved}/${s.total}`} color="#4ADE80" tone="text-ioc-green" spark={sparkDone} />
        <Kpi icon={<Timer className="h-3.5 w-3.5" aria-hidden />} label={t('ioc.kpiAvg')} value={fmtNum(s.avgDays, 1)} unit={t('home.days')} sub={`${t('ioc.target')} < ${ov.data.targetDays} ${t('home.days')} ${reached ? '✓' : ''}`} color="#FBBF24" tone={reached ? 'text-ioc-green' : 'text-ioc-amber'} spark={sparkAvg.length ? sparkAvg : [{ v: s.avgDays }, { v: s.avgDays }]} />
        <Kpi icon={<AlertOctagon className="h-3.5 w-3.5" aria-hidden />} label={t('ioc.kpiRisk')} value={fmtNum(s.emergency)} sub={`${t('ioc.kpiOverdue')}: ${s.slaOverdue} · ${t('ioc.kpiQuarantine')}: ${s.quarantined}`} color="#F87171" tone={s.emergency ? 'text-ioc-red' : 'text-ioc-text'} spark={sparkTotal} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <section className="ioc-panel p-3" aria-label={t('ioc.chartCategory')}>
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-ioc-dim">{t('ioc.chartCategory')}</h2>
          <div className="h-52" role="img" aria-label={catData.map((c) => `${c.name}: ${c.value}`).join(', ')}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={catData} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid stroke="#1E293B" horizontal={false} />
                <XAxis type="number" stroke="#94A3B8" tick={{ fontSize: 11 }} allowDecimals={false} />
                <YAxis type="category" dataKey="name" stroke="#94A3B8" tick={{ fontSize: 11 }} width={92} />
                <Tooltip contentStyle={{ background: '#0F172A', border: '1px solid #1E293B', color: '#E2E8F0', fontSize: 12 }} cursor={{ fill: 'rgba(148,163,184,0.08)' }} />
                <Bar dataKey="value" radius={[0, 3, 3, 0]} isAnimationActive={false}>
                  {catData.map((c) => <Cell key={c.key} fill={CAT_COLOR[c.key as Category]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="ioc-panel p-3" aria-label={t('ioc.chartTrend')}>
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-ioc-dim">{t('ioc.chartTrend')}</h2>
          <div className="h-52">
            {ov.data.trend.length === 0 ? (
              <p className="grid h-full place-items-center text-sm text-ioc-dim">{t('ioc.noTrend')}</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={ov.data.trend.map((x) => ({ ...x, d: x.date.slice(5) }))} margin={{ left: -10, right: 12, top: 8 }}>
                  <CartesianGrid stroke="#1E293B" />
                  <XAxis dataKey="d" stroke="#94A3B8" tick={{ fontSize: 11 }} />
                  <YAxis stroke="#94A3B8" tick={{ fontSize: 11 }} unit="d" />
                  <Tooltip contentStyle={{ background: '#0F172A', border: '1px solid #1E293B', color: '#E2E8F0', fontSize: 12 }} />
                  <ReferenceLine y={ov.data.targetDays} stroke="#4ADE80" strokeDasharray="5 4" label={{ value: `${t('ioc.target')} ${ov.data.targetDays}d`, fill: '#4ADE80', fontSize: 11, position: 'insideTopRight' }} />
                  <ReferenceLine y={3.2} stroke="#FBBF24" strokeDasharray="2 4" label={{ value: `${t('ioc.baseline')} 3.2d`, fill: '#FBBF24', fontSize: 11, position: 'insideBottomRight' }} />
                  <Line type="monotone" dataKey="avgDays" stroke="#22D3EE" strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>
      </div>

      <section className="ioc-panel p-3" aria-label={t('ioc.heatmap')}>
        <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-ioc-dim">{t('ioc.heatmap')}</h2>
        {!rows ? <SkeletonBlock className="h-72" /> : <MapView key={scope} reports={rows} mode="heat" tone="ioc" className="h-[22rem]" center={isCity ? [10.95, 107.1] : undefined} zoom={isCity ? 10 : 14} fitToReports={isCity} showArterials />}
      </section>

      {isCity && ov.data.ranking.length > 0 && (
        <section className="ioc-panel overflow-hidden" aria-label={t('ioc.ranking')}>
          <h2 className="border-b border-ioc-line p-3 text-xs font-bold uppercase tracking-wider text-ioc-dim">{t('ioc.ranking')}</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-ioc-line"><th className="ioc-th">#</th><th className="ioc-th">{t('ioc.colWard')}</th><th className="ioc-th text-right">{t('ioc.kpiTotal')}</th><th className="ioc-th text-right">{t('ioc.kpiDone')}</th><th className="ioc-th text-right">{t('ioc.kpiAvg')}</th></tr></thead>
              <tbody>
                {ov.data.ranking.map((w, i) => (
                  <tr key={w.wardCode} className="border-b border-ioc-line/60 hover:bg-ioc-raised">
                    <td className="mono px-3 py-1.5 text-ioc-dim">{i + 1}</td>
                    <td className="px-3 py-1.5 font-medium">{w.name}</td>
                    <td className="mono px-3 py-1.5 text-right">{w.total}</td>
                    <td className="mono px-3 py-1.5 text-right">{w.resolved}</td>
                    <td className={`mono px-3 py-1.5 text-right font-semibold ${w.avgDays <= ov.data!.targetDays ? 'text-ioc-green' : 'text-ioc-amber'}`}>{w.avgDays || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
