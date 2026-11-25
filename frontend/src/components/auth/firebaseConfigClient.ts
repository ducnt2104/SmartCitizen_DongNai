export interface FirebaseClientEnv {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId?: string;
}

const FIREBASE_RUNTIME_STORAGE_KEY = 'sc_dn_firebase_client_cfg_v1';

function readEnvString(key: string): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  const vite = env[`VITE_${key}`];
  const next = env[`NEXT_PUBLIC_${key}`];
  return String(vite || next || '').trim();
}

function readStoredRuntimeConfig(): FirebaseClientEnv | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = window.localStorage.getItem(FIREBASE_RUNTIME_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FirebaseClientEnv>;
    if (!parsed?.apiKey || !parsed?.projectId) return null;
    return {
      apiKey: parsed.apiKey,
      projectId: parsed.projectId,
      authDomain: parsed.authDomain || `${parsed.projectId}.firebaseapp.com`,
      appId: parsed.appId,
    };
  } catch {
    return null;
  }
}

let runtimeFirebaseConfig: FirebaseClientEnv | null = null;

export function setRuntimeFirebaseClientConfig(cfg: FirebaseClientEnv | null | undefined): void {
  if (!cfg?.apiKey || !cfg?.projectId) return;
  runtimeFirebaseConfig = {
    apiKey: cfg.apiKey.trim(),
    projectId: cfg.projectId.trim(),
    authDomain: cfg.authDomain?.trim() || `${cfg.projectId.trim()}.firebaseapp.com`,
    appId: cfg.appId?.trim() || undefined,
  };
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(FIREBASE_RUNTIME_STORAGE_KEY, JSON.stringify(runtimeFirebaseConfig));
    }
  } catch {
    // Bỏ qua lỗi quota localStorage trong trình duyệt ẩn danh
  }
}

export function resolveFirebaseClientConfig(): FirebaseClientEnv | null {
  if (runtimeFirebaseConfig) return runtimeFirebaseConfig;
  const apiKey = readEnvString('FIREBASE_API_KEY');
  const projectId = readEnvString('FIREBASE_PROJECT_ID');
  if (apiKey && projectId) {
    return {
      apiKey,
      projectId,
      authDomain: readEnvString('FIREBASE_AUTH_DOMAIN') || `${projectId}.firebaseapp.com`,
      appId: readEnvString('FIREBASE_APP_ID') || undefined,
    };
  }
  return readStoredRuntimeConfig();
}

export function isFirebasePhoneClientConfigured(): boolean {
  return resolveFirebaseClientConfig() !== null;
}
