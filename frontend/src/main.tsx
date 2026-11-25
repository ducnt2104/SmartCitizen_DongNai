import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { hydrate } from './db/hydrate';
import { startSyncEngine } from './db/sync';
import { I18nProvider } from './i18n';
import { ensureDeviceFingerprint } from './lib/deviceFp';
import { AuthGateProvider } from './state/authGate';
import { SettingsProvider } from './state/settings';
import { ToastProvider } from './state/toast';
import { installPreloadRecovery } from './utils/lazyWithRetry';
import './index.css';

installPreloadRecovery();

function Boot() {
  return (
    <SettingsProvider>
      <I18nProvider>
        <ToastProvider>
          <AuthGateProvider>
            <App />
          </AuthGateProvider>
        </ToastProvider>
      </I18nProvider>
    </SettingsProvider>
  );
}

async function start(): Promise<void> {
  // Instant Hydration: nạp seed IndexedDB (chỉ lần đầu) TRƯỚC khi vẽ UI để Trang chủ có dữ liệu ngay, không chờ mạng.
  try {
    const h = await hydrate();
    if (h.seeded) console.info(`[hydrate] seed IndexedDB lần đầu trong ${h.ms.toFixed(0)}ms`);
  } catch (err) {
    console.error('[hydrate] IndexedDB không khả dụng — ứng dụng sẽ chỉ dùng dữ liệu từ máy chủ:', err);
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Boot />
    </StrictMode>,
  );
  void ensureDeviceFingerprint().catch((err) => console.warn('Không tạo được device fingerprint:', err));
  startSyncEngine();
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker không đăng ký được:', err));
    });
  }
}

void start();
