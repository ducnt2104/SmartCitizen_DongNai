import { Award, Bell, CheckCircle2, ClipboardList, Lock, LogOut, MapPin, ShieldAlert, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { UserProfile } from '@shared/types';
import { CitizenLogin } from '../components/CitizenLogin';
import { Spinner } from '../components/ui';
import { DONG_NAI_WARDS, getWard } from '../data/dongNaiWards';
import { useI18n } from '../i18n';
import { api, ApiError, NetworkError } from '../lib/api';
import { authStore, useSession } from '../lib/authStore';
import { useSettings } from '../state/settings';
import { useToast } from '../state/toast';

const WARDS_PHUONG = DONG_NAI_WARDS.filter((w) => w.kind === 'Phường');
const WARDS_XA = DONG_NAI_WARDS.filter((w) => w.kind === 'Xã');

/** Trang Hồ sơ Công dân & Quản lý Phiên (JWT + HTTP-only Refresh Cookie). */
export default function ProfilePage() {
  const { t } = useI18n();
  const nav = useNavigate();
  const toast = useToast();
  const session = useSession();
  const { set } = useSettings();

  const u = session?.user ?? null;
  const [name, setName] = useState(u?.name ?? '');
  const [defaultWardCode, setDefaultWardCode] = useState(u?.defaultWardCode ?? '');
  const [notificationsEnabled, setNotificationsEnabled] = useState(u?.notificationsEnabled ?? true);
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!u) {
    return (
      <div className="mx-auto max-w-md space-y-4">
        <div className="card p-5">
          <h1 className="text-xl font-extrabold">{t('profile.title')}</h1>
          <p className="mt-1 text-sm text-muted">{t('profile.loginRequired')}</p>
          <div className="mt-4">
            <CitizenLogin onDone={(s) => { setName(s.user.name); setDefaultWardCode(s.user.defaultWardCode ?? ''); }} />
          </div>
        </div>
      </div>
    );
  }

  const saveProfile = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        defaultWardCode: defaultWardCode || null,
        notificationsEnabled,
      };
      if (newPassword.trim()) payload.newPassword = newPassword.trim();
      const res = await api<{ user: UserProfile }>('/api/me/profile', { method: 'PATCH', body: payload });
      authStore.updateUser(res.user);
      if (res.user.defaultWardCode) {
        set({ scope: `ward:${res.user.defaultWardCode}` });
      }
      setNewPassword('');
      toast('success', t('profile.saved'));
    } catch (error) {
      if (error instanceof NetworkError) setErr(t('auth.offlineErr'));
      else if (error instanceof ApiError) setErr(error.message);
      else setErr(t('state.genericError'));
    } finally {
      setBusy(false);
    }
  };

  const logoutThis = async (): Promise<void> => {
    setBusy(true);
    await authStore.signOut();
    toast('info', t('profile.loggedOut'));
    nav('/', { replace: true });
  };

  const logoutAll = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await api('/api/auth/logout-all', { method: 'POST' });
      authStore.clear();
      toast('success', t('profile.loggedOutAll'));
      nav('/auth', { replace: true });
    } catch (error) {
      if (error instanceof ApiError) setErr(error.message);
      else setErr(t('state.genericError'));
    } finally {
      setBusy(false);
    }
  };

  const defaultWardName = u.defaultWardCode ? getWard(u.defaultWardCode)?.name : null;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="card flex flex-wrap items-center gap-4 p-5">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-brand text-xl font-extrabold text-brand-ink">
          {u.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-extrabold">{u.name}</h1>
          <p className="text-sm text-muted">
            {t(`role.${u.role}`)}
            {u.email ? ` · ${u.email}` : ''}
            {u.phoneMasked ? ` · ${u.phoneMasked}` : ''}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="pill bg-brand-soft font-bold text-brand">
              <Award className="h-3.5 w-3.5" aria-hidden /> {t('auth.trust')}: <span className="mono">{u.trustScore}</span>
            </span>
            {defaultWardName && (
              <span className="pill bg-surface-2 font-semibold">
                <MapPin className="h-3.5 w-3.5" aria-hidden /> {defaultWardName}
              </span>
            )}
            {u.badges.map((b) => (
              <span key={b} className="pill bg-ok-soft font-semibold text-ok">{b}</span>
            ))}
          </div>
        </div>
        <Link to="/mine" className="btn btn-soft !min-h-10 !text-sm">
          <ClipboardList className="h-4 w-4" aria-hidden /> {t('nav.mine')}
        </Link>
      </div>

      <form onSubmit={(e) => void saveProfile(e)} className="card space-y-4 p-5">
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <UserRound className="h-5 w-5 text-brand" aria-hidden /> {t('profile.infoTitle')}
        </h2>

        <div>
          <label htmlFor="prof-name" className="label">{t('profile.name')}</label>
          <input
            id="prof-name"
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            minLength={2}
            maxLength={80}
            required
          />
        </div>

        <div>
          <label htmlFor="prof-ward" className="label">{t('profile.defaultWard')}</label>
          <select id="prof-ward" className="field" value={defaultWardCode} onChange={(e) => setDefaultWardCode(e.target.value)}>
            <option value="">{t('profile.noDefaultWard')}</option>
            <optgroup label={t('scope.groupPhuong')}>
              {WARDS_PHUONG.map((w) => <option key={w.wardCode} value={w.wardCode}>{w.name}</option>)}
            </optgroup>
            <optgroup label={t('scope.groupXa')}>
              {WARDS_XA.map((w) => <option key={w.wardCode} value={w.wardCode}>{w.name}</option>)}
            </optgroup>
          </select>
        </div>

        <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 p-3">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Bell className="h-4 w-4 text-brand" aria-hidden /> {t('profile.notifyToggle')}
          </span>
          <input
            type="checkbox"
            checked={notificationsEnabled}
            onChange={(e) => setNotificationsEnabled(e.target.checked)}
            className="h-5 w-5 accent-brand"
          />
        </label>

        <div>
          <label htmlFor="prof-pw" className="label">
            <Lock className="mr-1 inline h-4 w-4" aria-hidden /> {t('profile.setPassword')}
          </label>
          <input
            id="prof-pw"
            type="password"
            className="field"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder={t('auth.passwordMinHint')}
            minLength={8}
          />
        </div>

        {err && <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm font-semibold text-danger">{err}</p>}

        <button type="submit" className="btn btn-primary w-full" disabled={busy || name.trim().length < 2}>
          {busy ? <Spinner /> : <CheckCircle2 className="h-5 w-5" aria-hidden />} {t('profile.save')}
        </button>
      </form>

      <div className="card space-y-3 p-5">
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <ShieldAlert className="h-5 w-5 text-brand" aria-hidden /> {t('profile.securityTitle')}
        </h2>
        <p className="text-sm text-muted">{t('profile.securityDesc')}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void logoutThis()}>
            <LogOut className="h-4 w-4" aria-hidden /> {t('profile.logoutThis')}
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void logoutAll()}>
            <ShieldAlert className="h-4 w-4" aria-hidden /> {t('profile.logoutAll')}
          </button>
        </div>
      </div>
    </div>
  );
}
