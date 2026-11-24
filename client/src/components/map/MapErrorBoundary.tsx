import { AlertTriangle, MapPin, RefreshCw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useI18n } from '../../i18n';

interface BoundaryProps {
  resetKey: string;
  onCaughtError?: (error: Error) => void;
  fallback?: (reset: () => void, message: string) => ReactNode;
  children: ReactNode;
}

interface BoundaryState {
  hasError: boolean;
  message: string;
}

class RawErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { hasError: false, message: '' };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : 'Map rendering error',
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[MapErrorBoundary] Đã chặn lỗi không để trắng trang:', error, info.componentStack);
    this.props.onCaughtError?.(error);
  }

  componentDidUpdate(prevProps: BoundaryProps): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false, message: '' });
    }
  }

  private handleReset = (): void => {
    this.setState({ hasError: false, message: '' });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback(this.handleReset, this.state.message);
      }
      return <DefaultMapRecoveryCard onRetry={this.handleReset} />;
    }
    return this.props.children;
  }
}

function DefaultMapRecoveryCard({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div
      role="alert"
      className="flex min-h-[18rem] w-full flex-col items-center justify-center gap-3 rounded-2xl border border-line bg-surface-2 p-6 text-center"
    >
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-warn-soft text-warn">
        <AlertTriangle className="h-6 w-6" aria-hidden />
      </span>
      <div className="max-w-sm space-y-1">
        <p className="text-base font-bold text-ink">{t('map.errorTitle')}</p>
        <p className="text-xs text-muted">{t('map.errorHint')}</p>
      </div>
      <button type="button" onClick={onRetry} className="btn btn-primary !min-h-10 !px-4 !text-sm">
        <RefreshCw className="h-4 w-4" aria-hidden /> {t('state.retry')}
      </button>
    </div>
  );
}

/**
 * ErrorBoundary chuyên biệt cho Bản đồ — tự động reset sạch trạng thái khi đổi `location.pathname`
 * để đảm bảo điều hướng SPA qua lại giữa `/`, `/map`, `/report`, `/admin` không bao giờ kẹt trắng trang.
 */
export function MapErrorBoundary({
  children,
  onCaughtError,
  extraResetKey = '',
}: {
  children: ReactNode;
  onCaughtError?: (error: Error) => void;
  extraResetKey?: string;
}) {
  const { pathname } = useLocation();
  return (
    <RawErrorBoundary resetKey={`${pathname}:${extraResetKey}`} onCaughtError={onCaughtError}>
      {children}
    </RawErrorBoundary>
  );
}

/** Khung Skeleton UI mượt mà trong lúc nạp lười (Suspense) bản đồ. */
export function MapSkeleton({ className = 'h-[58dvh]' }: { className?: string }) {
  return (
    <div
      className={`skeleton relative grid place-items-center overflow-hidden rounded-2xl border border-line ${className}`}
      role="status"
      aria-label="Đang khởi tạo bản đồ Thành phố Đồng Nai"
    >
      <div className="flex flex-col items-center gap-2 rounded-2xl bg-surface/85 px-4 py-3 shadow-card backdrop-blur-sm">
        <MapPin className="h-6 w-6 animate-bounce text-brand" aria-hidden />
        <span className="text-xs font-semibold text-muted">Đang tải bản đồ TP. Đồng Nai…</span>
      </div>
    </div>
  );
}
