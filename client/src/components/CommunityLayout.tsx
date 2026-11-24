import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import { useI18n } from '../i18n';
import { BottomNav, TopNav } from './BottomNav';
import { ChatWidget } from './ChatWidget';
import { Header } from './Header';
import { Logo } from './Logo';
import { OfflineBanner } from './OfflineBanner';
import { RouteErrorBoundary, RouteLoadingSkeleton } from './RouteErrorBoundary';

/** Khung Cổng Cộng đồng (Tab A): giữ cố định Header & BottomNav khi chuyển route, bọc Outlet bằng ErrorBoundary + Suspense. */
export function CommunityLayout() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only-focusable fixed left-2 top-2 z-[4000] rounded-lg bg-brand px-3 py-2 text-brand-ink">
        {t('nav.skip')}
      </a>
      <Header />
      <OfflineBanner />
      <TopNav />
      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-3 pb-28 pt-4 md:pb-10">
        <RouteErrorBoundary>
          <Suspense fallback={<RouteLoadingSkeleton />}>
            <Outlet />
          </Suspense>
        </RouteErrorBoundary>
      </main>
      <footer className="border-t border-line bg-surface px-3 py-5 pb-28 text-center md:pb-5">
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-2">
          <Logo compact />
          <p className="text-sm font-semibold text-ink">{t('footer.credit')}</p>
          <p className="text-xs text-muted">{t('footer.tagline')}</p>
        </div>
      </footer>
      <ChatWidget />
      <BottomNav />
    </div>
  );
}
