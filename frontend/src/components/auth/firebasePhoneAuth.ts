import { getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  type Auth,
  type ConfirmationResult,
} from 'firebase/auth';
import {
  isFirebasePhoneClientConfigured,
  resolveFirebaseClientConfig,
  setRuntimeFirebaseClientConfig,
  type FirebaseClientEnv,
} from './firebaseConfigClient';

export { isFirebasePhoneClientConfigured, setRuntimeFirebaseClientConfig, type FirebaseClientEnv };

const FIREBASE_APP_NAME = 'smartcitizen-dongnai-phone-auth';

export class FirebasePhoneAuthError extends Error {
  readonly code: string;
  readonly canFallbackToDirectSms: boolean;
  readonly suggestEmailFallback: boolean;

  constructor(
    message: string,
    code: string,
    opts?: { canFallbackToDirectSms?: boolean; suggestEmailFallback?: boolean },
  ) {
    super(message);
    this.name = 'FirebasePhoneAuthError';
    this.code = code;
    this.canFallbackToDirectSms = Boolean(opts?.canFallbackToDirectSms);
    this.suggestEmailFallback = Boolean(opts?.suggestEmailFallback);
  }
}

export function mapFirebasePhoneError(err: unknown): FirebasePhoneAuthError {
  if (err instanceof FirebasePhoneAuthError) return err;

  const rawCode = (err as { code?: string } | null)?.code ?? '';
  const rawMessage = err instanceof Error ? err.message : String(err ?? '');
  const code = rawCode || (rawMessage.match(/\((auth\/[^)]+)\)/)?.[1] ?? '');

  if (code === 'auth/invalid-phone-number') {
    return new FirebasePhoneAuthError(
      'Số điện thoại Việt Nam (+84) không hợp lệ trên Firebase.',
      code,
      { canFallbackToDirectSms: false, suggestEmailFallback: false },
    );
  }
  if (code === 'auth/operation-not-allowed' || /region enabled by the app developer|SMS unable to be sent/i.test(rawMessage)) {
    const isRegionPolicy = /region/i.test(rawMessage);
    return new FirebasePhoneAuthError(
      isRegionPolicy
        ? 'Firebase chưa mở gửi SMS cho khu vực Việt Nam (+84) (auth/operation-not-allowed). Quản trị viên cần bật Việt Nam (+84) trong Firebase Console → Authentication → Settings → SMS region policy (và kiểm tra gói Blaze), hoặc bạn hãy nhận mã OTP qua Email.'
        : 'Phương thức SMS qua Firebase chưa được bật trên dự án (auth/operation-not-allowed). Vui lòng bật Phone Sign-in trên Firebase Console hoặc chuyển sang nhận mã OTP qua Email.',
      code || 'auth/operation-not-allowed',
      { canFallbackToDirectSms: true, suggestEmailFallback: true },
    );
  }
  if (code === 'auth/billing-not-enabled') {
    return new FirebasePhoneAuthError(
      'Dự án Firebase cần kích hoạt gói thanh toán Blaze để gửi tin nhắn SMS thật. Vui lòng chuyển sang nhận mã OTP qua Email.',
      code,
      { canFallbackToDirectSms: true, suggestEmailFallback: true },
    );
  }
  if (code === 'auth/quota-exceeded') {
    return new FirebasePhoneAuthError(
      'Hạn mức gửi SMS OTP của hệ thống tạm thời đã hết. Vui lòng chuyển sang nhận mã OTP qua Email hoặc thử lại sau.',
      code,
      { canFallbackToDirectSms: true, suggestEmailFallback: true },
    );
  }
  if (code === 'auth/too-many-requests') {
    return new FirebasePhoneAuthError(
      'Số điện thoại này đã yêu cầu quá nhiều mã SMS. Vui lòng thử lại sau ít phút hoặc chuyển sang nhận mã OTP qua Email.',
      code,
      { canFallbackToDirectSms: false, suggestEmailFallback: true },
    );
  }
  if (code === 'auth/unauthorized-domain' || code === 'auth/app-not-authorized') {
    return new FirebasePhoneAuthError(
      'Tên miền hiện tại chưa được cấp phép trong Firebase Authorized Domains. Vui lòng chuyển sang nhận mã OTP qua Email.',
      code,
      { canFallbackToDirectSms: true, suggestEmailFallback: true },
    );
  }
  if (code === 'auth/captcha-check-failed' || code === 'auth/missing-client-identifier') {
    return new FirebasePhoneAuthError(
      'Xác minh bảo mật reCAPTCHA thất bại. Hãy kiểm tra Authorized Domains trên Firebase Console hoặc chuyển sang nhận mã OTP qua Email.',
      code,
      { canFallbackToDirectSms: true, suggestEmailFallback: true },
    );
  }
  if (code === 'auth/network-request-failed') {
    return new FirebasePhoneAuthError(
      'Không kết nối được tới dịch vụ gửi SMS của Google Firebase. Vui lòng kiểm tra mạng hoặc nhận mã OTP qua Email.',
      code,
      { canFallbackToDirectSms: true, suggestEmailFallback: true },
    );
  }
  if (code === 'auth/invalid-verification-code') {
    return new FirebasePhoneAuthError(
      'Mã OTP 6 số không chính xác. Vui lòng kiểm tra lại tin nhắn SMS.',
      code,
      { canFallbackToDirectSms: false, suggestEmailFallback: false },
    );
  }
  if (code === 'auth/code-expired') {
    return new FirebasePhoneAuthError(
      'Mã OTP SMS đã hết hạn. Vui lòng bấm Gửi lại mã.',
      code,
      { canFallbackToDirectSms: false, suggestEmailFallback: false },
    );
  }

  return new FirebasePhoneAuthError(
    rawMessage && !/^Firebase:\s*/i.test(rawMessage)
      ? rawMessage
      : 'Không gửi được tin nhắn SMS qua Firebase Phone Auth. Vui lòng thử lại hoặc chuyển sang nhận mã OTP qua Email.',
    code || 'auth/unknown',
    { canFallbackToDirectSms: true, suggestEmailFallback: true },
  );
}

function getFirebaseAuthInstance(): Auth {
  const cfg = resolveFirebaseClientConfig();
  if (!cfg) {
    throw new FirebasePhoneAuthError(
      'Dịch vụ xác thực SMS qua Firebase chưa sẵn sàng. Vui lòng chuyển sang nhận mã qua Email hoặc đăng nhập bằng mật khẩu.',
      'auth/config-missing',
      { canFallbackToDirectSms: true, suggestEmailFallback: true },
    );
  }
  const existing = getApps().find((a) => a.name === FIREBASE_APP_NAME);
  const app: FirebaseApp = existing ?? initializeApp(cfg, FIREBASE_APP_NAME);
  const auth = getAuth(app);
  auth.languageCode = 'vi';
  return auth;
}

let activeVerifier: RecaptchaVerifier | null = null;

export function clearFirebaseRecaptcha(): void {
  if (activeVerifier) {
    try {
      activeVerifier.clear();
    } catch {
      /* bỏ qua nếu DOM node đã unmount */
    }
    activeVerifier = null;
  }
}

/**
 * Gửi mã SMS OTP từ Google Firebase Phone Auth với `RecaptchaVerifier` ẩn (`size: 'invisible'`).
 */
export async function sendFirebasePhoneSms(
  phoneE164: string,
  recaptchaContainerId: string,
): Promise<ConfirmationResult> {
  const auth = getFirebaseAuthInstance();

  // Luôn tạo mới RecaptchaVerifier cho mỗi lượt gửi để tránh lỗi token reCAPTCHA cũ khi gửi lại mã
  clearFirebaseRecaptcha();
  const containerEl = document.getElementById(recaptchaContainerId);
  if (!containerEl) {
    throw new FirebasePhoneAuthError(
      'Không tìm thấy vùng chứa reCAPTCHA xác thực SĐT trên trang.',
      'auth/missing-recaptcha-container',
      { canFallbackToDirectSms: true, suggestEmailFallback: true },
    );
  }
  containerEl.innerHTML = '';
  activeVerifier = new RecaptchaVerifier(auth, containerEl, {
    size: 'invisible',
    callback: () => {
      /* tự động giải quyết invisible reCAPTCHA */
    },
    'expired-callback': () => {
      clearFirebaseRecaptcha();
    },
  });

  try {
    return await signInWithPhoneNumber(auth, phoneE164, activeVerifier);
  } catch (err) {
    clearFirebaseRecaptcha();
    throw mapFirebasePhoneError(err);
  }
}

/**
 * Xác nhận mã OTP 6 số với Firebase và lấy `firebaseIdToken` để đổi lấy JWT hệ thống.
 */
export async function confirmFirebaseOtpAndGetIdToken(
  confirmation: ConfirmationResult,
  otpCode: string,
): Promise<string> {
  try {
    const credential = await confirmation.confirm(otpCode.trim());
    return await credential.user.getIdToken(true);
  } catch (err) {
    throw mapFirebasePhoneError(err);
  }
}
