import { getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  type Auth,
  type ConfirmationResult,
} from 'firebase/auth';

const FIREBASE_APP_NAME = 'smartcitizen-dongnai-phone-auth';

interface FirebaseClientEnv {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId?: string;
}

function readFirebaseEnv(): FirebaseClientEnv | null {
  const apiKey = (import.meta.env.VITE_FIREBASE_API_KEY as string | undefined)?.trim() ?? '';
  const projectId = (import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined)?.trim() ?? '';
  const authDomain =
    (import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined)?.trim() ||
    (projectId ? `${projectId}.firebaseapp.com` : '');
  const appId = (import.meta.env.VITE_FIREBASE_APP_ID as string | undefined)?.trim() || undefined;

  if (!apiKey || !projectId) return null;
  return { apiKey, authDomain, projectId, appId };
}

export function isFirebasePhoneClientConfigured(): boolean {
  return readFirebaseEnv() !== null;
}

function getFirebaseAuthInstance(): Auth {
  const cfg = readFirebaseEnv();
  if (!cfg) {
    throw new Error(
      'Chưa cấu hình VITE_FIREBASE_API_KEY và VITE_FIREBASE_PROJECT_ID trên Frontend cho chế độ Firebase Phone Auth.',
    );
  }
  const existing = getApps().find((a) => a.name === FIREBASE_APP_NAME);
  const app: FirebaseApp = existing ?? initializeApp(cfg, FIREBASE_APP_NAME);
  const auth = getAuth(app);
  auth.languageCode = 'vi';
  return auth;
}

let activeVerifier: RecaptchaVerifier | null = null;
let activeContainerId: string | null = null;

export function clearFirebaseRecaptcha(): void {
  if (activeVerifier) {
    try {
      activeVerifier.clear();
    } catch {
      /* bỏ qua nếu DOM node đã unmount */
    }
    activeVerifier = null;
    activeContainerId = null;
  }
}

/**
 * Gửi SMS OTP thật từ Google Firebase Phone Auth với `RecaptchaVerifier` ẩn (`size: 'invisible'`).
 */
export async function sendFirebasePhoneSms(
  phoneE164: string,
  recaptchaContainerId: string,
): Promise<ConfirmationResult> {
  const auth = getFirebaseAuthInstance();

  if (!activeVerifier || activeContainerId !== recaptchaContainerId) {
    clearFirebaseRecaptcha();
    const containerEl = document.getElementById(recaptchaContainerId);
    if (!containerEl) {
      throw new Error('Không tìm thấy vùng chứa reCAPTCHA xác thực SĐT trên trang.');
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
    activeContainerId = recaptchaContainerId;
  }

  try {
    return await signInWithPhoneNumber(auth, phoneE164, activeVerifier);
  } catch (err) {
    clearFirebaseRecaptcha();
    const code = (err as { code?: string } | null)?.code ?? '';
    if (code === 'auth/invalid-phone-number') {
      throw new Error('Số điện thoại Việt Nam (+84) không hợp lệ trên Firebase.');
    }
    if (code === 'auth/too-many-requests') {
      throw new Error('Số điện thoại này đã yêu cầu quá nhiều mã SMS. Vui lòng thử lại sau ít phút.');
    }
    if (code === 'auth/captcha-check-failed') {
      throw new Error('Xác minh bảo mật reCAPTCHA thất bại. Hãy kiểm tra Authorized Domains trên Firebase Console.');
    }
    throw err instanceof Error ? err : new Error('Không gửi được tin nhắn SMS qua Firebase Phone Auth.');
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
    const code = (err as { code?: string } | null)?.code ?? '';
    if (code === 'auth/invalid-verification-code') {
      throw new Error('Mã OTP 6 số không chính xác. Vui lòng kiểm tra lại tin nhắn SMS.');
    }
    if (code === 'auth/code-expired') {
      throw new Error('Mã OTP SMS đã hết hạn. Vui lòng bấm Gửi lại mã.');
    }
    throw err instanceof Error ? err : new Error('Xác thực mã OTP Firebase thất bại.');
  }
}
