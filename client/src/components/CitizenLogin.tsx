import { AlertTriangle, KeyRound, Lock, Mail, RotateCcw, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AuthSession } from '@shared/types';
import { DONG_NAI_WARDS } from '../data/dongNaiWards';
import { useI18n } from '../i18n';
import { api, ApiError, NetworkError } from '../lib/api';
import { authStore } from '../lib/authStore';
import { useToast } from '../state/toast';
import { Spinner } from './ui';

interface OtpRequestResponse {
  channel: 'email' | 'sms';
  targetMasked: string;
  resendInSec: number;
  expiresInSec: number;
  provider: string;
}

interface OtpStatusResponse {
  emailConfigured: boolean;
  smsConfigured: boolean;
  activeEmailProvider: string | null;
  activeSmsProvider: string | null;
  configuredProviderMode: string;
}

type AuthMode = 'otp' | 'password' | 'reset';

const WARDS_PHUONG = DONG_NAI_WARDS.filter((w) => w.kind === 'Phường');
const WARDS_XA = DONG_NAI_WARDS.filter((w) => w.kind === 'Xã');

/**
 * Xác thực Công dân Thật (Zero Mock Auth / Zero Fake OTP):
 * - Gửi mã OTP 6 số thật qua Email (Resend / SMTP) hoặc SMS (Twilio / eSMS).
 * - Hỗ trợ đăng nhập bằng Email/SĐT + Mật khẩu và khôi phục mật khẩu qua OTP thật.
 * - Phiên được bảo vệ bởi HTTP-only Access/Refresh Cookies có xoay vòng token.
 */
export function CitizenLogin({ onDone, compact = false }: { onDone: (s: AuthSession) => void; compact?: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const [mode, setMode] = useState<AuthMode>('otp');
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [defaultWardCode, setDefaultWardCode] = useState('');
  const [stage, setStage] = useState<'input' | 'code'>('input');
  const [targetMasked, setTargetMasked] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [otpStatus, setOtpStatus] = useState<OtpStatusResponse | null>(null);

  useEffect(() => {
    let active = true;
    void api<OtpStatusResponse>('/api/auth/otp/status')
      .then((res) => { if (active) setOtpStatus(res); })
      .catch(() => { /* bỏ qua khi ngoại tuyến */ });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(id);
  }, [cooldown]);

  const fail = (e: unknown): void => {
    if (e instanceof NetworkError) setErr(t('auth.offlineErr'));
    else if (e instanceof ApiError) setErr(e.message);
    else setErr(t('state.genericError'));
  };

  const resetFormState = (nextMode: AuthMode): void => {
    setMode(nextMode);
    setStage('input');
    setCode('');
    setErr(null);
  };

  const requestOtp = async (purpose: 'login' | 'reset_password'): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<OtpRequestResponse>('/api/auth/otp/request', {
        body: { identifier: identifier.trim(), purpose },
      });
      setStage('code');
      setTargetMasked(r.targetMasked);
      setCooldown(r.resendInSec);
      toast('info', t('auth.otpSentToast', { target: r.targetMasked }));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const verifyOtp = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const payload: Record<string, unknown> = {
        identifier: identifier.trim(),
        code,
      };
      if (name.trim().length >= 2) payload.name = name.trim();
      if (password.length >= 8) payload.password = password;
      if (defaultWardCode) payload.defaultWardCode = defaultWardCode;
      const s = await api<AuthSession>('/api/auth/otp/verify', { body: payload });
      authStore.set(s);
      onDone(s);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const loginWithPassword = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const s = await api<AuthSession>('/api/auth/password/login', {
        body: { identifier: identifier.trim(), password },
      });
      authStore.set(s);
      onDone(s);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const submitPasswordReset = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const s = await api<AuthSession>('/api/auth/password/reset', {
        body: { identifier: identifier.trim(), code, newPassword: password },
      });
      authStore.set(s);
      toast('success', t('auth.resetSuccess'));
      onDone(s);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const providerUnconfigured = otpStatus !== null && !otpStatus.emailConfigured && !otpStatus.smsConfigured;

  return (
    <div className="space-y-4">
      {!compact && <p className="text-sm text-muted">{t('auth.citizenIntro')}</p>}

      {/* Chuyển đổi OTP thật / Mật khẩu */}
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-2 p-1" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'otp' || mode === 'reset'}
          onClick={() => resetFormState('otp')}
          className={`min-h-10 rounded-lg px-2 text-sm font-bold transition ${
            mode === 'otp' || mode === 'reset' ? 'bg-surface text-brand shadow-card' : 'text-muted'
          }`}
        >
          <KeyRound className="mr-1 inline h-4 w-4" aria-hidden /> {t('auth.modeOtp')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'password'}
          onClick={() => resetFormState('password')}
          className={`min-h-10 rounded-lg px-2 text-sm font-bold transition ${
            mode === 'password' ? 'bg-surface text-brand shadow-card' : 'text-muted'
          }`}
        >
          <Lock className="mr-1 inline h-4 w-4" aria-hidden /> {t('auth.modePassword')}
        </button>
      </div>

      {/* Cảnh báo rõ ràng nếu máy chủ chưa cấu hình nhà cung cấp OTP thật */}
      {providerUnconfigured && mode !== 'password' && (
        <div role="status" className="rounded-xl border border-warn/40 bg-warn-soft p-3 text-xs text-warn">
          <p className="flex items-center gap-1.5 font-bold">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            {t('auth.otpUnconfiguredTitle')}
          </p>
          <p className="mt-1 leading-relaxed">{t('auth.otpUnconfiguredHint')}</p>
        </div>
      )}

      {/* Trạng thái kênh OTP khả dụng */}
      {otpStatus && !providerUnconfigured && mode !== 'password' && (
        <p className="rounded-xl bg-brand-soft px-3 py-2 text-xs font-semibold text-brand">
          {otpStatus.emailConfigured && otpStatus.smsConfigured
            ? t('auth.channelBoth')
            : otpStatus.emailConfigured
              ? t('auth.channelEmailOnly')
              : t('auth.channelSmsOnly')}
        </p>
      )}

      {mode === 'password' && (
        <form onSubmit={(e) => { e.preventDefault(); void loginWithPassword(); }} className="space-y-3">
          <div>
            <label htmlFor="id-pw" className="label">
              <Mail className="mr-1 inline h-4 w-4" aria-hidden />{t('auth.identifier')}
            </label>
            <input
              id="id-pw"
              className="field"
              autoComplete="username"
              placeholder={t('auth.identifierPlaceholder')}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="pw-cit" className="label">
              <Lock className="mr-1 inline h-4 w-4" aria-hidden />{t('auth.password')}
            </label>
            <input
              id="pw-cit"
              type="password"
              className="field"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-primary w-full" disabled={busy || identifier.trim().length < 5 || !password}>
            {busy ? <Spinner /> : <Lock className="h-5 w-5" aria-hidden />} {t('auth.loginPassword')}
          </button>
          <div className="text-right">
            <button
              type="button"
              className="text-sm font-semibold text-brand underline"
              onClick={() => resetFormState('reset')}
            >
              {t('auth.forgotPassword')}
            </button>
          </div>
        </form>
      )}

      {mode === 'otp' && stage === 'input' && (
        <form onSubmit={(e) => { e.preventDefault(); void requestOtp('login'); }} className="space-y-3">
          <div>
            <label htmlFor="id-otp" className="label">
              <Mail className="mr-1 inline h-4 w-4" aria-hidden />{t('auth.identifier')}
            </label>
            <input
              id="id-otp"
              className="field"
              autoComplete="email"
              placeholder={t('auth.identifierPlaceholder')}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              maxLength={120}
            />
          </div>
          <button type="submit" className="btn btn-primary w-full" disabled={busy || identifier.trim().length < 5}>
            {busy ? <Spinner /> : <KeyRound className="h-5 w-5" aria-hidden />} {t('auth.sendOtp')}
          </button>
        </form>
      )}

      {mode === 'otp' && stage === 'code' && (
        <form onSubmit={(e) => { e.preventDefault(); void verifyOtp(); }} className="space-y-3">
          <div className="rounded-xl bg-ok-soft px-3 py-2 text-xs font-semibold text-ok">
            {t('auth.otpSentDetail', { target: targetMasked })}
          </div>
          <div>
            <label htmlFor="otp-code" className="label">
              <ShieldCheck className="mr-1 inline h-4 w-4" aria-hidden />{t('auth.otpLabel')}
            </label>
            <input
              id="otp-code"
              className="field mono text-center text-2xl tracking-[0.5em]"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              autoFocus
            />
          </div>

          {!compact && (
            <details className="rounded-xl border border-line bg-surface-2 p-3 text-sm">
              <summary className="cursor-pointer font-semibold text-muted">{t('auth.optionalSetup')}</summary>
              <div className="mt-3 space-y-2.5">
                <div>
                  <label htmlFor="opt-name" className="label text-xs">{t('profile.name')}</label>
                  <input id="opt-name" className="field !min-h-10 text-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('profile.namePlaceholder')} maxLength={80} />
                </div>
                <div>
                  <label htmlFor="opt-ward" className="label text-xs">{t('profile.defaultWard')}</label>
                  <select id="opt-ward" className="field !min-h-10 text-sm" value={defaultWardCode} onChange={(e) => setDefaultWardCode(e.target.value)}>
                    <option value="">{t('profile.noDefaultWard')}</option>
                    <optgroup label={t('scope.groupPhuong')}>
                      {WARDS_PHUONG.map((w) => <option key={w.wardCode} value={w.wardCode}>{w.name}</option>)}
                    </optgroup>
                    <optgroup label={t('scope.groupXa')}>
                      {WARDS_XA.map((w) => <option key={w.wardCode} value={w.wardCode}>{w.name}</option>)}
                    </optgroup>
                  </select>
                </div>
                <div>
                  <label htmlFor="opt-pw" className="label text-xs">{t('auth.optionalPassword')}</label>
                  <input id="opt-pw" type="password" className="field !min-h-10 text-sm" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" minLength={8} />
                </div>
              </div>
            </details>
          )}

          <button type="submit" className="btn btn-primary w-full" disabled={busy || code.length !== 6}>
            {busy ? <Spinner /> : <ShieldCheck className="h-5 w-5" aria-hidden />} {t('auth.verify')}
          </button>
          <div className="flex items-center justify-between text-sm">
            <button type="button" className="font-semibold text-brand underline" onClick={() => { setStage('input'); setCode(''); setErr(null); }}>
              {t('auth.changePhone')}
            </button>
            <button
              type="button"
              className="font-semibold text-brand underline disabled:text-muted disabled:no-underline"
              disabled={cooldown > 0 || busy}
              onClick={() => void requestOtp('login')}
            >
              {cooldown > 0 ? t('auth.resendIn', { s: cooldown }) : t('auth.resend')}
            </button>
          </div>
        </form>
      )}

      {mode === 'reset' && stage === 'input' && (
        <form onSubmit={(e) => { e.preventDefault(); void requestOtp('reset_password'); }} className="space-y-3">
          <p className="text-sm font-semibold">{t('auth.resetTitle')}</p>
          <div>
            <label htmlFor="id-reset" className="label">
              <RotateCcw className="mr-1 inline h-4 w-4" aria-hidden />{t('auth.identifier')}
            </label>
            <input
              id="id-reset"
              className="field"
              placeholder={t('auth.identifierPlaceholder')}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-primary w-full" disabled={busy || identifier.trim().length < 5}>
            {busy ? <Spinner /> : <KeyRound className="h-5 w-5" aria-hidden />} {t('auth.sendResetOtp')}
          </button>
        </form>
      )}

      {mode === 'reset' && stage === 'code' && (
        <form onSubmit={(e) => { e.preventDefault(); void submitPasswordReset(); }} className="space-y-3">
          <div className="rounded-xl bg-ok-soft px-3 py-2 text-xs font-semibold text-ok">
            {t('auth.otpSentDetail', { target: targetMasked })}
          </div>
          <div>
            <label htmlFor="rst-code" className="label">{t('auth.otpLabel')}</label>
            <input
              id="rst-code"
              className="field mono text-center text-2xl tracking-[0.5em]"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="rst-pw" className="label">{t('auth.newPassword')}</label>
            <input
              id="rst-pw"
              type="password"
              className="field"
              autoComplete="new-password"
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('auth.passwordMinHint')}
            />
          </div>
          <button type="submit" className="btn btn-primary w-full" disabled={busy || code.length !== 6 || password.length < 8}>
            {busy ? <Spinner /> : <ShieldCheck className="h-5 w-5" aria-hidden />} {t('auth.confirmReset')}
          </button>
          <div className="flex items-center justify-between text-sm">
            <button type="button" className="font-semibold text-brand underline" onClick={() => resetFormState('password')}>
              {t('auth.backToLogin')}
            </button>
            <button
              type="button"
              className="font-semibold text-brand underline disabled:text-muted disabled:no-underline"
              disabled={cooldown > 0 || busy}
              onClick={() => void requestOtp('reset_password')}
            >
              {cooldown > 0 ? t('auth.resendIn', { s: cooldown }) : t('auth.resend')}
            </button>
          </div>
        </form>
      )}

      {err && <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm font-semibold text-danger">{err}</p>}
    </div>
  );
}
