import crypto from 'node:crypto';
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { badRequest, HttpError, unauthorized } from '../../utils/errors';
import { parseVnPhone, type ParsedVnPhone } from './phoneNormalizer';

export interface VerifiedFirebasePhoneClaims {
  uid: string;
  phone: ParsedVnPhone;
}

export type FirebaseTokenVerifierFn = (
  idToken: string,
  envSource?: NodeJS.ProcessEnv,
) => Promise<{ uid: string; phone_number?: string }>;

const GOOGLE_SECURETOKEN_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let cachedCerts: { expiresAt: number; keys: Record<string, string> } | null = null;

function readEnv(envSource: NodeJS.ProcessEnv, key: string): string {
  return (envSource[key] ?? '').trim();
}

function resolveFirebaseProjectId(envSource: NodeJS.ProcessEnv): string {
  const direct =
    readEnv(envSource, 'FIREBASE_PROJECT_ID') || readEnv(envSource, 'VITE_FIREBASE_PROJECT_ID');
  if (direct) return direct;

  const rawJson = readEnv(envSource, 'FIREBASE_SERVICE_ACCOUNT_JSON');
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as { project_id?: string };
      if (parsed.project_id) return parsed.project_id.trim();
    } catch {
      /* xử lý lỗi ở bước khởi tạo SDK */
    }
  }
  return '';
}

function getOrInitFirebaseAdminApp(envSource: NodeJS.ProcessEnv): App | null {
  const rawJson = readEnv(envSource, 'FIREBASE_SERVICE_ACCOUNT_JSON');
  const clientEmail = readEnv(envSource, 'FIREBASE_CLIENT_EMAIL');
  const privateKeyRaw = readEnv(envSource, 'FIREBASE_PRIVATE_KEY');
  const projectId = resolveFirebaseProjectId(envSource);
  const appName = `sc-firebase-auth-${projectId || 'default'}`;

  const existing = getApps().find((a) => a.name === appName);
  if (existing) return existing;

  if (rawJson) {
    let parsed: { project_id?: string; client_email?: string; private_key?: string };
    try {
      parsed = JSON.parse(rawJson) as { project_id?: string; client_email?: string; private_key?: string };
    } catch {
      throw new HttpError(500, 'Biến FIREBASE_SERVICE_ACCOUNT_JSON không đúng định dạng JSON.', 'firebase_config_invalid');
    }
    return initializeApp(
      {
        credential: cert({
          projectId: parsed.project_id ?? projectId,
          clientEmail: parsed.client_email,
          privateKey: parsed.private_key?.replace(/\\n/g, '\n'),
        }),
        projectId: parsed.project_id ?? projectId,
      },
      appName,
    );
  }

  if (projectId && clientEmail && privateKeyRaw) {
    return initializeApp(
      {
        credential: cert({
          projectId,
          clientEmail,
          privateKey: privateKeyRaw.replace(/\\n/g, '\n'),
        }),
        projectId,
      },
      appName,
    );
  }

  return null;
}

async function fetchGoogleSecureTokenCerts(fetchImpl: typeof fetch): Promise<Record<string, string>> {
  const now = Date.now();
  if (cachedCerts && cachedCerts.expiresAt > now) {
    return cachedCerts.keys;
  }

  const res = await fetchImpl(GOOGLE_SECURETOKEN_CERTS_URL);
  if (!res.ok) {
    throw new HttpError(502, `Không tải được chứng chỉ X.509 từ Google SecureToken (${res.status}).`, 'firebase_certs_unavailable');
  }
  const cacheControl = res.headers.get('cache-control') ?? '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const ttlMs = maxAgeMatch ? Math.max(60_000, Number(maxAgeMatch[1]) * 1000) : 3600_000;
  const keys = (await res.json()) as Record<string, string>;
  cachedCerts = { expiresAt: now + ttlMs, keys };
  return keys;
}

function decodeBase64UrlJson<T>(segment: string): T {
  const json = Buffer.from(segment, 'base64url').toString('utf8');
  return JSON.parse(json) as T;
}

/**
 * Xác thực chữ ký RS256 chuẩn Firebase ID Token trực tiếp bằng chứng chỉ X.509 chính thức của Google
 * khi môi trường chỉ khai báo `FIREBASE_PROJECT_ID` (không cần tải file khóa riêng Service Account JSON).
 */
async function verifyFirebaseJwtWithGoogleCerts(
  idToken: string,
  projectId: string,
  fetchImpl: typeof fetch,
): Promise<{ uid: string; phone_number?: string }> {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw unauthorized('Firebase ID Token không đúng cấu trúc JWT.');
  }
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; kid?: string };
  let payload: {
    iss?: string;
    aud?: string;
    sub?: string;
    user_id?: string;
    phone_number?: string;
    exp?: number;
    iat?: number;
  };
  try {
    header = decodeBase64UrlJson(headerB64);
    payload = decodeBase64UrlJson(payloadB64);
  } catch {
    throw unauthorized('Không giải mã được nội dung Firebase ID Token.');
  }

  if (header.alg !== 'RS256' || !header.kid) {
    throw unauthorized('Thuật toán ký Firebase ID Token không hợp lệ.');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < nowSec - 30) {
    throw unauthorized('Firebase ID Token đã hết hạn, vui lòng xác thực lại SĐT.');
  }
  if (!payload.iat || payload.iat > nowSec + 300) {
    throw unauthorized('Thời điểm phát hành Firebase ID Token không hợp lệ.');
  }
  if (payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw unauthorized('Firebase ID Token không thuộc dự án SmartCitizen đã cấu hình.');
  }
  const uid = payload.sub || payload.user_id;
  if (!uid) {
    throw unauthorized('Firebase ID Token thiếu định danh người dùng (sub).');
  }

  const certs = await fetchGoogleSecureTokenCerts(fetchImpl);
  const pem = certs[header.kid];
  if (!pem) {
    throw unauthorized('Không tìm thấy khóa công khai Google khớp với kid của Firebase ID Token.');
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  const signatureValid = verifier.verify(pem, Buffer.from(sigB64, 'base64url'));
  if (!signatureValid) {
    throw unauthorized('Chữ ký số của Firebase ID Token không hợp lệ.');
  }

  return { uid, phone_number: payload.phone_number };
}

/**
 * Dịch vụ xác thực Firebase Phone Auth (`POST /api/auth/otp/verify-firebase`):
 * - Ưu tiên dùng `firebase-admin` (`getAuth().verifyIdToken`) khi có Service Account.
 * - Tự động hỗ trợ xác thực chữ ký RS256 qua chứng chỉ X.509 Google khi chỉ cấu hình `FIREBASE_PROJECT_ID`.
 */
export class FirebasePhoneVerifier {
  private customVerifier: FirebaseTokenVerifierFn | null = null;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /** Cho phép gắn mock verifier trong kiểm thử đơn vị (`NODE_ENV=test`). */
  setCustomVerifier(fn: FirebaseTokenVerifierFn | null): void {
    this.customVerifier = fn;
  }

  async verifyPhoneIdToken(
    idTokenRaw: string,
    envSource: NodeJS.ProcessEnv = process.env,
  ): Promise<VerifiedFirebasePhoneClaims> {
    const idToken = idTokenRaw.trim();
    if (idToken.length < 20) {
      throw badRequest('Thiếu hoặc sai định dạng firebaseIdToken.', 'invalid_firebase_token');
    }

    let decoded: { uid: string; phone_number?: string };
    if (this.customVerifier) {
      decoded = await this.customVerifier(idToken, envSource);
    } else {
      const adminApp = getOrInitFirebaseAdminApp(envSource);
      if (adminApp) {
        try {
          const verified = await getAuth(adminApp).verifyIdToken(idToken, true);
          decoded = { uid: verified.uid, phone_number: verified.phone_number };
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Token không hợp lệ';
          throw unauthorized(`Xác thực Firebase ID Token thất bại: ${msg}`);
        }
      } else {
        const projectId = resolveFirebaseProjectId(envSource);
        if (!projectId) {
          throw new HttpError(
            503,
            'Máy chủ chưa cấu hình FIREBASE_PROJECT_ID (hoặc FIREBASE_SERVICE_ACCOUNT_JSON) để xác thực Firebase Phone Auth.',
            'firebase_not_configured',
          );
        }
        decoded = await verifyFirebaseJwtWithGoogleCerts(idToken, projectId, this.fetchImpl);
      }
    }

    if (!decoded.phone_number) {
      throw badRequest('Firebase ID Token không chứa số điện thoại đã xác thực (`phone_number`).', 'missing_phone_claim');
    }

    const phone = parseVnPhone(decoded.phone_number);
    if (!phone) {
      throw badRequest(
        `Số điện thoại từ Firebase (${decoded.phone_number}) không phải số di động Việt Nam (+84) hợp lệ.`,
        'invalid_phone',
      );
    }

    return {
      uid: decoded.uid,
      phone,
    };
  }
}
