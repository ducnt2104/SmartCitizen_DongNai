import { Award, Bell, CheckCircle2, ClipboardList, KeyRound, Lock, LogOut, Mail, MapPin, Monitor, Phone, ShieldAlert, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { AuthSession, SessionInfo, UserProfile } from '@shared/types';
import { CitizenLogin } from '../components/CitizenLogin';
import { Spinner } from '../components/ui';
import { normalizeRole } from '@shared/constants';
import { DONG_NAI_WARDS, getWard } from '../data/dongNaiWards';
import { useI18n } from '../i18n';
import { api, ApiError, NetworkError } from '../lib/api';
import { authStore, useSession } from '../lib/authStore';
import { useSettings } from '../state/settings';
import { useToast } from '../state/toast';

const WARDS_PHUONG = DONG_NAI_WARDS.filter((w) => w.kind === 'Phường');
const WARDS_XA = DONG_NAI_WARDS.filter((w) => w.kind === 'Xã');

/** Trang Hồ sơ Công dân, Bảo mật tài khoản (Đổi MK/Email/SĐT đá phiên cũ) & Quản lý Phiên. */
export default function ProfilePage() {
  const { t, fmtDate } = useI18n();
  const nav = useNavigate();
  const toast = useToast();
  const session = useSession();
  const { set } = useSettings();

  const u = session?.user ?? null;
  const [name, setName] = useState(u?.name ?? '');
  const [defaultWardCode, setDefaultWardCode] = useState(u?.defaultWardCode ?? '');
  const [notificationsEnabled, setNotificationsEnabled] = useState(u?.notificationsEnabled ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Đổi mật khẩu (kèm đá thiết bị khác)
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  // Đổi Email / Đổi SĐT (kèm OTP xác thực)
  const [newEmail, setNewEmail] = useState('');
  const [emailOtp, setEmailOtp] = useState('');
  const [emailOtpSent, setEmailOtpSent] = useState(false);

  const [newPhone, setNewPhone] = useState('');
  const [phoneOtp, setPhoneOtp] = useState('');
  const [phoneOtpSent, setPhoneOtpSent] = useState(false);

  // Danh sách phiên hoạt động
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  useEffect(() => {
    if (!u) return;
    api<SessionInfo[]>('/api/me/sessions')
      .then(setSessions)
      .catch(() => undefined);
  }, [u?.id]);

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
      const res = await api<{ user: UserProfile }>('/api/me/profile', {
        method: 'PATCH',
        body: {
          name: name.trim(),
          defaultWardCode: defaultWardCode || null,
          notificationsEnabled,
        },
      });
      authStore.updateUser(res.user);
      if (res.user.defaultWardCode) {
        set({ scope: `ward:${res.user.defaultWardCode}` });
      }
      toast('success', t('profile.saved'));
    } catch (error) {
      if (error instanceof NetworkError) setErr(t('auth.offlineErr'));
      else if (error instanceof ApiError) setErr(error.message);
      else setErr(t('state.genericError'));
    } finally {
      setBusy(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await api<AuthSession & { revokedOtherSessions: number }>('/api/auth/change-password', {
        method: 'POST',
        body: {
          ...(currentPassword ? { currentPassword } : {}),
          newPassword: newPassword.trim(),
        },
      });
      authStore.set({ token: res.token, user: res.user });
      setCurrentPassword('');
      setNewPassword('');
      toast(
        'success',
        'Đã đổi mật khẩu & bảo vệ phiên',
        res.revokedOtherSessions > 0
          ? `Đã đăng xuất ${res.revokedOtherSessions} thiết bị khác.`
          : 'Mật khẩu mới đã có hiệu lực cho phiên hiện tại.',
      );
      api<SessionInfo[]>('/api/me/sessions').then(setSessions).catch(() => undefined);
    } catch (error) {
      setErr(error instanceof ApiError ? error.message : t('state.genericError'));
    } finally {
      setBusy(false);
    }
  };

  const sendContactOtp = async (channel: 'email' | 'phone'): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const target = channel === 'email' ? newEmail.trim() : newPhone.trim();
      await api('/api/auth/otp/send', {
        method: 'POST',
        body: { channel, target, purpose: channel === 'email' ? 'change_email' : 'change_phone' },
      });
      if (channel === 'email') setEmailOtpSent(true);
      else setPhoneOtpSent(true);
      toast('success', 'Đã gửi mã OTP xác thực', `Kiểm tra ${target}`);
    } catch (error) {
      setErr(error instanceof ApiError ? error.message : t('state.genericError'));
    } finally {
      setBusy(false);
    }
  };

  const handleChangeEmail = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await api<AuthSession & { revokedOtherSessions: number }>('/api/auth/change-email', {
        method: 'POST',
        body: {
          newEmail: newEmail.trim(),
          otpCode: emailOtp.trim(),
          ...(currentPassword ? { currentPassword } : {}),
        },
      });
      authStore.set({ token: res.token, user: res.user });
      setNewEmail('');
      setEmailOtp('');
      setEmailOtpSent(false);
      toast('success', 'Đã cập nhật Email & đá toàn bộ thiết bị khác');
    } catch (error) {
      setErr(error instanceof ApiError ? error.message : t('state.genericError'));
    } finally {
      setBusy(false);
    }
  };

  const handleChangePhone = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await api<AuthSession & { revokedOtherSessions: number }>('/api/auth/change-phone', {
        method: 'POST',
        body: {
          newPhone: newPhone.trim(),
          otpCode: phoneOtp.trim(),
          ...(currentPassword ? { currentPassword } : {}),
        },
      });
      authStore.set({ token: res.token, user: res.user });
      setNewPhone('');
      setPhoneOtp('');
      setPhoneOtpSent(false);
      toast('success', 'Đã cập nhật SĐT & đá toàn bộ thiết bị khác');
    } catch (error) {
      setErr(error instanceof ApiError ? error.message : t('state.genericError'));
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
      <div className="card relative flex flex-wrap items-center gap-4 overflow-hidden p-5">
        <div className="hero-gradient absolute inset-x-0 top-0 h-1.5" aria-hidden />
        <div className="hero-gradient grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-xl font-extrabold text-brand-ink">
          {(u.name || '?').slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-extrabold">{u.name}</h1>
          <p className="text-sm text-muted">
            {t(`role.${normalizeRole(u.role)}`)}
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
            {(u.badges ?? []).map((b) => (
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

        {err && <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm font-semibold text-danger">{err}</p>}

        <button type="submit" className="btn btn-primary w-full" disabled={busy || name.trim().length < 2}>
          {busy ? <Spinner /> : <CheckCircle2 className="h-5 w-5" aria-hidden />} {t('profile.save')}
        </button>
      </form>

      {/* Đổi mật khẩu (tự động thu hồi toàn bộ phiên thiết bị khác) */}
      <form onSubmit={(e) => void handleChangePassword(e)} className="card space-y-3 p-5">
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <KeyRound className="h-5 w-5 text-brand" aria-hidden /> Đổi mật khẩu bảo mật
        </h2>
        <p className="text-xs text-muted">
          Tối thiểu 8 ký tự gồm chữ hoa, chữ thường, số và ký tự đặc biệt. Đổi mật khẩu sẽ tự động đăng xuất toàn bộ thiết bị khác.
        </p>
        {u.hasPassword && (
          <div>
            <label htmlFor="cur-pw" className="label">Mật khẩu hiện tại</label>
            <input
              id="cur-pw"
              type="password"
              className="field"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
          </div>
        )}
        <div>
          <label htmlFor="prof-pw" className="label">
            <Lock className="mr-1 inline h-4 w-4" aria-hidden /> Mật khẩu mới
          </label>
          <input
            id="prof-pw"
            type="password"
            className="field"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="VD: DongNai@2026!"
            minLength={8}
            required
          />
        </div>
        <button type="submit" className="btn btn-soft w-full" disabled={busy || newPassword.length < 8}>
          {busy ? <Spinner /> : <Lock className="h-4 w-4" aria-hidden />} Cập nhật mật khẩu &amp; đá thiết bị khác
        </button>
      </form>

      {/* Đổi Email / Số điện thoại (xác thực OTP + mật khẩu) */}
      <div className="card space-y-4 p-5">
        <h2 className="text-base font-bold">Đổi Email / Số điện thoại liên hệ</h2>
        <form onSubmit={(e) => void handleChangeEmail(e)} className="grid gap-2 sm:grid-cols-3">
          <input
            type="email"
            className="field sm:col-span-2"
            placeholder="Email mới (vd: congdan@gmail.com)"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy || !newEmail.includes('@')}
            onClick={() => void sendContactOtp('email')}
          >
            <Mail className="h-4 w-4" aria-hidden /> Gửi OTP
          </button>
          {emailOtpSent && (
            <>
              <input
                className="field mono"
                placeholder="OTP 6 số"
                value={emailOtp}
                onChange={(e) => setEmailOtp(e.target.value)}
                minLength={6}
                maxLength={6}
                required
              />
              <button type="submit" className="btn btn-primary sm:col-span-2" disabled={busy || emailOtp.length !== 6}>
                Xác nhận đổi Email
              </button>
            </>
          )}
        </form>

        <form onSubmit={(e) => void handleChangePhone(e)} className="grid gap-2 sm:grid-cols-3">
          <input
            type="tel"
            className="field sm:col-span-2"
            placeholder="SĐT mới (vd: 0912345678)"
            value={newPhone}
            onChange={(e) => setNewPhone(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy || newPhone.length < 9}
            onClick={() => void sendContactOtp('phone')}
          >
            <Phone className="h-4 w-4" aria-hidden /> Gửi SMS OTP
          </button>
          {phoneOtpSent && (
            <>
              <input
                className="field mono"
                placeholder="OTP 6 số"
                value={phoneOtp}
                onChange={(e) => setPhoneOtp(e.target.value)}
                minLength={6}
                maxLength={6}
                required
              />
              <button type="submit" className="btn btn-primary sm:col-span-2" disabled={busy || phoneOtp.length !== 6}>
                Xác nhận đổi SĐT
              </button>
            </>
          )}
        </form>
      </div>

      {/* Phiên đăng nhập hiện tại (Single-Session) */}
      <div className="card space-y-3 p-5">
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <ShieldAlert className="h-5 w-5 text-brand" aria-hidden /> {t('profile.securityTitle')}
        </h2>
        <p className="text-sm text-muted">{t('profile.securityDesc')}</p>
        {sessions.length > 0 && (
          <div className="space-y-1.5">
            {sessions.map((s) => (
              <div key={s.id} className="flex items-center justify-between rounded-xl border border-line bg-surface-2 px-3 py-2 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <Monitor className="h-4 w-4 shrink-0 text-brand" aria-hidden />
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{s.userAgent || s.deviceFingerprint}</p>
                    <p className="mono text-[11px] text-muted">
                      IP: {s.ip} · Hoạt động: {fmtDate(new Date(s.lastActiveAt).toISOString())}
                    </p>
                  </div>
                </div>
                {s.isCurrent && <span className="pill bg-ok-soft text-ok font-bold">Thiết bị này</span>}
              </div>
            ))}
          </div>
        )}
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
