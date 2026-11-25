import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, KeyRound, X } from 'lucide-react';

export type ToastKind = 'info' | 'success' | 'error' | 'demo';
interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  text?: string;
}

interface Ctx {
  toast: (kind: ToastKind, title: string, text?: string, ttlMs?: number) => void;
}

const ToastContext = createContext<Ctx | null>(null);

const ICON = { info: Info, success: CheckCircle2, error: AlertTriangle, demo: KeyRound } as const;
const TONE: Record<ToastKind, string> = {
  info: 'border-brand/40 bg-surface',
  success: 'border-ok/50 bg-surface',
  error: 'border-danger/60 bg-surface',
  demo: 'border-warn/60 bg-warn-soft',
};
const ICON_TONE: Record<ToastKind, string> = { info: 'text-brand', success: 'text-ok', error: 'text-danger', demo: 'text-warn' };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setItems((l) => l.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (kind: ToastKind, title: string, text?: string, ttlMs = kind === 'demo' ? 20000 : 5000) => {
      const id = ++seq.current;
      setItems((l) => [...l.slice(-3), { id, kind, title, text }]);
      window.setTimeout(() => dismiss(id), ttlMs);
    },
    [dismiss],
  );
  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-3 z-[2000] flex flex-col items-center gap-2 px-3" aria-live="polite" role="status">
        {items.map((t) => {
          const Icon = ICON[t.kind];
          return (
            <div key={t.id} className={`pointer-events-auto flex w-full max-w-md animate-slideup items-start gap-3 rounded-2xl border p-3 shadow-lift ${TONE[t.kind]}`}>
              <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${ICON_TONE[t.kind]}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="break-words font-semibold text-ink">{t.title}</p>
                {t.text && <p className="mt-0.5 break-words text-sm text-muted">{t.text}</p>}
              </div>
              <button type="button" onClick={() => dismiss(t.id)} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): Ctx['toast'] {
  const c = useContext(ToastContext);
  if (!c) throw new Error('useToast phải nằm trong <ToastProvider>');
  return c.toast;
}
