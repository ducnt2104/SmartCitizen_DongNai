import { AlertTriangle, CloudOff, Flame, Loader2, SearchX, ShieldAlert, X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import type { ClientReport, ReportStatus } from '@shared/types';
import { useI18n } from '../i18n';
import { CATEGORY_META, STATUS_KEY } from '../lib/meta';

export function Spinner({ className = '' }: { className?: string }) {
  return <Loader2 className={`h-5 w-5 animate-spin ${className}`} aria-hidden />;
}

export function SkeletonBlock({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden />;
}

export function SkeletonList({ rows = 4 }: { rows?: number }) {
  const { t } = useI18n();
  return (
    <div className="space-y-3" role="status" aria-label={t('state.loading')}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="card flex gap-3 p-3">
          <SkeletonBlock className="h-16 w-16 shrink-0" />
          <div className="flex-1 space-y-2">
            <SkeletonBlock className="h-4 w-3/4" />
            <SkeletonBlock className="h-3 w-1/2" />
            <SkeletonBlock className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

type Illustration = 'empty' | 'search' | 'offline' | 'error' | 'shield';

function Art({ kind }: { kind: Illustration }) {
  const common = 'h-28 w-28 text-brand';
  return (
    <svg viewBox="0 0 120 120" className={common} fill="none" aria-hidden>
      <circle cx="60" cy="60" r="50" className="fill-brand-soft" />
      {kind === 'empty' && (
        <>
          <rect x="30" y="40" width="60" height="44" rx="8" className="fill-surface stroke-brand" strokeWidth="3" />
          <path d="M30 56h60M46 40v-6a6 6 0 0 1 6-6h16a6 6 0 0 1 6 6v6" className="stroke-brand" strokeWidth="3" />
          <circle cx="60" cy="70" r="5" className="fill-accent" />
        </>
      )}
      {kind === 'search' && (
        <>
          <circle cx="54" cy="54" r="20" className="fill-surface stroke-brand" strokeWidth="4" />
          <path d="m69 69 18 18" className="stroke-brand" strokeWidth="6" strokeLinecap="round" />
          <path d="M46 54h16" className="stroke-accent" strokeWidth="4" strokeLinecap="round" />
        </>
      )}
      {kind === 'offline' && (
        <>
          <path d="M28 70a24 24 0 0 1 8-40 20 20 0 0 1 38 4 16 16 0 0 1 8 32H34a8 8 0 0 1-6-4Z" className="fill-surface stroke-brand" strokeWidth="3" />
          <path d="m38 90 44-52" className="stroke-accent" strokeWidth="5" strokeLinecap="round" />
        </>
      )}
      {kind === 'error' && (
        <>
          <path d="M60 28 94 86H26Z" className="fill-surface stroke-brand" strokeWidth="3" strokeLinejoin="round" />
          <path d="M60 50v18" className="stroke-accent" strokeWidth="5" strokeLinecap="round" />
          <circle cx="60" cy="77" r="3.500" className="fill-accent" />
        </>
      )}
      {kind === 'shield' && (
        <>
          <path d="M60 26 34 36v20c0 16 11 28 26 34 15-6 26-18 26-34V36L60 26Z" className="fill-surface stroke-brand" strokeWidth="3" />
          <path d="m49 58 8 8 15-17" className="stroke-accent" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

export function EmptyState({
  kind = 'empty', title, text, action, secondary, dark = false,
}: { kind?: Illustration; title: string; text?: string; action?: ReactNode; secondary?: ReactNode; dark?: boolean }) {
  return (
    <div className={`flex flex-col items-center px-4 py-8 text-center ${dark ? 'text-ioc-text' : ''}`} role="status">
      <Art kind={kind} />
      <h3 className={`mt-3 text-lg font-bold ${dark ? 'text-ioc-text' : 'text-ink'}`}>{title}</h3>
      {text && <p className={`mt-1 max-w-sm text-sm ${dark ? 'text-ioc-dim' : 'text-muted'}`}>{text}</p>}
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {action}
        {secondary}
      </div>
    </div>
  );
}

export function ErrorState({ title, text, onRetry }: { title: string; text?: string; onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <EmptyState
      kind="error"
      title={title}
      text={text}
      action={onRetry ? <button type="button" className="btn btn-primary" onClick={onRetry}>{t('state.retry')}</button> : undefined}
    />
  );
}

export { CloudOff, SearchX, ShieldAlert, AlertTriangle };

const STATUS_TONE: Record<ReportStatus, string> = {
  received: 'bg-brand-soft text-brand',
  verifying: 'bg-warn-soft text-warn',
  processing: 'bg-warn-soft text-warn',
  resolved: 'bg-ok-soft text-ok',
  quarantined: 'bg-surface-2 text-ink border border-line',
  rejected: 'bg-danger-soft text-danger',
};

export function StatusBadge({ status }: { status: ReportStatus }) {
  const { t } = useI18n();
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_TONE[status]}`}>{t(STATUS_KEY[status])}</span>;
}

export function PriorityBadges({ r }: { r: ClientReport }) {
  const { t } = useI18n();
  return (
    <>
      {r.emergencyLevel === 1 && (
        <span className="inline-flex items-center gap-1 rounded-full bg-danger px-2.5 py-0.5 text-xs font-bold text-white">
          <Flame className="h-3.5 w-3.5" aria-hidden /> {t('badge.emergency1')}
        </span>
      )}
      {r.priority === 'high' && r.emergencyLevel !== 1 && (
        <span className="rounded-full bg-warn-soft px-2.5 py-0.5 text-xs font-bold text-warn">{t('badge.highPriority')}</span>
      )}
      {r.clusterCount >= 2 && (
        <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-bold text-brand">{t('badge.cluster', { n: r.clusterCount })}</span>
      )}
      {r.seniorSubmitted && (
        <span className="rounded-full bg-accent/20 px-2.5 py-0.5 text-xs font-bold text-warn">{t('badge.senior')}</span>
      )}
      {r.isProxyReport && (
        <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-bold text-brand">{t('badge.proxy')}</span>
      )}
      {r.syncState === 'pending' && (
        <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-semibold text-muted">
          <CloudOff className="h-3 w-3" aria-hidden /> {t('badge.pendingSync')}
        </span>
      )}
    </>
  );
}

export function CategoryIcon({ r, size = 'md' }: { r: Pick<ClientReport, 'category'>; size?: 'sm' | 'md' }) {
  const meta = CATEGORY_META[r.category];
  const Icon = meta.icon;
  const s = size === 'sm' ? 'h-8 w-8' : 'h-11 w-11';
  return (
    <span className={`grid ${s} shrink-0 place-items-center rounded-xl border border-line bg-surface-2`} style={{ color: meta.color }}>
      <Icon className={size === 'sm' ? 'h-4 w-4' : 'h-5 w-5'} aria-hidden />
    </span>
  );
}

/** Hộp thoại dạng bottom-sheet (mobile) / modal hoặc slide-over drawer (desktop). Esc để đóng, trả focus khi đóng. */
export function Sheet({
  open,
  onClose,
  title,
  children,
  wide = false,
  variant = 'modal',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
  variant?: 'modal' | 'drawer';
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;

  const isDrawer = variant === 'drawer';

  return (
    <div
      className={`fixed inset-0 z-[1500] flex ${
        isDrawer ? 'items-end justify-center lg:items-stretch lg:justify-end' : 'items-end justify-center sm:items-center'
      }`}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <button
        type="button"
        className="absolute inset-0 bg-slate-950/50 backdrop-blur-[1px]"
        onClick={onClose}
        aria-label={t('common.close')}
        tabIndex={-1}
      />
      <div
        ref={ref}
        tabIndex={-1}
        className={`relative flex w-full animate-slideup flex-col bg-surface shadow-lift outline-none ${
          isDrawer
            ? 'max-h-[88dvh] rounded-t-3xl lg:h-dvh lg:max-h-dvh lg:max-w-[29rem] lg:rounded-none lg:rounded-l-3xl lg:border-l lg:border-line'
            : `max-h-[92dvh] rounded-t-3xl sm:rounded-3xl ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'}`
        }`}
      >
        <div className="mx-auto mt-2 h-1.5 w-11 shrink-0 rounded-full bg-line lg:hidden" aria-hidden />
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="min-w-0 truncate text-lg font-bold">{title}</h2>
          <button type="button" onClick={onClose} className="btn btn-ghost !min-h-10 !min-w-10 !px-2" aria-label={t('common.close')}>
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>
      </div>
    </div>
  );
}
