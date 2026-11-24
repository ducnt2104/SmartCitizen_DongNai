import { KeyRound, Phone, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AuthSession } from '@shared/types';
import { useI18n } from '../i18n';
import { api, ApiError, NetworkError } from '../lib/api';
import { authStore } from '../lib/authStore';
import { useToast } from '../state/toast';
import { Spinner } from './ui';

interface OtpResponse {
  resendInSec: number;
  expiresInSec: number;
  demoOtp?: string;
  phoneMasked: string;
}

function GoogleG() {
  return (
    <svg viewBox="0 0 48 48" className="h-5 w-5" aria-hidden>
      <path fill="#EA4335" d="M24 9.500c3.500 0 6.600 1.200 9.100 3.500l6.800-6.800C35.800 2.400 30.300 0 24 0 14.600 0 6.500 5.400 2.600 13.200l7.900 6.100C12.400 13.600 17.700 9.500 24 9.500z" />
      <path fill="#4285F4" d="M46.500 24.500c0-1.600-.1-3.100-.4-4.500H24v9h12.700c-.6 3-2.300 5.500-4.800 7.200l7.500 5.800c4.400-4.100 7.100-10.100 7.100-17.500z" />
      <path fill="#FBBC05" d="M10.500 28.700A14.500 14.500 0 0 1 9.500 24c0-1.600.3-3.200.8-4.700l-7.900-6.100A24 24 0 0 0 0 24c0 3.900.9 7.500 2.600 10.800l7.900-6.100z" />
      <path fill="#34A853" d="M24 48c6.500 0 11.900-2.100 15.900-5.800l-7.500-5.800c-2.100 1.400-4.900 2.300-8.400 2.300-6.300 0-11.600-4.100-13.500-9.800l-7.900 6.100C6.500 42.600 14.600 48 24 48z" />
    </svg>
  );
}

/** Đăng nhập người dân: SĐT + OTP 6 số (hash SHA-256 phía server) hoặc Google (Mock Demo). */
export function CitizenLogin({ onDone, compact = false }: { onDone: (s: AuthSession) => void; compact?: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'phone' | 'code'>('phone');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

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

  const request = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<OtpResponse>('/api/auth/otp/request', { body: { phone } });
      setStage('code');
      setCooldown(r.resendInSec);
      if (r.demoOtp) toast('demo', `[DEMO OTP] ${r.demoOtp}`, t('auth.demoOtpHint', { phone: r.phoneMasked }));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const s = await api<AuthSession>('/api/auth/otp/verify', { body: { phone, code } });
      authStore.set(s);
      onDone(s);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const google = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const s = await api<AuthSession>('/api/auth/google-mock', { body: { name: 'Công dân Demo', email: 'congdan.demo@gmail.com' } });
      authStore.set(s);
      onDone(s);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {!compact && <p className="text-sm text-muted">{t('auth.citizenIntro')}</p>}
      <button type="button" className="btn btn-ghost w-full" onClick={() => void google()} disabled={busy}>
        <GoogleG /> {t('auth.google')}
      </button>
      <p className="text-center text-xs text-muted">{t('auth.googleMockNote')}</p>
      <div className="flex items-center gap-3 text-xs text-muted"><span className="h-px flex-1 bg-line" />{t('auth.or')}<span className="h-px flex-1 bg-line" /></div>

      {stage === 'phone' ? (
        <form onSubmit={(e) => { e.preventDefault(); void request(); }} className="space-y-3">
          <div>
            <label htmlFor="ph" className="label"><Phone className="mr-1 inline h-4 w-4" aria-hidden />{t('auth.phone')}</label>
            <input id="ph" className="field mono" inputMode="tel" autoComplete="tel" placeholder="09xx xxx xxx" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={16} />
          </div>
          <button type="submit" className="btn btn-primary w-full" disabled={busy || phone.replace(/\D/g, '').length < 9}>
            {busy ? <Spinner /> : <KeyRound className="h-5 w-5" aria-hidden />} {t('auth.sendOtp')}
          </button>
        </form>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void verify(); }} className="space-y-3">
          <div>
            <label htmlFor="otp" className="label"><ShieldCheck className="mr-1 inline h-4 w-4" aria-hidden />{t('auth.otpLabel')}</label>
            <input id="otp" className="field mono text-center text-2xl tracking-[0.5em]" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
          </div>
          <button type="submit" className="btn btn-primary w-full" disabled={busy || code.length !== 6}>
            {busy ? <Spinner /> : <ShieldCheck className="h-5 w-5" aria-hidden />} {t('auth.verify')}
          </button>
          <div className="flex items-center justify-between text-sm">
            <button type="button" className="font-semibold text-brand underline" onClick={() => { setStage('phone'); setCode(''); setErr(null); }}>{t('auth.changePhone')}</button>
            <button type="button" className="font-semibold text-brand underline disabled:text-muted disabled:no-underline" disabled={cooldown > 0 || busy} onClick={() => void request()}>
              {cooldown > 0 ? t('auth.resendIn', { s: cooldown }) : t('auth.resend')}
            </button>
          </div>
        </form>
      )}
      {err && <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm font-semibold text-danger">{err}</p>}
    </div>
  );
}
