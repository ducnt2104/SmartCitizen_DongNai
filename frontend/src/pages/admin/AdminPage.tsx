import {
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
import { normalizeRole } from '@shared/constants';
import { ScopePicker } from '../../components/Header';
import { Logo, LogoMark } from '../../components/Logo';
import { CityIncidentMap, type MapMode } from '../../components/map';
import { OfflineBanner } from '../../components/OfflineBanner';
import { ReportDetail } from '../../components/ReportDetail';
import { WARD_BY_CODE } from '../../data/dongNaiWards';
import { inScope, useAllReports, useOnline } from '../../db/hooks';
import { useI18n, type I18nKey } from '../../i18n';
import { authStore, useSession } from '../../lib/authStore';
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

/** Cổng Điều hành IOC & Quản trị Hệ thống (ADMIN, OFFICER). */
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

  if (!session) return <Navigate to="/auth" replace />;
  const u = session.user;
  const role = normalizeRole(u.role);
  if (role !== 'admin' && role !== 'officer') {
    return <Navigate to={role === 'rescue' ? '/rescue' : '/'} replace />;
  }

  const isAdmin = role === 'admin';
  const canPickCityScope = isAdmin || !u.wardCode;
  const scope = canPickCityScope ? settings.scope : `ward:${u.wardCode}`;
  const scopeName = scope === 'city' ? t('scope.cityName') : (WARD_BY_CODE[scope.replace('ward:', '')]?.name ?? scope);
  const scoped = all?.filter((r) => inScope(r, scope) && r.status !== 'rejected');

  const navItems: Array<{ k: View; label: I18nKey; icon: typeof BarChart3 }> = [
    { k: 'overview', label: 'ioc.nav.overview', icon: BarChart3 },
    { k: 'queue', label: 'ioc.nav.queue', icon: ClipboardCheck },
    { k: 'map', label: 'ioc.nav.map', icon: MapIcon },
    { k: 'audit', label: 'ioc.nav.audit', icon: FileClock },
    ...(isAdmin ? [{ k: 'sysadmin' as const, label: 'ioc.nav.sysadmin' as I18nKey, icon: ShieldAlert }] : []),
  ];

  return (
    <div className="ioc flex min-h-dvh">
      {/* Cột Sidebar cố định bên trái (chiều cao toàn màn hình, không va chạm thanh chọn địa bàn phía trên) */}
      <aside
        className={`sticky top-0 z-30 hidden h-dvh shrink-0 flex-col border-r border-ioc-line bg-ioc-panel transition-[width] duration-200 md:flex ${
          collapsed ? 'w-16' : 'w-64'
        }`}
      >
        <div className={`flex h-14 shrink-0 items-center border-b border-ioc-line ${collapsed ? 'justify-center px-2' : 'px-3.5'}`}>
          <Link to="/" aria-label={t('nav.home')} className="min-w-0 overflow-hidden">
            {collapsed ? (
              <LogoMark size={36} className="h-9 w-9 shrink-0" />
            ) : (
              <Logo dark />
            )}
          </Link>
        </div>

        <nav aria-label={t('ioc.nav.title')} className="flex flex-1 flex-col gap-1 overflow-y-auto p-2.5">
          {navItems.map(({ k, label, icon: Icon }) => (
            <button
              key={k}
              type="button"
              aria-current={view === k ? 'page' : undefined}
              onClick={() => setView(k)}
              title={t(label)}
              className={`flex min-h-10 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
                collapsed ? 'justify-center px-2' : ''
              } ${
                view === k
                  ? 'bg-ioc-raised font-semibold text-ioc-cyan shadow-sm'
                  : 'text-ioc-dim hover:bg-ioc-raised/70 hover:text-ioc-text'
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              {!collapsed && <span className="min-w-0 flex-1 truncate">{t(label)}</span>}
            </button>
          ))}
        </nav>

        <div className="shrink-0 border-t border-ioc-line p-2.5">
          <button
            type="button"
            className={`ioc-btn w-full ${collapsed ? 'justify-center !px-2' : 'justify-start'}`}
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? t('ioc.expand') : t('ioc.collapse')}
            title={collapsed ? t('ioc.expand') : t('ioc.collapse')}
          >
            {collapsed ? (
              <ChevronsRight className="h-4 w-4 shrink-0" />
            ) : (
              <>
                <ChevronsLeft className="h-4 w-4 shrink-0" />
                <span className="truncate">{t('ioc.collapse')}</span>
              </>
            )}
          </button>
        </div>
      </aside>

      {/* Cột Nội dung chính bên phải */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-ioc-line bg-ioc-panel/95 px-3 py-2.5 backdrop-blur md:px-4">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Link to="/" aria-label={t('nav.home')} className="min-w-0 md:hidden">
              <Logo dark />
            </Link>
            <span className="hidden items-center gap-1.5 rounded border border-ioc-line px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-ioc-cyan lg:inline-flex">
              <i className="h-1.5 w-1.5 animate-pulse rounded-full bg-ioc-green" />
              {t('ioc.live')}
            </span>
            {canPickCityScope ? (
              <ScopePicker dark />
            ) : (
              <span className="ioc-btn ioc-btn-cyan cursor-default">{scopeName}</span>
            )}
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <span className={`inline-flex items-center gap-1 text-xs ${online ? 'text-ioc-green' : 'text-ioc-amber'}`}>
              {online ? <Wifi className="h-3.5 w-3.5" aria-hidden /> : <WifiOff className="h-3.5 w-3.5" aria-hidden />}
              <span className="hidden sm:inline">{online ? t('ioc.online') : t('ioc.offline')}</span>
            </span>
            <Clock />
            <div className="hidden text-right leading-tight xl:block">
              <p className="max-w-[12rem] truncate text-xs font-semibold">{u.name}</p>
              <p className="mono text-[10px] text-ioc-dim">
                {u.staffCode ?? u.roleCode} · {t(`role.${role}`)}
              </p>
            </div>
            <Link
              to="/rescue"
              className="ioc-btn !border-rose-500/40 !text-rose-300"
              title="Mở Cổng Điều phối Đội Cứu Hộ"
            >
              <Siren className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden lg:inline">Cứu Hộ SOS</span>
            </Link>
            <button
              type="button"
              className="ioc-btn !min-w-9 !px-2"
              onClick={() => setDrawerOpen(true)}
              aria-label={t('settings.title')}
            >
              <SettingsIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="ioc-btn !min-w-9 !px-2"
              onClick={() => void authStore.signOut().then(() => nav('/auth'))}
              aria-label={t('nav.logout')}
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </header>

        <OfflineBanner dark />

        <main className="min-w-0 flex-1 p-3 md:p-4">
          <h1 className="sr-only">
            {t('ioc.brand')} — {scopeName}
          </h1>
          <div role="tablist" aria-label={t('ioc.nav.title')} className="mb-3 flex gap-1.5 overflow-x-auto pb-1 md:hidden">
            {navItems.map(({ k, label, icon: Icon }) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={view === k}
                onClick={() => setView(k)}
                className={`ioc-btn shrink-0 ${view === k ? 'ioc-btn-cyan' : ''}`}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {t(label)}
              </button>
            ))}
          </div>

          <p className="mb-3 text-xs text-ioc-dim">
            {t('ioc.scopeNow')}: <span className="font-semibold text-ioc-text">{scopeName}</span>
          </p>

          {view === 'overview' && <OverviewView scope={scope} reports={all} isCity={canPickCityScope && scope === 'city'} />}
          {view === 'queue' && <QueueView scope={scope} isCity={canPickCityScope && scope === 'city'} online={online} />}
          {view === 'map' && (
            <div className="space-y-2">
              <div className="flex gap-2" role="group" aria-label={t('map.mode')}>
                <button
                  type="button"
                  aria-pressed={mapMode === 'pins'}
                  className={`ioc-btn ${mapMode === 'pins' ? 'ioc-btn-cyan' : ''}`}
                  onClick={() => setMapMode('pins')}
                >
                  {t('map.pins')}
                </button>
                <button
                  type="button"
                  aria-pressed={mapMode === 'heat'}
                  className={`ioc-btn ${mapMode === 'heat' ? 'ioc-btn-cyan' : ''}`}
                  onClick={() => setMapMode('heat')}
                >
                  {t('map.heat')}
                </button>
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
          {view === 'audit' && <AuditView scope={scope} isCity={isAdmin} />}
          {view === 'sysadmin' && isAdmin && <SystemAdminView />}
          <p className="mt-6 text-center text-[11px] text-ioc-dim">{t('footer.credit')}</p>
        </main>
      </div>
    </div>
  );
}
