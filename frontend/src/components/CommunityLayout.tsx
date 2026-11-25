import { Suspense } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { useI18n } from '../i18n';
import { onIntentPrefetch } from '../lib/prefetch';
import { useSettings } from '../state/settings';
import { lazyWithRetry } from '../utils/lazyWithRetry';
import { BottomNav, TopNav } from './BottomNav';
import { FloatingSosWidget } from './FloatingSosWidget';
import { Header } from './Header';
import { Logo } from './Logo';
import { OfflineBanner } from './OfflineBanner';
import { RouteErrorBoundary, RouteLoadingSkeleton } from './RouteErrorBoundary';

const ChatWidget = lazyWithRetry(
  () => import('./ChatWidget').then((m) => ({ default: m.ChatWidget })),
  'ChatWidget',
);

/** Khung Cổng Cộng đồng (Tab A): giữ cố định Header & BottomNav khi chuyển route, bọc Outlet bằng ErrorBoundary + Suspense. */
export function CommunityLayout() {
  const { t } = useI18n();
  const { assistantOpen } = useSettings();
  return (
    <div className="flex min-h-dvh w-full max-w-full flex-col overflow-x-clip">
      <div className="h-1 w-full bg-gradient-to-r from-brand via-brand-2 to-emerald-500" aria-hidden />
      <a href="#main" className="sr-only-focusable fixed left-2 top-2 z-[4000] rounded-lg bg-brand px-3 py-2 text-brand-ink">
        {t('nav.skip')}
      </a>
      <Header />
      <OfflineBanner />
      <TopNav />
      <main id="main" className="mx-auto w-full min-w-0 max-w-5xl flex-1 px-3 pb-6 pt-3 sm:px-4 md:pb-10">
        <FloatingSosWidget />
        <RouteErrorBoundary>
          <Suspense fallback={<RouteLoadingSkeleton />}>
            <Outlet />
          </Suspense>
        </RouteErrorBoundary>
      </main>
      <footer className="border-t border-line/80 bg-surface/90 px-3 py-6 pb-24 text-center backdrop-blur-sm md:pb-6">
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-2">
          <Logo stacked />
          <p className="text-sm font-semibold text-ink">{t('footer.credit')}</p>
          <p className="text-xs text-muted">{t('footer.tagline')}</p>
          <nav aria-label="Liên kết thông tin" className="mt-1 flex flex-wrap items-center justify-center gap-4 text-xs font-semibold text-brand">
            <Link to="/" onMouseEnter={() => onIntentPrefetch('/')} className="hover:underline">Trang chủ</Link>
            <Link to="/map" onMouseEnter={() => onIntentPrefetch('/map')} className="hover:underline">Bản đồ sự cố</Link>
            <Link to="/alerts" onMouseEnter={() => onIntentPrefetch('/alerts')} className="hover:underline">Cảnh báo thiên tai & giao thông</Link>
            <Link to="/report" onMouseEnter={() => onIntentPrefetch('/report')} className="hover:underline">Gửi phản ánh</Link>
            <Link to="/mine" onMouseEnter={() => onIntentPrefetch('/mine')} className="hover:underline">Tra cứu hồ sơ</Link>
            <Link to="/gioi-thieu" onMouseEnter={() => onIntentPrefetch('/gioi-thieu')} className="hover:underline">Giới thiệu & Team Victer</Link>
          </nav>
        </div>
      </footer>
      {assistantOpen && (
        <Suspense fallback={null}>
          <ChatWidget />
        </Suspense>
      )}
      <BottomNav />
    </div>
  );
}
