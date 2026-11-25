import { ArrowRight, Bot, Camera, ClipboardList, Flame, Map as MapIcon, Mic } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ReportCard } from '../components/ReportCard';
import { ReportDetail } from '../components/ReportDetail';
import { openAssistant } from '../components/ChatWidget';
import { EmptyState, SkeletonBlock, SkeletonList } from '../components/ui';
import { useScopedReports, useStats } from '../db/hooks';
import { useI18n } from '../i18n';
import { WARD_BY_CODE } from '../data/dongNaiWards';
import { useSettings } from '../state/settings';

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card min-w-0 p-3">
      <p className="truncate text-xs font-semibold text-muted">{label}</p>
      <p className="mono mt-0.5 text-2xl font-bold leading-tight text-ink">{value}</p>
      {sub && <p className="mono text-xs font-semibold text-ok">{sub}</p>}
    </div>
  );
}

export default function HomePage() {
  const { t, fmtNum } = useI18n();
  const { settings } = useSettings();
  const nav = useNavigate();
  const stats = useStats(settings.scope);
  const reports = useScopedReports(settings.scope);
  const [openId, setOpenId] = useState<string | null>(null);
  const scopeName = settings.scope === 'city' ? t('scope.cityName') : (WARD_BY_CODE[settings.scope.replace('ward:', '')]?.name ?? settings.scope);
  const recent = reports?.filter((r) => r.status !== 'quarantined' && r.status !== 'rejected').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  const emergency = reports?.filter((r) => r.emergencyLevel === 1 && r.status !== 'resolved' && r.status !== 'quarantined').length ?? 0;

  const kpis = (
    <section aria-label={t('home.kpiTitle')}>
      <p className="mb-2 text-sm font-semibold text-muted">{t('home.kpiTitle')}: <span className="text-ink">{scopeName}</span></p>
      {!stats ? (
        <div className="grid grid-cols-3 gap-2"><SkeletonBlock className="h-20" /><SkeletonBlock className="h-20" /><SkeletonBlock className="h-20" /></div>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          <Kpi label={t('home.kpiTotal')} value={fmtNum(stats.total)} />
          <Kpi label={t('home.kpiDone')} value={fmtNum(stats.resolved)} sub={`${fmtNum(stats.resolvedPct, 1)}%`} />
          <Kpi label={t('home.kpiAvg')} value={`${fmtNum(stats.avgDays, 1)}`} sub={t('home.days')} />
        </div>
      )}
    </section>
  );

  if (settings.senior) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-extrabold leading-tight">{t('senior.homeTitle')}</h1>
        <button
          type="button"
          data-tour="report"
          onClick={() => nav('/report?capture=1')}
          className="flex min-h-[9rem] w-full flex-col items-center justify-center gap-3 rounded-3xl bg-brand p-5 text-center text-xl font-extrabold text-brand-ink shadow-lift active:scale-[0.98]"
        >
          <Camera className="h-14 w-14" aria-hidden />
          <span className="[overflow-wrap:anywhere]">📸 {t('senior.btnReport')}</span>
        </button>
        <button
          type="button"
          data-tour="assistant"
          onClick={() => openAssistant(true)}
          className="flex min-h-[9rem] w-full flex-col items-center justify-center gap-3 rounded-3xl border-4 border-brand bg-surface p-5 text-center text-xl font-extrabold text-brand shadow-card active:scale-[0.98]"
        >
          <Mic className="h-14 w-14" aria-hidden />
          <span className="[overflow-wrap:anywhere]">🎤 {t('senior.btnVoice')}</span>
        </button>
        {kpis}
        <p className="text-center text-sm font-semibold text-muted">{t('senior.offHint')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="rounded-3xl bg-brand p-5 text-brand-ink">
        <p className="text-sm font-semibold opacity-90">{t('home.tagline')}</p>
        <h1 className="mt-1 text-2xl font-extrabold leading-tight sm:text-3xl">{t('home.heroTitle')}</h1>
        <p className="mt-2 max-w-xl text-sm opacity-95">{t('home.heroText')}</p>
        <Link to="/report" data-tour="report" className="btn mt-4 !min-h-14 w-full !bg-white !text-base !font-extrabold !text-brand sm:w-auto sm:!px-8">
          <Camera className="h-6 w-6" aria-hidden /> {t('home.cta')} <ArrowRight className="h-5 w-5" aria-hidden />
        </Link>
      </section>

      {emergency > 0 && (
        <Link to="/map" className="flex items-center gap-3 rounded-2xl border-2 border-danger bg-danger-soft p-3 text-danger">
          <Flame className="h-6 w-6 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 text-sm font-bold">{t('home.emergencyBanner', { n: emergency })}</span>
          <ArrowRight className="h-5 w-5 shrink-0" aria-hidden />
        </Link>
      )}

      {kpis}

      <section aria-label={t('home.gateways')} className="grid gap-3 sm:grid-cols-3">
        <Link to="/map" data-tour="map" className="card flex items-center gap-3 p-4 active:scale-[0.99]">
          <MapIcon className="h-8 w-8 shrink-0 text-brand" aria-hidden />
          <span className="min-w-0"><span className="block font-bold">{t('home.gate.map')}</span><span className="block text-sm text-muted">{t('home.gate.mapText')}</span></span>
        </Link>
        <Link to="/mine" className="card flex items-center gap-3 p-4 active:scale-[0.99]">
          <ClipboardList className="h-8 w-8 shrink-0 text-brand" aria-hidden />
          <span className="min-w-0"><span className="block font-bold">{t('home.gate.mine')}</span><span className="block text-sm text-muted">{t('home.gate.mineText')}</span></span>
        </Link>
        <button type="button" onClick={() => openAssistant(false)} className="card flex items-center gap-3 p-4 text-left active:scale-[0.99]">
          <Bot className="h-8 w-8 shrink-0 text-brand" aria-hidden />
          <span className="min-w-0"><span className="block font-bold">{t('home.gate.ai')}</span><span className="block text-sm text-muted">{t('home.gate.aiText')}</span></span>
        </button>
      </section>

      <section aria-label={t('home.recent')}>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-bold">{t('home.recent')}</h2>
          <Link to="/map" className="text-sm font-semibold text-brand underline">{t('home.seeMap')}</Link>
        </div>
        {!recent ? (
          <SkeletonList rows={3} />
        ) : recent.length === 0 ? (
          <div className="card">
            <EmptyState
              title={t('empty.reports.title')}
              text={t('empty.reports.text')}
              action={<Link to="/report" className="btn btn-primary">{t('empty.reports.cta')}</Link>}
            />
          </div>
        ) : (
          <div className="space-y-3">{recent.map((r) => <ReportCard key={r.id} r={r} onOpen={(x) => setOpenId(x.id)} />)}</div>
        )}
      </section>
      <ReportDetail id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
