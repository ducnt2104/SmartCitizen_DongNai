import {
  AlertTriangle,
  Clock,
  KeyRound,
  Lock,
  Mail,
  Phone,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { ConfirmationResult } from 'firebase/auth';
import type { AuthSession } from '@shared/types';
import { DONG_NAI_WARDS } from '../../data/dongNaiWards';
import { useI18n } from '../../i18n';
import { api, ApiError, NetworkError } from '../../lib/api';
import { authStore } from '../../lib/authStore';
import { useToast } from '../../state/toast';
import { Spinner } from '../ui';
import {
  clearFirebaseRecaptcha,
  confirmFirebaseOtpAndGetIdToken,
  isFirebasePhoneClientConfigured,
  sendFirebasePhoneSms,
  setRuntimeFirebaseClientConfig,
  type FirebaseClientEnv,
} from './firebasePhoneAuth';
import { OtpSixDigitInput } from './OtpSixDigitInput';
import { validateVnPhoneLive, VnPhoneInput } from './VnPhoneInput';

interface OtpSendResponse {
  channel: 'email' | 'phone' | 'sms';
  target?: string;
  targetMasked: string;
  resendInSec: number;
  expiresInSec: number;
  provider: string;
  clientSideFirebase?: boolean;
}

interface OtpStatusResponse {
  emailConfigured: boolean;
  smsConfigured: boolean;
  activeEmailProvider: string | null;
  activeSmsProvider: string | null;
  configuredProviderMode: string;
  smsProviderMode?: string;
  smsPhoneAuthReady?: boolean;
  firebaseClientReady?: boolean;
  firebaseClientConfig?: FirebaseClientEnv | null;
  emailFallbackAvailable?: boolean;
}

type AuthMode = 'otp' | 'password' | 'reset';
type OtpChannelTab = 'phone' | 'email';

const WARDS_PHUONG = DONG_NAI_WARDS.filter((w) => w.kind === 'Phường');
const WARDS_XA = DONG_NAI_WARDS.filter((w) => w.kind === 'Xã');

function isEmailValid(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw.trim());
}

/**
 * Form Xác thực Công dân Đa kênh (Số điện thoại +84 | Email + Mật khẩu):
 * - Chuyển nhanh giữa tab Số điện thoại (+84, validate tức thì) và Email.
 * - Hỗ trợ song song Firebase Phone Auth (`RecaptchaVerifier` ẩn + `signInWithPhoneNumber`)
 *   và cổng SMS trực tiếp từ máy chủ (`android_gateway`, `esms`, `speedsms`, `twilio`).
 * - Ô nhập 6 số OTP chuẩn Mobile (`inputMode="numeric"`, `autoComplete="one-time-code"`, paste 6 số)
 *   cùng đồng hồ đếm ngược 60 giây trước khi hiện nút "Gửi lại mã".
 */
export function CitizenAuthForm({
  onDone,
  compact = false,
}: {
  onDone: (s: AuthSession) => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const rawDomId = useId().replace(/:/g, '');
  const recaptchaContainerId = `sc-firebase-recaptcha-${rawDomId}`;

  const [mode, setMode] = useState<AuthMode>('otp');
  const [channelTab, setChannelTab] = useState<OtpChannelTab>('phone');
  const [phoneInput, setPhoneInput] = useState('');
  const [emailInput, setEmailInput] = useState('');
  const [pwIdentifier, setPwIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [defaultWardCode, setDefaultWardCode] = useState('');
  const [stage, setStage] = useState<'input' | 'code'>('input');
  const [targetMasked, setTargetMasked] = useState('');
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [otpStatus, setOtpStatus] = useState<OtpStatusResponse | null>(null);
  const [honeypot, setHoneypot] = useState('');
  const formLoadedAtRef = useRef(Date.now());

  const firebaseConfirmationRef = useRef<ConfirmationResult | null>(null);

  useEffect(() => {
    let active = true;
    void api<OtpStatusResponse>('/api/auth/otp/status')
      .then((res) => {
        if (!active) return;
        setRuntimeFirebaseClientConfig(res.firebaseClientConfig);
        setOtpStatus(res);
      })
      .catch(() => {
        /* giữ mặc định khi ngoại tuyến */
      });
    return () => {
      active = false;
      clearFirebaseRecaptcha();
    };
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const fail = (e: unknown): void => {
    if (e instanceof NetworkError) setErr(t('auth.offlineErr'));
    else if (e instanceof ApiError) setErr(e.message);
    else if (e instanceof Error && e.message) setErr(e.message);
    else setErr(t('state.genericError'));
  };

  const resetFormState = (nextMode: AuthMode): void => {
    setMode(nextMode);
    setStage('input');
    setCode('');
    firebaseConfirmationRef.current = null;
    setErr(null);
  };

  const switchChannelTab = (nextTab: OtpChannelTab): void => {
    setChannelTab(nextTab);
    setStage('input');
    setCode('');
    firebaseConfirmationRef.current = null;
    setErr(null);
  };

  const phoneCheck = validateVnPhoneLive(phoneInput);
  const emailValid = isEmailValid(emailInput);
  const canSendOtp = channelTab === 'phone' ? phoneCheck.isValid : emailValid;

  const shouldUseFirebaseClientFlow =
    channelTab === 'phone' &&
    mode === 'otp' &&
    isFirebasePhoneClientConfigured() &&
    (otpStatus?.activeSmsProvider === 'firebase' || otpStatus?.smsProviderMode === 'firebase');

  const sendOtp = async (purpose: 'login' | 'reset_password'): Promise<void> => {
    setBusy(true);
    setErr(null);
    firebaseConfirmationRef.current = null;

    try {
      if (channelTab === 'phone') {
        if (!phoneCheck.isValid || !phoneCheck.e164) {
          setErr(phoneCheck.errorMessage ?? 'Số điện thoại Việt Nam không hợp lệ.');
          return;
        }

        // Kênh 1: Firebase Phone Auth gửi mã SMS từ Google (khi đăng nhập bằng SĐT)
        if (shouldUseFirebaseClientFlow && purpose === 'login') {
          const serverAck = await api<OtpSendResponse>('/api/auth/otp/send', {
            body: {
              channel: 'phone',
              phone: phoneCheck.e164,
              purpose,
              formLoadedAt: formLoadedAtRef.current,
              ...(honeypot ? { website: honeypot } : {}),
            },
          });
          const confirmation = await sendFirebasePhoneSms(phoneCheck.e164, recaptchaContainerId);
          firebaseConfirmationRef.current = confirmation;
          setActiveProvider('firebase');
          setTargetMasked(serverAck.targetMasked || phoneCheck.formattedDisplay || phoneCheck.e164);
          setCooldown(serverAck.resendInSec || 60);
          setStage('code');
          toast('info', `Đã gửi mã SMS OTP tới ${phoneCheck.formattedDisplay ?? phoneCheck.e164}`);
          return;
        }

        // Kênh 2 & 3: SpeedSMS / eSMS / Twilio / Vonage hoặc Webhook SMS Gateway (TextBee)
        const r = await api<OtpSendResponse>('/api/auth/otp/send', {
          body: {
            channel: 'phone',
            phone: phoneCheck.e164,
            purpose,
            formLoadedAt: formLoadedAtRef.current,
            ...(honeypot ? { website: honeypot } : {}),
          },
        });

        if (r.clientSideFirebase && purpose === 'login') {
          if (!isFirebasePhoneClientConfigured()) {
            throw new Error(
              'Dịch vụ xác thực SMS qua Firebase chưa hoàn tất cấu hình trình duyệt. Vui lòng chuyển sang nhận mã qua Email hoặc thử lại sau.',
            );
          }
          const confirmation = await sendFirebasePhoneSms(phoneCheck.e164, recaptchaContainerId);
          firebaseConfirmationRef.current = confirmation;
        }

        setActiveProvider(r.provider);
        setTargetMasked(r.targetMasked);
        setCooldown(r.resendInSec || 60);
        setStage('code');
        toast('info', t('auth.otpSentToast', { target: r.targetMasked }));
        return;
      }

      // Kênh Email
      const cleanEmail = emailInput.trim().toLowerCase();
      const r = await api<OtpSendResponse>('/api/auth/otp/send', {
        body: {
          channel: 'email',
          email: cleanEmail,
          identifier: cleanEmail,
          purpose,
          formLoadedAt: formLoadedAtRef.current,
          ...(honeypot ? { website: honeypot } : {}),
        },
      });
      setActiveProvider(r.provider);
      setTargetMasked(r.targetMasked);
      setCooldown(r.resendInSec || 60);
      setStage('code');
      toast('info', t('auth.otpSentToast', { target: r.targetMasked }));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const verifyOtpLogin = async (overrideCode?: string): Promise<void> => {
    const otpCode = (overrideCode ?? code).replace(/\D/g, '').trim();
    if (otpCode.length !== 6 || busy) return;
    setBusy(true);
    setErr(null);

    try {
      const profileExtras: Record<string, unknown> = {};
      if (name.trim().length >= 2) profileExtras.name = name.trim();
      if (password.length >= 8) profileExtras.password = password;
      if (defaultWardCode) profileExtras.defaultWardCode = defaultWardCode;

      if (channelTab === 'phone' && firebaseConfirmationRef.current) {
        const firebaseIdToken = await confirmFirebaseOtpAndGetIdToken(
          firebaseConfirmationRef.current,
          otpCode,
        );
        const s = await api<AuthSession>('/api/auth/otp/verify-firebase', {
          body: { firebaseIdToken, ...profileExtras },
        });
        authStore.set(s);
        onDone(s);
        return;
      }

      const bodyPayload: Record<string, unknown> =
        channelTab === 'phone'
          ? {
              channel: 'phone',
              phone: phoneCheck.e164 ?? phoneInput.trim(),
              identifier: phoneCheck.e164 ?? phoneInput.trim(),
              code: otpCode,
              formLoadedAt: formLoadedAtRef.current,
              ...(honeypot ? { website: honeypot } : {}),
              ...profileExtras,
            }
          : {
              channel: 'email',
              email: emailInput.trim().toLowerCase(),
              identifier: emailInput.trim().toLowerCase(),
              code: otpCode,
              formLoadedAt: formLoadedAtRef.current,
              ...(honeypot ? { website: honeypot } : {}),
              ...profileExtras,
            };

      const s = await api<AuthSession>('/api/auth/otp/verify', { body: bodyPayload });
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
        body: { identifier: pwIdentifier.trim(), password },
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
      const resetTarget =
        channelTab === 'phone'
          ? (phoneCheck.e164 ?? phoneInput.trim())
          : emailInput.trim().toLowerCase();
      const s = await api<AuthSession>('/api/auth/password/reset', {
        body: { identifier: resetTarget, code, newPassword: password },
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

  const emailUnconfigured =
    channelTab === 'email' && otpStatus !== null && !otpStatus.emailConfigured;

  const renderChannelSwitcher = (): JSX.Element => (
    <div
      role="tablist"
      aria-label="Chọn phương thức nhận mã OTP"
      className="grid grid-cols-2 gap-1.5 rounded-2xl border border-line/75 bg-surface-2/85 p-1"
    >
      <button
        type="button"
        role="tab"
        aria-selected={channelTab === 'phone'}
        onClick={() => switchChannelTab('phone')}
        className={`flex min-h-10 items-center justify-center gap-1.5 rounded-xl px-3 text-sm font-bold transition-all ${
          channelTab === 'phone'
            ? 'btn-primary shadow-sm'
            : 'text-muted hover:text-ink'
        }`}
      >
        <Smartphone className="h-4 w-4 shrink-0" aria-hidden />
        <span>Số điện thoại</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={channelTab === 'email'}
        onClick={() => switchChannelTab('email')}
        className={`flex min-h-10 items-center justify-center gap-1.5 rounded-xl px-3 text-sm font-bold transition-all ${
          channelTab === 'email'
            ? 'btn-primary shadow-sm'
            : 'text-muted hover:text-ink'
        }`}
      >
        <Mail className="h-4 w-4 shrink-0" aria-hidden />
        <span>Email</span>
      </button>
    </div>
  );

  const renderResendControl = (purpose: 'login' | 'reset_password'): JSX.Element => {
    if (cooldown > 0) {
      return (
        <span
          className="inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1 font-mono text-xs font-semibold text-muted"
          aria-live="polite"
        >
          <Clock className="h-3.5 w-3.5 text-brand" aria-hidden />
          <span>Gửi lại sau {cooldown}s</span>
        </span>
      );
    }
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => void sendOtp(purpose)}
        className="inline-flex items-center gap-1 font-semibold text-brand underline hover:opacity-85 disabled:opacity-50"
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden />
        <span>Gửi lại mã</span>
      </button>
    );
  };

  return (
    <div className="space-y-4">
      {/* Honeypot bẫy bot tự động */}
      <div
        aria-hidden="true"
        style={{ position: 'absolute', left: '-9999px', width: '1px', height: '1px', overflow: 'hidden' }}
      >
        <label htmlFor="auth-website-trap">Website</label>
        <input
          id="auth-website-trap"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
        />
      </div>
      {/* Vùng chứa ẩn cho Firebase Invisible RecaptchaVerifier */}
      <div id={recaptchaContainerId} className="sr-only" aria-hidden="true" />

      {!compact && <p className="text-sm text-muted">{t('auth.citizenIntro')}</p>}

      {/* Chuyển đổi Mã OTP / Mật khẩu */}
      <div className="grid grid-cols-2 gap-1 rounded-2xl border border-line/70 bg-surface-2/85 p-1" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'otp' || mode === 'reset'}
          onClick={() => resetFormState('otp')}
          className={`min-h-10 rounded-xl px-2 text-sm font-bold transition-all ${
            mode === 'otp' || mode === 'reset' ? 'bg-surface text-brand shadow-card' : 'text-muted hover:text-ink'
          }`}
        >
          <KeyRound className="mr-1 inline h-4 w-4" aria-hidden /> {t('auth.modeOtp')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'password'}
          onClick={() => resetFormState('password')}
          className={`min-h-10 rounded-xl px-2 text-sm font-bold transition-all ${
            mode === 'password' ? 'bg-surface text-brand shadow-card' : 'text-muted hover:text-ink'
          }`}
        >
          <Lock className="mr-1 inline h-4 w-4" aria-hidden /> {t('auth.modePassword')}
        </button>
      </div>

      {mode === 'password' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void loginWithPassword();
          }}
          className="space-y-3"
        >
          <div>
            <label htmlFor="id-pw" className="label">
              <Phone className="mr-1 inline h-4 w-4" aria-hidden />
              {t('auth.identifier')}
            </label>
            <input
              id="id-pw"
              className="field"
              autoComplete="username"
              placeholder={t('auth.identifierPlaceholder')}
              value={pwIdentifier}
              onChange={(e) => setPwIdentifier(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="pw-cit" className="label">
              <Lock className="mr-1 inline h-4 w-4" aria-hidden />
              {t('auth.password')}
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
          <button
            type="submit"
            className="btn btn-primary w-full"
            disabled={busy || pwIdentifier.trim().length < 5 || !password}
          >
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
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendOtp('login');
          }}
          className="space-y-3.5"
        >
          {renderChannelSwitcher()}

          {emailUnconfigured && (
            <div role="status" className="rounded-xl border border-warn/40 bg-warn-soft p-3 text-xs text-warn">
              <p className="flex items-center gap-1.5 font-bold">
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                {t('auth.otpUnconfiguredTitle')}
              </p>
              <p className="mt-1 leading-relaxed">{t('auth.otpUnconfiguredHint')}</p>
            </div>
          )}

          {channelTab === 'phone' ? (
            <div>
              <label htmlFor="vn-phone-otp" className="label">
                <Smartphone className="mr-1 inline h-4 w-4" aria-hidden />
                Số điện thoại di động Việt Nam
              </label>
              <VnPhoneInput
                id="vn-phone-otp"
                value={phoneInput}
                onChange={setPhoneInput}
                disabled={busy}
              />
            </div>
          ) : (
            <div>
              <label htmlFor="email-otp" className="label">
                <Mail className="mr-1 inline h-4 w-4" aria-hidden />
                Địa chỉ Email nhận mã OTP
              </label>
              <input
                id="email-otp"
                type="email"
                inputMode="email"
                autoComplete="email"
                className="field"
                placeholder="congdan@dongnai.vn"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                disabled={busy}
                maxLength={120}
              />
            </div>
          )}

          <button type="submit" className="btn btn-primary w-full" disabled={busy || !canSendOtp}>
            {busy ? <Spinner /> : <KeyRound className="h-5 w-5" aria-hidden />}{' '}
            {channelTab === 'phone' ? 'Nhận mã OTP qua SMS' : t('auth.sendOtp')}
          </button>
        </form>
      )}

      {mode === 'otp' && stage === 'code' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void verifyOtpLogin();
          }}
          className="space-y-3.5"
        >
          <div className="rounded-xl bg-ok-soft px-3 py-2.5 text-xs font-semibold text-ok">
            Đã gửi mã OTP 6 số tới <span className="font-mono font-bold">{targetMasked}</span> (hiệu lực 5 phút).
            {activeProvider === 'firebase' && ' Xác thực bảo mật bởi Google Firebase.'}
          </div>

          <div className="space-y-2">
            <label className="label">
              <ShieldCheck className="mr-1 inline h-4 w-4" aria-hidden />
              {t('auth.otpLabel')}
            </label>
            <OtpSixDigitInput
              value={code}
              onChange={setCode}
              onComplete={(completed) => void verifyOtpLogin(completed)}
              disabled={busy}
              autoFocus
            />
          </div>

          {!compact && (
            <details className="rounded-xl border border-line bg-surface-2 p-3 text-sm">
              <summary className="cursor-pointer font-semibold text-muted">{t('auth.optionalSetup')}</summary>
              <div className="mt-3 space-y-2.5">
                <div>
                  <label htmlFor="opt-name" className="label text-xs">
                    {t('profile.name')}
                  </label>
                  <input
                    id="opt-name"
                    className="field !min-h-10 text-sm"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('profile.namePlaceholder')}
                    maxLength={80}
                  />
                </div>
                <div>
                  <label htmlFor="opt-ward" className="label text-xs">
                    {t('profile.defaultWard')}
                  </label>
                  <select
                    id="opt-ward"
                    className="field !min-h-10 text-sm"
                    value={defaultWardCode}
                    onChange={(e) => setDefaultWardCode(e.target.value)}
                  >
                    <option value="">{t('profile.noDefaultWard')}</option>
                    <optgroup label={t('scope.groupPhuong')}>
                      {WARDS_PHUONG.map((w) => (
                        <option key={w.wardCode} value={w.wardCode}>
                          {w.name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label={t('scope.groupXa')}>
                      {WARDS_XA.map((w) => (
                        <option key={w.wardCode} value={w.wardCode}>
                          {w.name}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </div>
                <div>
                  <label htmlFor="opt-pw" className="label text-xs">
                    {t('auth.optionalPassword')}
                  </label>
                  <input
                    id="opt-pw"
                    type="password"
                    className="field !min-h-10 text-sm"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    minLength={8}
                  />
                </div>
              </div>
            </details>
          )}

          <button type="submit" className="btn btn-primary w-full" disabled={busy || code.length !== 6}>
            {busy ? <Spinner /> : <ShieldCheck className="h-5 w-5" aria-hidden />} {t('auth.verify')}
          </button>

          <div className="flex items-center justify-between text-sm">
            <button
              type="button"
              className="font-semibold text-brand underline"
              onClick={() => {
                setStage('input');
                setCode('');
                setErr(null);
              }}
            >
              {channelTab === 'phone' ? 'Đổi số điện thoại' : 'Đổi địa chỉ Email'}
            </button>
            {renderResendControl('login')}
          </div>
        </form>
      )}

      {mode === 'reset' && stage === 'input' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendOtp('reset_password');
          }}
          className="space-y-3.5"
        >
          <p className="text-sm font-semibold">{t('auth.resetTitle')}</p>
          {renderChannelSwitcher()}

          {channelTab === 'phone' ? (
            <div>
              <label htmlFor="id-reset-phone" className="label">
                <RotateCcw className="mr-1 inline h-4 w-4" aria-hidden />
                Số điện thoại khôi phục mật khẩu
              </label>
              <VnPhoneInput
                id="id-reset-phone"
                value={phoneInput}
                onChange={setPhoneInput}
                disabled={busy}
              />
            </div>
          ) : (
            <div>
              <label htmlFor="id-reset-email" className="label">
                <RotateCcw className="mr-1 inline h-4 w-4" aria-hidden />
                Địa chỉ Email khôi phục mật khẩu
              </label>
              <input
                id="id-reset-email"
                type="email"
                className="field"
                placeholder="congdan@dongnai.vn"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                disabled={busy}
              />
            </div>
          )}

          <button type="submit" className="btn btn-primary w-full" disabled={busy || !canSendOtp}>
            {busy ? <Spinner /> : <KeyRound className="h-5 w-5" aria-hidden />} {t('auth.sendResetOtp')}
          </button>
        </form>
      )}

      {mode === 'reset' && stage === 'code' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitPasswordReset();
          }}
          className="space-y-3.5"
        >
          <div className="rounded-xl bg-ok-soft px-3 py-2.5 text-xs font-semibold text-ok">
            {t('auth.otpSentDetail', { target: targetMasked })}
          </div>
          <div className="space-y-2">
            <label className="label">{t('auth.otpLabel')}</label>
            <OtpSixDigitInput
              value={code}
              onChange={setCode}
              onComplete={() => {
                if (password.length >= 8) {
                  void submitPasswordReset();
                } else {
                  document.getElementById('rst-pw')?.focus();
                }
              }}
              disabled={busy}
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="rst-pw" className="label">
              {t('auth.newPassword')}
            </label>
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
          <button
            type="submit"
            className="btn btn-primary w-full"
            disabled={busy || code.length !== 6 || password.length < 8}
          >
            {busy ? <Spinner /> : <ShieldCheck className="h-5 w-5" aria-hidden />} {t('auth.confirmReset')}
          </button>
          <div className="flex items-center justify-between text-sm">
            <button
              type="button"
              className="font-semibold text-brand underline"
              onClick={() => resetFormState('password')}
            >
              {t('auth.backToLogin')}
            </button>
            {renderResendControl('reset_password')}
          </div>
        </form>
      )}

      {err && (
        <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm font-semibold text-danger">
          {err}
        </p>
      )}
    </div>
  );
}
