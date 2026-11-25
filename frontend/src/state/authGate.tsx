import { createContext, lazy, Suspense, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Sheet } from '../components/ui';
import { useI18n } from '../i18n';
import { authStore } from '../lib/authStore';

const CitizenLogin = lazy(() =>
  import('../components/CitizenLogin').then((m) => ({ default: m.CitizenLogin })),
);

interface Ctx {
  /** Mở hộp thoại OTP nếu chưa đăng nhập. Resolve true khi đã có phiên hợp lệ. */
  requireAuth: () => Promise<boolean>;
}

const AuthGateContext = createContext<Ctx | null>(null);

export function AuthGateProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const finish = useCallback((ok: boolean) => {
    setOpen(false);
    resolver.current?.(ok);
    resolver.current = null;
  }, []);

  const requireAuth = useCallback(() => {
    if (authStore.token()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setOpen(true);
    });
  }, []);

  const value = useMemo(() => ({ requireAuth }), [requireAuth]);
  return (
    <AuthGateContext.Provider value={value}>
      {children}
      <Sheet open={open} onClose={() => finish(false)} title={t('auth.gateTitle')}>
        <p className="mb-4 text-sm text-muted">{t('auth.gateText')}</p>
        {open ? (
          <Suspense fallback={<div className="h-44 animate-pulse rounded-2xl bg-surface-2" aria-busy="true" />}>
            <CitizenLogin compact onDone={() => finish(true)} />
          </Suspense>
        ) : null}
      </Sheet>
    </AuthGateContext.Provider>
  );
}

export function useAuthGate(): Ctx {
  const c = useContext(AuthGateContext);
  if (!c) throw new Error('useAuthGate phải nằm trong <AuthGateProvider>');
  return c;
}
