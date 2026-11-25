import { Lock, LogOut, Settings as SettingsIcon, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { normalizeRole } from '@shared/constants';
import type { AuthSession } from '@shared/types';
import { CitizenLogin } from '../components/CitizenLogin';
import { Logo } from '../components/Logo';
import { Spinner } from '../components/ui';
import { useI18n } from '../i18n';
import { api, ApiError, NetworkError } from '../lib/api';
import { authStore, useSession } from '../lib/authStore';
import { useSettings } from '../state/settings';

type Tab = 'A' | 'B';

function errText(e: unknown, t: ReturnType<typeof useI18n>['t']): string {
  if (e instanceof NetworkError) return t('auth.offlineErr');
  if (e instanceof ApiError) return e.message;
  return t('state.genericError');
}

export default function AuthPage() {
  const { t } = useI18n();
  const nav = useNavigate();
  const loc = useLocation();
  const session = useSession();
  const { set, setDrawerOpen } = useSettings();

  const fromPath = typeof (loc.state as { from?: unknown } | null)?.from === 'string'
    ? String((loc.state as { from: string }).from)
    : '';
  const initialTab: Tab =
    fromPath.startsWith('/admin') ||
    fromPath.startsWith('/ioc') ||
    fromPath.startsWith('/dashboard') ||
    fromPath.startsWith('/rescue')
      ? 'B'
      : 'A';

  const [tab, setTab] = useState<Tab>(initialTab);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Cổng Đăng nhập Nội bộ duy nhất cho ADMIN · OFFICER · RESCUE
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');

  const go = (s: AuthSession): void => {
    const role = normalizeRole(s.user.role);
    if (role === 'admin') {
      set({ scope: 'city' });
      nav('/admin', { replace: true });
      return;
    }
    if (role === 'officer') {
      set({ scope: s.user.wardCode ? `ward:${s.user.wardCode}` : 'city' });
      nav('/ioc', { replace: true });
      return;
    }
    if (role === 'rescue') {
      if (s.user.wardCode) set({ scope: `ward:${s.user.wardCode}` });
      nav('/rescue', { replace: true });
      return;
    }
    if (s.user.defaultWardCode) set({ scope: `ward:${s.user.defaultWardCode}` });
    nav('/', { replace: true });
  };

  const internalLogin = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const s = await api<AuthSession>('/api/auth/staff/login', {
        body: { identifier: identifier.trim(), password },
      });
      authStore.set(s);
      go(s);
    } catch (e) {
      setErr(errText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const tabs = (dark: boolean): JSX.Element => (
    <div
      role="tablist"
      aria-label={t('auth.portals')}
      className={`grid grid-cols-2 gap-1 rounded-2xl p-1 ${
        dark ? 'border border-ioc-line bg-ioc-panel shadow-sm' : 'border border-line/75 bg-surface-2/90 shadow-sm'
      }`}
    >
      {(['A', 'B'] as const).map((k) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={tab === k}
          onClick={() => {
            setTab(k);
            setErr(null);
          }}
          className={`min-h-11 rounded-xl px-2 text-xs font-bold leading-tight transition-all sm:text-sm ${
            tab === k
              ? dark
                ? 'bg-ioc-raised text-ioc-cyan shadow-sm'
                : 'bg-surface text-brand shadow-card'
              : dark
                ? 'text-ioc-dim hover:text-ioc-text'
                : 'text-muted hover:text-ink'
          }`}
        >
          {k === 'A' ? t('auth.tabA') : t('auth.tabB')}
        </button>
      ))}
    </div>
  );

  if (tab === 'B') {
    return (
      <div className="ioc min-h-dvh">
        <div className="mx-auto flex min-h-dvh max-w-md flex-col px-4 py-5 sm:py-7">
          <div className="flex items-center justify-between">
            <Link to="/" aria-label={t('nav.home')}>
              <Logo dark />
            </Link>
            <button
              type="button"
              className="ioc-btn !min-w-9 !px-2"
              onClick={() => setDrawerOpen(true)}
              aria-label={t('settings.title')}
            >
              <SettingsIcon className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-5">{tabs(true)}</div>
          <div className="ioc-panel mt-4 rounded-2xl p-5 shadow-lift">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ioc-cyan">{t('ioc.brand')}</p>
            <h1 className="mt-1 text-xl font-bold">{t('auth.iocTitle')}</h1>
            <p className="mt-1 text-sm text-ioc-dim">{t('auth.iocIntro')}</p>

            {session && normalizeRole(session.user.role) !== 'citizen' ? (
              <div className="mt-4 space-y-3">
                <p className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm font-semibold text-ioc-green">
                  <ShieldCheck className="mr-1.5 inline h-4 w-4" aria-hidden />
                  {t('auth.loggedAs', { name: session.user.name })}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <button type="button" className="ioc-btn ioc-btn-cyan !min-h-11 justify-center" onClick={() => go(session)}>
                    {t('auth.continue')}
                  </button>
                  <button type="button" className="ioc-btn !min-h-11 justify-center" onClick={() => void authStore.signOut()}>
                    <LogOut className="h-4 w-4" aria-hidden />
                    {t('nav.logout')}
                  </button>
                </div>
              </div>
            ) : (
              <form
                className="mt-4 space-y-3.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  void internalLogin();
                }}
              >
                <div>
                  <label
                    htmlFor="internal-id"
                    className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ioc-dim"
                  >
                    {t('auth.staffCode')}
                  </label>
                  <input
                    id="internal-id"
                    className="ioc-field mono w-full !min-h-11"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    autoComplete="username"
                    placeholder="Mã tài khoản, Email hoặc SĐT"
                  />
                </div>
                <div>
                  <label
                    htmlFor="internal-pw"
                    className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ioc-dim"
                  >
                    {t('auth.password')}
                  </label>
                  <input
                    id="internal-pw"
                    type="password"
                    className="ioc-field w-full !min-h-11"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                </div>
                <button
                  type="submit"
                  className="ioc-btn ioc-btn-cyan w-full !min-h-11 justify-center"
                  disabled={busy || identifier.trim().length < 2 || !password}
                >
                  {busy ? <Spinner /> : <Lock className="h-4 w-4" aria-hidden />} {t('auth.staffLogin')}
                </button>
              </form>
            )}

            {err && (
              <p role="alert" className="mt-3 rounded border border-red-500/50 bg-red-500/10 p-2.5 text-sm text-ioc-red">
                {err}
              </p>
            )}
          </div>
          <p className="mt-auto pt-6 text-center text-[11px] text-ioc-dim">{t('footer.credit')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh">
      <div className="mx-auto flex min-h-dvh max-w-md flex-col px-4 py-5 sm:py-7">
        <div className="flex items-center justify-between">
          <Link to="/" aria-label={t('nav.home')}>
            <Logo />
          </Link>
          <button
            type="button"
            className="btn btn-ghost !min-h-10 !min-w-10 !px-2.5"
            onClick={() => setDrawerOpen(true)}
            aria-label={t('settings.title')}
          >
            <SettingsIcon className="h-5 w-5" />
          </button>
        </div>
        <div className="mt-5">{tabs(false)}</div>
        <div className="card mt-4 space-y-4 rounded-3xl p-5 shadow-lift">
          <h1 className="text-xl font-extrabold">{t('auth.communityTitle')}</h1>
          {session ? (
            <div className="space-y-3">
              <p className="rounded-xl bg-ok-soft p-3 text-sm font-semibold text-ok">
                <ShieldCheck className="mr-1 inline h-4 w-4" aria-hidden />
                {t('auth.loggedAs', { name: session.user.name })}
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <button type="button" className="btn btn-primary" onClick={() => go(session)}>
                  {t('auth.continue')}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => void authStore.signOut()}>
                  <LogOut className="h-4 w-4" aria-hidden />
                  {t('nav.logout')}
                </button>
              </div>
            </div>
          ) : (
            <CitizenLogin onDone={(s) => go(s)} />
          )}
          {err && <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm font-semibold text-danger">{err}</p>}
        </div>
        <p className="mt-auto pt-6 text-center text-xs text-muted">{t('footer.credit')}</p>
      </div>
    </div>
  );
}
