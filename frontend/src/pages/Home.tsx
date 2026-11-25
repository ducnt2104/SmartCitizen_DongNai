import {
  ArrowRight,
  Bot,
  Camera,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock,
  FileText,
  Flame,
  Map as MapIcon,
  MapPin,
  Mic,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import heroPhoto from '../assets/dongnai-hero.jpg';
import { ReportCard } from '../components/ReportCard';
import { ReportDetail } from '../components/ReportDetail';
import { openAssistant } from '../components/ChatWidget';
import { EmptyState, SkeletonBlock, SkeletonList } from '../components/ui';
import { useScopedReports, useStats } from '../db/hooks';
import { useI18n } from '../i18n';
import { WARD_BY_CODE } from '../data/dongNaiWards';
import { useSettings } from '../state/settings';

function Kpi({
  label,
  value,
  sub,
  icon,
  tone = 'brand',
  progressPct,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: ReactNode;
  tone?: 'brand' | 'ok' | 'accent';
  progressPct?: number;
}) {
  const styles =
    tone === 'ok'
      ? {
          cardBg: 'bg-gradient-to-br from-surface via-surface to-ok-soft/55',
          bar: 'from-emerald-500 to-teal-400',
          iconBg: 'bg-ok-soft text-ok ring-ok/20',
          subText: 'text-ok',
          track: 'bg-ok/15',
          fill: 'bg-gradient-to-r from-emerald-500 to-teal-400',
        }
      : tone === 'accent'
        ? {
            cardBg: 'bg-gradient-to-br from-surface via-surface to-warn-soft/55',
            bar: 'from-amber-500 to-orange-400',
            iconBg: 'bg-warn-soft text-warn ring-amber-500/20',
            subText: 'text-warn',
            track: 'bg-amber-500/15',
            fill: 'bg-amber-500',
          }
        : {
            cardBg: 'bg-gradient-to-br from-surface via-surface to-brand-soft/55',
            bar: 'from-brand to-brand-2',
            iconBg: 'bg-brand-soft text-brand ring-brand/20',
            subText: 'text-muted',
            track: 'bg-brand/15',
            fill: 'bg-brand',
          };

  return (
    <div className={`card group relative min-w-0 overflow-hidden p-3 transition-all hover:-translate-y-0.5 hover:shadow-lift sm:p-4 ${styles.cardBg}`}>
      <span className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${styles.bar}`} aria-hidden />
      <div className="flex items-start justify-between gap-2 pt-0.5">
        <p className="truncate text-[11px] font-semibold text-muted sm:text-xs">{label}</p>
        <span className={`hidden h-7 w-7 shrink-0 place-items-center rounded-lg ring-1 sm:grid ${styles.iconBg}`} aria-hidden>
          {icon}
        </span>
      </div>
      <p className="mono mt-1 text-xl font-extrabold leading-tight tracking-tight text-ink sm:text-[1.75rem]">{value}</p>
      {sub && <p className={`mono mt-0.5 truncate text-[11px] font-semibold sm:text-xs ${styles.subText}`}>{sub}</p>}
      {progressPct !== undefined && (
        <div className={`mt-2 h-1.5 w-full overflow-hidden rounded-full ${styles.track}`} aria-hidden>
          <div
            className={`h-full rounded-full transition-all duration-500 ${styles.fill}`}
            style={{ width: `${progressPct > 0 ? Math.max(4, Math.min(100, progressPct)) : 0}%` }}
          />
        </div>
      )}
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
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="h-5 w-1 rounded-full bg-gradient-to-b from-brand to-brand-2" aria-hidden />
          <h2 className="text-base font-extrabold tracking-tight text-ink sm:text-lg">{t('home.kpiTitle')}</h2>
        </div>
        <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-brand/20 bg-brand-soft/80 px-3 py-1 text-xs font-semibold text-brand">
          <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{scopeName}</span>
        </span>
      </div>
      {!stats ? (
        <div className="grid grid-cols-3 gap-2 sm:gap-3"><SkeletonBlock className="h-24" /><SkeletonBlock className="h-24" /><SkeletonBlock className="h-24" /></div>
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <Kpi
            label={t('home.kpiTotal')}
            value={fmtNum(stats.total)}
            sub={t('home.kpiTotalSub')}
            icon={<FileText className="h-4 w-4" />}
            tone="brand"
          />
          <Kpi
            label={t('home.kpiDone')}
            value={fmtNum(stats.resolved)}
            sub={`${fmtNum(stats.resolvedPct, 1)}%`}
            icon={<CheckCircle2 className="h-4 w-4" />}
            tone="ok"
            progressPct={stats.resolvedPct}
          />
          <Kpi
            label={t('home.kpiAvg')}
            value={`${fmtNum(stats.avgDays, 1)}`}
            sub={t('home.days')}
            icon={<Clock className="h-4 w-4" />}
            tone="accent"
          />
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
    <div className="space-y-5 sm:space-y-6">
      <section className="hero-photo-card group relative overflow-hidden rounded-[1.75rem] bg-slate-900 text-white">
        <img
          src={heroPhoto}
          alt={t('home.heroImgAlt')}
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover object-[68%_42%] transition-transform duration-700 ease-out group-hover:scale-[1.02]"
        />
        <div className="hero-scrim pointer-events-none absolute inset-0" aria-hidden />
        <div className="pointer-events-none absolute inset-0 rounded-[1.75rem] ring-1 ring-inset ring-white/15" aria-hidden />

        <div className="relative z-10 flex min-h-[260px] flex-col justify-between p-5 sm:min-h-[300px] sm:p-8 lg:min-h-[330px] lg:p-9">
          <div>
            <p className="inline-flex w-fit items-center gap-2 rounded-full border border-white/20 bg-slate-950/40 px-3 py-1 text-[11px] font-semibold tracking-wide text-white/95 backdrop-blur-md sm:px-3.5 sm:py-1.5 sm:text-xs">
              <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              <span>{t('home.tagline')}</span>
            </p>
            <h1 className="mt-3.5 max-w-3xl text-[1.4rem] font-extrabold leading-[1.2] tracking-tight text-white drop-shadow-[0_2px_12px_rgba(0,0,0,0.45)] sm:text-[1.85rem] md:text-[2.1rem] md:leading-[1.15]">
              {t('home.heroTitle')}
            </h1>
            <p className="mt-2 max-w-xl text-sm font-medium leading-relaxed text-slate-100/95 drop-shadow-[0_1px_6px_rgba(0,0,0,0.45)] sm:text-base">
              {t('home.heroText')}
            </p>
          </div>

          <div className="mt-5 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
            <Link
              to="/report"
              data-tour="report"
              className="inline-flex min-h-12 w-full items-center justify-center gap-2.5 rounded-2xl bg-white px-6 py-3 text-sm font-extrabold text-slate-900 shadow-[0_12px_28px_-6px_rgba(0,0,0,0.45)] transition-all hover:-translate-y-0.5 hover:bg-slate-50 active:scale-[0.98] sm:w-auto sm:text-base"
            >
              <Camera className="h-5 w-5 text-brand" aria-hidden />
              <span>{t('home.cta')}</span>
            </Link>
            <Link
              to="/map"
              className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-white/25 bg-slate-900/55 px-5 py-3 text-sm font-bold text-white backdrop-blur-md transition-all hover:-translate-y-0.5 hover:border-white/45 hover:bg-slate-900/75 active:scale-[0.98] sm:w-auto sm:text-base"
            >
              <MapIcon className="h-5 w-5 text-sky-300" aria-hidden />
              <span>{t('home.heroMapCta')}</span>
            </Link>
          </div>
        </div>
      </section>

      {emergency > 0 && (
        <Link to="/map" className="group flex items-center gap-3 rounded-2xl border border-danger/35 bg-danger-soft/90 p-3.5 text-danger shadow-card ring-1 ring-danger/10 transition-all hover:-translate-y-0.5 hover:shadow-lift active:scale-[0.99]">
          <span className="relative grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-danger text-white shadow-sm">
            <Flame className="h-5 w-5" aria-hidden />
            <span className="absolute -right-1 -top-1 h-2.5 w-2.5 animate-pulse rounded-full bg-amber-300 ring-2 ring-white" aria-hidden />
          </span>
          <span className="min-w-0 flex-1 text-sm font-bold">{t('home.emergencyBanner', { n: emergency })}</span>
          <ArrowRight className="h-5 w-5 shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden />
        </Link>
      )}

      {kpis}

      <section aria-label={t('home.gateways')}>
        <div className="mb-2.5 flex items-center gap-2">
          <span className="h-5 w-1 rounded-full bg-gradient-to-b from-brand to-brand-2" aria-hidden />
          <h2 className="text-base font-extrabold tracking-tight text-ink sm:text-lg">{t('home.gateways')}</h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Link to="/map" data-tour="map" className="card group relative flex items-center gap-3.5 overflow-hidden bg-gradient-to-br from-surface via-surface to-brand-soft/40 p-4 transition-all hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-lift active:scale-[0.99]">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-brand-soft text-brand shadow-sm ring-1 ring-brand/20 transition-transform group-hover:scale-105">
              <MapIcon className="h-6 w-6" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-bold text-ink">{t('home.gate.map')}</span>
              <span className="mt-0.5 block text-xs text-muted sm:text-sm">{t('home.gate.mapText')}</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted/70 transition-transform group-hover:translate-x-0.5 group-hover:text-brand" aria-hidden />
          </Link>
          <Link to="/mine" className="card group relative flex items-center gap-3.5 overflow-hidden bg-gradient-to-br from-surface via-surface to-ok-soft/40 p-4 transition-all hover:-translate-y-0.5 hover:border-ok/40 hover:shadow-lift active:scale-[0.99]">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-ok-soft text-ok shadow-sm ring-1 ring-ok/20 transition-transform group-hover:scale-105">
              <ClipboardList className="h-6 w-6" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-bold text-ink">{t('home.gate.mine')}</span>
              <span className="mt-0.5 block text-xs text-muted sm:text-sm">{t('home.gate.mineText')}</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted/70 transition-transform group-hover:translate-x-0.5 group-hover:text-ok" aria-hidden />
          </Link>
          <button type="button" onClick={() => openAssistant(false)} className="card group relative flex items-center gap-3.5 overflow-hidden bg-gradient-to-br from-surface via-surface to-warn-soft/40 p-4 text-left transition-all hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-lift active:scale-[0.99]">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-warn-soft text-warn shadow-sm ring-1 ring-amber-500/25 transition-transform group-hover:scale-105">
              <Bot className="h-6 w-6" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-bold text-ink">{t('home.gate.ai')}</span>
              <span className="mt-0.5 block text-xs text-muted sm:text-sm">{t('home.gate.aiText')}</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted/70 transition-transform group-hover:translate-x-0.5 group-hover:text-warn" aria-hidden />
          </button>
        </div>
      </section>

      <section aria-label={t('home.recent')}>
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="h-5 w-1 rounded-full bg-gradient-to-b from-brand to-brand-2" aria-hidden />
            <h2 className="text-base font-extrabold tracking-tight text-ink sm:text-lg">{t('home.recent')}</h2>
            {recent && recent.length > 0 && (
              <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-semibold text-muted">
                {t('home.recentCount', { n: recent.length })}
              </span>
            )}
          </div>
          <Link to="/map" className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-3 py-1 text-xs font-bold text-brand transition-colors hover:bg-brand/15">
            <span>{t('home.seeMap')}</span>
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
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
