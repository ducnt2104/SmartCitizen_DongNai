import { Building2, Lock, LogOut, Settings as SettingsIcon, ShieldCheck, Users, UserRound, Landmark } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { AuthSession } from '@shared/types';
import { CitizenLogin } from '../components/CitizenLogin';
import { Logo } from '../components/Logo';
import { Spinner } from '../components/ui';
import { DONG_NAI_WARDS } from '../data/dongNaiWards';
import { useI18n } from '../i18n';
import { api, ApiError, NetworkError } from '../lib/api';
import { authStore, useSession } from '../lib/authStore';
import { useSettings } from '../state/settings';
import { useToast } from '../state/toast';

type Tab = 'A' | 'B';
type DemoKind = 'citizen' | 'volunteer' | 'ward_officer' | 'city_admin';

function errText(e: unknown, t: ReturnType<typeof useI18n>['t']): string {
  if (e instanceof NetworkError) return t('auth.offlineErr');
  if (e instanceof ApiError) return e.message;
  return t('state.genericError');
}

export default function AuthPage() {
  const { t } = useI18n();
  const nav = useNavigate();
  const toast = useToast();
  const session = useSession();
  const { set, setDrawerOpen } = useSettings();
  const [tab, setTab] = useState<Tab>('A');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Cổng nội bộ
  const [staffCode, setStaffCode] = useState('');
  const [password, setPassword] = useState('');
  const [unit, setUnit] = useState('DN-TB');
  // Đăng ký tình nguyện viên
  const [volWard, setVolWard] = useState('DN-TB');
  const [volUnit, setVolUnit] = useState('DN-TB-01');

  const go = (s: AuthSession): void => {
    const role = s.user.role;
    if (role === 'city_admin') set({ scope: 'city' });
    if (role === 'ward_officer' && s.user.wardCode) set({ scope: `ward:${s.user.wardCode}` });
    nav(role === 'volunteer' ? '/volunteer' : role === 'citizen' ? '/' : '/admin', { replace: true });
  };

  const staffLogin = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const s = await api<AuthSession>('/api/auth/staff/login', { body: { staffCode: staffCode.trim(), password, unit } });
      authStore.set(s);
      go(s);
    } catch (e) {
      setErr(errText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const demo = async (kind: DemoKind): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const s = await api<AuthSession>('/api/auth/demo', { body: { kind } });
      authStore.set(s);
      toast('success', t('auth.demoOk', { name: s.user.name }));
      go(s);
    } catch (e) {
      setErr(errText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const registerVolunteer = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const s = await api<AuthSession>('/api/auth/volunteer/register', { body: { wardCode: volWard, unitCode: volUnit.trim().toUpperCase() } });
      authStore.set(s);
      toast('success', t('auth.volOk'));
      nav('/volunteer');
    } catch (e) {
      setErr(errText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const demoBar = (dark: boolean): JSX.Element => {
    const base = dark ? 'ioc-btn !min-h-11' : 'btn btn-ghost !min-h-12 !text-sm';
    const items: Array<[DemoKind, string, JSX.Element]> = [
      ['citizen', t('demo.citizen'), <UserRound key="a" className="h-4 w-4" aria-hidden />],
      ['volunteer', t('demo.volunteer'), <Users key="b" className="h-4 w-4" aria-hidden />],
      ['ward_officer', t('demo.officer'), <Building2 key="c" className="h-4 w-4" aria-hidden />],
      ['city_admin', t('demo.city'), <Landmark key="d" className="h-4 w-4" aria-hidden />],
    ];
    return (
      <div className={`mt-6 border-t pt-4 ${dark ? 'border-ioc-line' : 'border-line'}`} aria-label={t('demo.title')}>
        <p className={`mb-2 text-xs font-bold uppercase tracking-wider ${dark ? 'text-ioc-dim' : 'text-muted'}`}>{t('demo.title')}</p>
        <div className="grid grid-cols-2 gap-2">
          {items.map(([k, label, icon]) => (
            <button key={k} type="button" className={`${base} !justify-start`} disabled={busy} onClick={() => void demo(k)}>
              {icon}<span className="min-w-0 break-words text-left leading-tight">{label}</span>
            </button>
          ))}
        </div>
        <p className={`mt-2 text-[11px] ${dark ? 'text-ioc-dim' : 'text-muted'}`}>{t('demo.note')}</p>
      </div>
    );
  };

  const tabs = (dark: boolean): JSX.Element => (
    <div role="tablist" aria-label={t('auth.portals')} className={`grid grid-cols-2 gap-1 rounded-xl p-1 ${dark ? 'border border-ioc-line bg-ioc-panel' : 'bg-surface-2'}`}>
      {(['A', 'B'] as const).map((k) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={tab === k}
          onClick={() => { setTab(k); setErr(null); }}
          className={`min-h-11 rounded-lg px-2 text-sm font-bold leading-tight ${
            tab === k ? (dark ? 'bg-ioc-raised text-ioc-cyan' : 'bg-surface text-brand shadow-card') : dark ? 'text-ioc-dim' : 'text-muted'
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
        <div className="mx-auto flex min-h-dvh max-w-md flex-col px-4 py-5">
          <div className="flex items-center justify-between">
            <Link to="/" aria-label={t('nav.home')}><Logo dark /></Link>
            <button type="button" className="ioc-btn !min-w-9 !px-2" onClick={() => setDrawerOpen(true)} aria-label={t('settings.title')}><SettingsIcon className="h-4 w-4" /></button>
          </div>
          <div className="mt-6">{tabs(true)}</div>
          <div className="ioc-panel mt-4 p-5">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ioc-cyan">{t('ioc.brand')}</p>
            <h1 className="mt-1 text-xl font-bold">{t('auth.iocTitle')}</h1>
            <p className="mt-1 text-sm text-ioc-dim">{t('auth.iocIntro')}</p>
            <form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); void staffLogin(); }}>
              <div>
                <label htmlFor="sc" className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ioc-dim">{t('auth.staffCode')}</label>
                <input id="sc" className="ioc-field mono w-full !min-h-11" value={staffCode} onChange={(e) => setStaffCode(e.target.value)} autoComplete="username" placeholder="CB-TB-01" />
              </div>
              <div>
                <label htmlFor="pw" className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ioc-dim">{t('auth.password')}</label>
                <input id="pw" type="password" className="ioc-field w-full !min-h-11" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              </div>
              <div>
                <label htmlFor="un" className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ioc-dim">{t('auth.unit')}</label>
                <select id="un" className="ioc-field w-full !min-h-11" value={unit} onChange={(e) => setUnit(e.target.value)}>
                  <option value="DN-TB">Phường Trấn Biên</option>
                  <option value="city">{t('auth.unitCity')}</option>
                  <optgroup label={t('auth.unitOther')}>
                    {DONG_NAI_WARDS.filter((w) => w.wardCode !== 'DN-TB').map((w) => <option key={w.wardCode} value={w.wardCode}>{w.name}</option>)}
                  </optgroup>
                </select>
              </div>
              <button type="submit" className="ioc-btn ioc-btn-cyan w-full !min-h-11" disabled={busy || !staffCode || !password}>
                {busy ? <Spinner /> : <Lock className="h-4 w-4" aria-hidden />} {t('auth.staffLogin')}
              </button>
            </form>
            {err && <p role="alert" className="mt-3 rounded border border-red-500/50 bg-red-500/10 p-2 text-sm text-ioc-red">{err}</p>}
            <p className="mt-3 text-[11px] text-ioc-dim">{t('auth.staffNote')}</p>
          </div>
          {demoBar(true)}
          <p className="mt-auto pt-6 text-center text-[11px] text-ioc-dim">{t('footer.credit')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-bg">
      <div className="mx-auto flex min-h-dvh max-w-md flex-col px-4 py-5">
        <div className="flex items-center justify-between">
          <Link to="/" aria-label={t('nav.home')}><Logo /></Link>
          <button type="button" className="btn btn-ghost !min-h-10 !px-2.5" onClick={() => setDrawerOpen(true)} aria-label={t('settings.title')}><SettingsIcon className="h-5 w-5" /></button>
        </div>
        <div className="mt-6">{tabs(false)}</div>
        <div className="card mt-4 space-y-4 p-5">
          <h1 className="text-xl font-extrabold">{t('auth.communityTitle')}</h1>
          {session ? (
            <div className="space-y-3">
              <p className="rounded-xl bg-ok-soft p-3 text-sm font-semibold text-ok"><ShieldCheck className="mr-1 inline h-4 w-4" aria-hidden />{t('auth.loggedAs', { name: session.user.name })}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <button type="button" className="btn btn-primary" onClick={() => go(session)}>{t('auth.continue')}</button>
                <button type="button" className="btn btn-ghost" onClick={() => authStore.clear()}><LogOut className="h-4 w-4" aria-hidden />{t('nav.logout')}</button>
              </div>
            </div>
          ) : (
            <CitizenLogin onDone={(s) => go(s)} />
          )}

          {session?.user.role === 'citizen' && (
            <div className="space-y-3 rounded-2xl border border-brand/40 bg-brand-soft p-4">
              <h2 className="flex items-center gap-2 font-bold text-brand"><Users className="h-5 w-5" aria-hidden />{t('auth.volTitle')}</h2>
              <p className="text-sm">{t('auth.volText')}</p>
              <div>
                <label htmlFor="vw" className="label">{t('auth.volWard')}</label>
                <select id="vw" className="field" value={volWard} onChange={(e) => { setVolWard(e.target.value); setVolUnit(`${e.target.value}-01`); }}>
                  {DONG_NAI_WARDS.map((w) => <option key={w.wardCode} value={w.wardCode}>{w.name}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="vu" className="label">{t('auth.volUnit')}</label>
                <input id="vu" className="field mono" value={volUnit} onChange={(e) => setVolUnit(e.target.value)} placeholder="DN-TB-01" />
              </div>
              <button type="button" className="btn btn-primary w-full" disabled={busy} onClick={() => void registerVolunteer()}>{busy ? <Spinner /> : null}{t('auth.volRegister')}</button>
            </div>
          )}
          {err && <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm font-semibold text-danger">{err}</p>}
        </div>
        {demoBar(false)}
        <p className="mt-auto pt-6 text-center text-xs text-muted">{t('footer.credit')}</p>
      </div>
    </div>
  );
}
