import { api } from './api';
import { fastFetch } from './swrCache';

/**
 * Prefetch theo hành vi người dùng (hover/focus vào link hoặc tab):
 *  - Nạp trước JS chunk của route đích (Vite lazy chunk cache)
 *  - Kích hoạt warm fetch qua fastFetch cho API công khai hay truy cập (/api/incidents/map, /api/stats, /api/alerts)
 */
const prefetchedRoutes = new Set<string>();
const prefetchedApis = new Set<string>();

const ROUTE_PRELOADERS: Record<string, () => Promise<unknown>> = {
  '/alerts': () => import('../pages/AlertsPage'),
  '/report': () => import('../pages/Report'),
  '/map': () => import('../pages/MapPage'),
  '/mine': () => import('../pages/MinePage'),
  '/profile': () => import('../pages/ProfilePage'),
  '/auth': () => import('../pages/AuthPage'),
  '/admin': () => import('../pages/admin/AdminPage'),
  '/ioc': () => import('../pages/admin/AdminPage'),
  '/rescue': () => import('../pages/rescue/RescuePortalPage'),
};

export function prefetchRouteChunk(pathname: string): void {
  const clean = pathname.split('?')[0];
  if (prefetchedRoutes.has(clean)) return;
  const loader = ROUTE_PRELOADERS[clean];
  if (loader) {
    prefetchedRoutes.add(clean);
    void loader().catch(() => {
      prefetchedRoutes.delete(clean);
    });
  }
}

export function prefetchPublicApi(url: string): void {
  if (typeof fetch === 'undefined' || !navigator.onLine || prefetchedApis.has(url)) return;
  prefetchedApis.add(url);
  void fastFetch(url, () => api(url), { staleMs: 30_000 }).catch(() => {
    prefetchedApis.delete(url);
  });
  window.setTimeout(() => prefetchedApis.delete(url), 15_000);
}

export function onIntentPrefetch(pathname: string): void {
  prefetchRouteChunk(pathname);
  if (pathname === '/map') {
    prefetchPublicApi('/api/incidents/map?scope=city');
  } else if (pathname === '/alerts') {
    prefetchPublicApi('/api/alerts?status=active&limit=100');
    prefetchPublicApi('/api/weather');
  } else if (pathname === '/') {
    prefetchPublicApi('/api/stats?scope=city');
  }
}
