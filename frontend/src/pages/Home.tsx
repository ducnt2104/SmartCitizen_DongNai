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

function Kpi({ label, value, sub, tone = 'brand' }: { label: string; value: string; sub?: string; tone?: 'brand' | 'ok' | 'accent' }) {
  const bar = tone === 'ok' ? 'bg-ok' : tone === 'accent' ? 'bg-accent' : 'bg-brand';
  return (
    <div className="card relative min-w-0 overflow-hidden p-3 sm:p-4">
      <span className={`absolute inset-x-0 top-0 h-1 ${bar}`} aria-hidden />
      <p className="truncate pt-0.5 text-[11px] font-semibold text-muted sm:text-xs">{label}</p>
      <p className="mono mt-0.5 text-xl font-extrabold leading-tight text-ink sm:text-2xl">{value}</p>
      {sub && <p className="mono mt-0.5 text-[11px] font-semibold text-ok sm:text-xs">{sub}</p>}
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
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <Kpi label={t('home.kpiTotal')} value={fmtNum(stats.total)} tone="brand" />
          <Kpi label={t('home.kpiDone')} value={fmtNum(stats.resolved)} sub={`${fmtNum(stats.resolvedPct, 1)}%`} tone="ok" />
          <Kpi label={t('home.kpiAvg')} value={`${fmtNum(stats.avgDays, 1)}`} sub={t('home.days')} tone="accent" />
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
          className="hero-gradient flex min-h-[9rem] w-full flex-col items-center justify-center gap-3 rounded-3xl p-5 text-center text-xl font-extrabold text-brand-ink active:scale-[0.98]"
        >
          <Camera className="h-14 w-14" aria-hidden />
          <span className="[overflow-wrap:anywhere]">📸 {t('senior.btnReport')}</span>
        </button>
        <button
          type="button"
          data-tour="assistant"
          onClick={() => openAssistant(true)}
          className="flex min-h-[9rem] w-full flex-col items-center justify-center gap-3 rounded-3xl border-4 border-brand bg-surface p-5 text-center text-xl font-extrabold text-brand shadow-card transition-all hover:shadow-lift active:scale-[0.98]"
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
    <div className="space-y-4 sm:space-y-5">
      <section className="hero-gradient relative overflow-hidden rounded-3xl p-5 text-brand-ink sm:p-7">
        <div className="pointer-events-none absolute -right-10 -top-12 h-44 w-44 rounded-full bg-white/15 blur-2xl" aria-hidden />
        <div className="pointer-events-none absolute -bottom-14 left-1/3 h-40 w-40 rounded-full bg-amber-300/20 blur-2xl" aria-hidden />
        <div className="relative">
          <p className="inline-flex items-center rounded-full bg-white/15 px-3 py-1 text-xs font-semibold backdrop-blur-sm">
            {t('home.tagline')}
          </p>
          <h1 className="mt-2.5 text-2xl font-extrabold leading-tight sm:text-3xl">{t('home.heroTitle')}</h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed opacity-95">{t('home.heroText')}</p>
          <Link to="/report" data-tour="report" className="btn mt-4 !min-h-14 w-full !bg-white !text-base !font-extrabold !text-brand shadow-lift hover:!bg-white/95 sm:w-auto sm:!px-8">
            <Camera className="h-6 w-6" aria-hidden /> {t('home.cta')} <ArrowRight className="h-5 w-5" aria-hidden />
          </Link>
        </div>
      </section>

      {emergency > 0 && (
        <Link to="/map" className="flex items-center gap-3 rounded-2xl border border-danger/35 bg-danger-soft/90 p-3.5 text-danger shadow-card transition-all hover:shadow-lift active:scale-[0.99]">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-danger text-white shadow-sm">
            <Flame className="h-5 w-5" aria-hidden />
          </span>
          <span className="min-w-0 flex-1 text-sm font-bold">{t('home.emergencyBanner', { n: emergency })}</span>
          <ArrowRight className="h-5 w-5 shrink-0" aria-hidden />
        </Link>
      )}

      {kpis}

      <section aria-label={t('home.gateways')} className="grid gap-3 sm:grid-cols-3">
        <Link to="/map" data-tour="map" className="card flex items-center gap-3.5 p-4 transition-all hover:-translate-y-0.5 hover:border-brand/35 hover:shadow-lift active:scale-[0.99]">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-brand-soft text-brand">
            <MapIcon className="h-6 w-6" aria-hidden />
          </span>
          <span className="min-w-0"><span className="block font-bold text-ink">{t('home.gate.map')}</span><span className="block text-xs text-muted sm:text-sm">{t('home.gate.mapText')}</span></span>
        </Link>
        <Link to="/mine" className="card flex items-center gap-3.5 p-4 transition-all hover:-translate-y-0.5 hover:border-ok/35 hover:shadow-lift active:scale-[0.99]">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-ok-soft text-ok">
            <ClipboardList className="h-6 w-6" aria-hidden />
          </span>
          <span className="min-w-0"><span className="block font-bold text-ink">{t('home.gate.mine')}</span><span className="block text-xs text-muted sm:text-sm">{t('home.gate.mineText')}</span></span>
        </Link>
        <button type="button" onClick={() => openAssistant(false)} className="card flex items-center gap-3.5 p-4 text-left transition-all hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-lift active:scale-[0.99]">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-warn-soft text-warn">
            <Bot className="h-6 w-6" aria-hidden />
          </span>
          <span className="min-w-0"><span className="block font-bold text-ink">{t('home.gate.ai')}</span><span className="block text-xs text-muted sm:text-sm">{t('home.gate.aiText')}</span></span>
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
