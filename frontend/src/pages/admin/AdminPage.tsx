import {
  Activity,
  BarChart3,
  ChevronsLeft,
  ChevronsRight,
  ClipboardCheck,
  FileClock,
  LogOut,
  Map as MapIcon,
  Settings as SettingsIcon,
  ShieldAlert,
  Siren,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { DiagnosticsDrawer } from '../../components/DiagnosticsDrawer';
import { Logo } from '../../components/Logo';
import { CityIncidentMap, type MapMode } from '../../components/map';
import { OfflineBanner } from '../../components/OfflineBanner';
import { ReportDetail } from '../../components/ReportDetail';
import { ScopePicker } from '../../components/Header';
import { inScope, useAllReports, useOnline } from '../../db/hooks';
import { useI18n, type I18nKey } from '../../i18n';
import { authStore, useSession } from '../../lib/authStore';
import { WARD_BY_CODE } from '../../data/dongNaiWards';
import { useSettings } from '../../state/settings';
import { AuditView } from './AuditView';
import { OverviewView } from './OverviewView';
import { QueueView } from './QueueView';
import { SystemAdminView } from './SystemAdminView';

type View = 'overview' | 'queue' | 'map' | 'audit' | 'sysadmin';

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <span className="mono text-xs text-ioc-dim">{now.toLocaleTimeString('vi-VN', { hour12: false })}</span>;
}

/** Cổng Điều hành IOC & Quản trị Hệ thống (SUPER_ADMIN, ADMIN, OFFICER). */
export default function AdminPage() {
  const { t } = useI18n();
  const nav = useNavigate();
  const session = useSession();
  const online = useOnline();
  const { settings, setDrawerOpen } = useSettings();
  const all = useAllReports();
  const [view, setView] = useState<View>('overview');
  const [collapsed, setCollapsed] = useState(false);
  const [mapMode, setMapMode] = useState<MapMode>('pins');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [diagOpen, setDiagOpen] = useState(false);

  if (!session) return <Navigate to="/auth" replace />;
  const u = session.user;
  if (u.role !== 'ward_officer' && u.role !== 'city_admin' && u.role !== 'super_admin') return <Navigate to="/" replace />;
  const isCity = u.role === 'city_admin' || u.role === 'super_admin';
  const scope = isCity ? settings.scope : `ward:${u.wardCode}`;
  const scopeName = scope === 'city' ? t('scope.cityName') : (WARD_BY_CODE[scope.replace('ward:', '')]?.name ?? scope);
  const scoped = all?.filter((r) => inScope(r, scope) && r.status !== 'rejected');

  const navItems: Array<{ k: View; label: I18nKey; icon: typeof BarChart3 }> = [
    { k: 'overview', label: 'ioc.nav.overview', icon: BarChart3 },
    { k: 'queue', label: 'ioc.nav.queue', icon: ClipboardCheck },
    { k: 'map', label: 'ioc.nav.map', icon: MapIcon },
    { k: 'audit', label: 'ioc.nav.audit', icon: FileClock },
    ...(isCity ? [{ k: 'sysadmin' as const, label: 'ioc.nav.sysadmin' as I18nKey, icon: ShieldAlert }] : []),
  ];

  return (
    <div className="ioc flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ioc-line bg-ioc-panel px-3 py-2">
        <Link to="/" aria-label={t('nav.home')} className="min-w-0"><Logo dark /></Link>
        <span className="hidden items-center gap-1.5 rounded border border-ioc-line px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-ioc-cyan md:inline-flex">
          <i className="h-1.5 w-1.5 animate-pulse rounded-full bg-ioc-green" />{t('ioc.live')}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span className={`inline-flex items-center gap-1 text-xs ${online ? 'text-ioc-green' : 'text-ioc-amber'}`}>
            {online ? <Wifi className="h-3.5 w-3.5" aria-hidden /> : <WifiOff className="h-3.5 w-3.5" aria-hidden />}
            {online ? t('ioc.online') : t('ioc.offline')}
          </span>
          <Clock />
          <div className="hidden text-right leading-tight sm:block">
            <p className="max-w-[12rem] truncate text-xs font-semibold">{u.name}</p>
            <p className="mono text-[10px] text-ioc-dim">{u.staffCode ?? u.roleCode} · {t(`role.${u.role}`)}</p>
          </div>
          {isCity && (
            <Link
              to="/rescue"
              className="ioc-btn !border-rose-500/40 !text-rose-300"
              title="Mở Cổng Điều phối Đội Cứu Hộ"
            >
              <Siren className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden lg:inline">Cứu Hộ SOS</span>
            </Link>
          )}
          <button
            type="button"
            className="ioc-btn ioc-btn-cyan"
            onClick={() => setDiagOpen(true)}
            title="Kiểm tra trạng thái kết nối và dịch vụ hệ thống"
          >
            <Activity className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">Chẩn đoán</span>
          </button>
          <button type="button" className="ioc-btn !min-w-9 !px-2" onClick={() => setDrawerOpen(true)} aria-label={t('settings.title')}>
            <SettingsIcon className="h-4 w-4" />
          </button>
          <button type="button" className="ioc-btn !min-w-9 !px-2" onClick={() => void authStore.signOut().then(() => nav('/auth'))} aria-label={t('nav.logout')}>
            <LogOut className="h-4 w-4" />
          </button>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2">
          {isCity ? <ScopePicker dark /> : <span className="ioc-btn ioc-btn-cyan cursor-default">{scopeName}</span>}
          <p className="text-xs text-ioc-dim">{t('ioc.scopeNow')}: <span className="font-semibold text-ioc-text">{scopeName}</span></p>
        </div>
      </header>
      <OfflineBanner dark />

      <div className="flex min-h-0 flex-1">
        <nav aria-label={t('ioc.nav.title')} className={`sticky top-[6.2rem] hidden h-[calc(100dvh-6.2rem)] shrink-0 flex-col border-r border-ioc-line bg-ioc-panel p-2 transition-[width] duration-150 md:flex ${collapsed ? 'w-14' : 'w-56'}`}>
          {navItems.map(({ k, label, icon: Icon }) => (
            <button
              key={k}
              type="button"
              aria-current={view === k ? 'page' : undefined}
              onClick={() => setView(k)}
              title={t(label)}
              className={`mb-1 flex min-h-10 items-center gap-2 rounded px-2.5 text-left text-sm font-medium ${
                view === k ? 'bg-ioc-raised text-ioc-cyan' : 'text-ioc-dim hover:bg-ioc-raised hover:text-ioc-text'
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              {!collapsed && <span className="min-w-0 truncate">{t(label)}</span>}
            </button>
          ))}
          <button type="button" className="ioc-btn mt-auto" onClick={() => setCollapsed((v) => !v)} aria-label={collapsed ? t('ioc.expand') : t('ioc.collapse')}>
            {collapsed ? <ChevronsRight className="h-4 w-4" /> : <><ChevronsLeft className="h-4 w-4" />{t('ioc.collapse')}</>}
          </button>
        </nav>

        <main className="min-w-0 flex-1 p-3">
          <div role="tablist" aria-label={t('ioc.nav.title')} className="mb-3 flex gap-1 overflow-x-auto md:hidden">
            {navItems.map(({ k, label, icon: Icon }) => (
              <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => setView(k)} className={`ioc-btn shrink-0 ${view === k ? 'ioc-btn-cyan' : ''}`}>
                <Icon className="h-4 w-4" aria-hidden />{t(label)}
              </button>
            ))}
          </div>
          {view === 'overview' && <OverviewView scope={scope} reports={all} isCity={isCity && scope === 'city'} />}
          {view === 'queue' && <QueueView scope={scope} isCity={isCity && scope === 'city'} online={online} />}
          {view === 'map' && (
            <div className="space-y-2">
              <div className="flex gap-2" role="group" aria-label={t('map.mode')}>
                <button type="button" aria-pressed={mapMode === 'pins'} className={`ioc-btn ${mapMode === 'pins' ? 'ioc-btn-cyan' : ''}`} onClick={() => setMapMode('pins')}>{t('map.pins')}</button>
                <button type="button" aria-pressed={mapMode === 'heat'} className={`ioc-btn ${mapMode === 'heat' ? 'ioc-btn-cyan' : ''}`} onClick={() => setMapMode('heat')}>{t('map.heat')}</button>
              </div>
              {scoped ? (
                <CityIncidentMap
                  key={`${scope}-${mapMode}`}
                  embedded
                  externalReports={scoped}
                  defaultMode={mapMode}
                  tone="ioc"
                  fitPointsOnMount
                  onSelectPoint={(r) => setSelectedId(r.id)}
                  className="h-[72dvh]"
                />
              ) : (
                <div className="ioc-skeleton h-[72dvh]" />
              )}
              <ReportDetail id={selectedId} onClose={() => setSelectedId(null)} variant="drawer" />
            </div>
          )}
          {view === 'audit' && <AuditView scope={scope} isCity={isCity} />}
          {view === 'sysadmin' && isCity && <SystemAdminView />}
          <p className="mt-6 text-center text-[11px] text-ioc-dim">{t('footer.credit')}</p>
        </main>
      </div>
      <DiagnosticsDrawer open={diagOpen} onClose={() => setDiagOpen(false)} />
    </div>
  );
}
