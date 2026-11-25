import { AlertTriangle, Home, RefreshCw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { SkeletonBlock } from './ui';

/** Skeleton giữ khung bố cục tức thì khi chuyển giữa các route lazy-loaded (không nháy trắng). */
export function RouteLoadingSkeleton({ fullScreen = false }: { fullScreen?: boolean }) {
  return (
    <div
      className={fullScreen ? 'mx-auto max-w-5xl space-y-4 px-4 py-8' : 'space-y-4 py-2'}
      role="status"
      aria-live="polite"
      aria-label="Đang tải trang"
    >
      <SkeletonBlock className="h-9 w-56 rounded-xl" />
      <SkeletonBlock className="h-36 w-full rounded-2xl" />
      <div className="grid gap-3 sm:grid-cols-2">
        <SkeletonBlock className="h-28 rounded-2xl" />
        <SkeletonBlock className="h-28 rounded-2xl" />
      </div>
    </div>
  );
}

interface InnerProps {
  resetKey: string;
  onGoHome: () => void;
  children: ReactNode;
}

interface InnerState {
  error: Error | null;
}

class ErrorBoundaryInner extends Component<InnerProps, InnerState> {
  state: InnerState = { error: null };

  static getDerivedStateFromError(error: Error): InnerState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[RouteErrorBoundary] Bắt được lỗi runtime khi render route:', error, info.componentStack);
  }

  componentDidUpdate(prevProps: InnerProps): void {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleHome = (): void => {
    this.setState({ error: null });
    this.props.onGoHome();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div role="alert" className="mx-auto my-6 max-w-lg rounded-3xl border border-danger/30 bg-surface p-6 text-center shadow-lift">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-danger-soft text-danger">
          <AlertTriangle className="h-7 w-7" aria-hidden />
        </div>
        <h2 className="mt-4 text-xl font-extrabold text-ink">Không thể hiển thị trang này</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Ứng dụng vừa được cập nhật phiên bản mới hoặc kết nối mạng bị gián đoạn khi tải tài nguyên trang. Hãy tải lại trang để đồng bộ bản mới nhất.
        </p>
        <p className="mono mt-3 truncate rounded-xl bg-surface-2 px-3 py-2 text-xs text-muted" title={this.state.error.message}>
          {this.state.error.message || 'Runtime Render Error'}
        </p>
        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          <button type="button" className="btn btn-primary" onClick={this.handleReload}>
            <RefreshCw className="h-4 w-4" aria-hidden /> Tải lại trang
          </button>
          <button type="button" className="btn btn-ghost" onClick={this.handleHome}>
            <Home className="h-4 w-4" aria-hidden /> Về Trang chủ
          </button>
        </div>
      </div>
    );
  }
}

/** ErrorBoundary tự động reset theo `location.pathname` — chặn hoàn toàn lỗi màn hình trắng (WSOD). */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <ErrorBoundaryInner resetKey={location.pathname} onGoHome={() => navigate('/', { replace: true })}>
      {children}
    </ErrorBoundaryInner>
  );
}
