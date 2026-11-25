import { Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { UserProfile } from '@shared/types';
import { CommunityLayout } from './components/CommunityLayout';
import { RoleGuard } from './components/RoleGuard';
import { RouteErrorBoundary, RouteLoadingSkeleton } from './components/RouteErrorBoundary';
import { SettingsDrawer } from './components/SettingsDrawer';
import { SpotlightTour } from './components/SpotlightTour';
import { syncBus, type SyncEventDetail } from './db/sync';
import { useI18n, type I18nKey } from './i18n';
import { api, apiUrl, sessionTerminatedBus, type SessionTerminatedDetail } from './lib/api';
import { authStore, useSession } from './lib/authStore';
import HomePage from './pages/Home';
import { useToast } from './state/toast';
import { lazyWithRetry } from './utils/lazyWithRetry';
import { useRouteSeo } from './utils/usePageSeo';

const ReportPage = lazyWithRetry(() => import('./pages/Report'), 'ReportPage');
const MapPage = lazyWithRetry(() => import('./pages/MapPage'), 'MapPage');
const MinePage = lazyWithRetry(() => import('./pages/MinePage'), 'MinePage');
const ProfilePage = lazyWithRetry(() => import('./pages/ProfilePage'), 'ProfilePage');
const NotFoundPage = lazyWithRetry(() => import('./pages/NotFoundPage'), 'NotFoundPage');
const AboutPage = lazyWithRetry(() => import('./pages/AboutPage'), 'AboutPage');
const PublicReportPage = lazyWithRetry(() => import('./pages/PublicReportPage'), 'PublicReportPage');
const AuthPage = lazyWithRetry(() => import('./pages/AuthPage'), 'AuthPage');
const AdminPage = lazyWithRetry(() => import('./pages/admin/AdminPage'), 'AdminPage');
const RescuePortalPage = lazyWithRetry(() => import('./pages/rescue/RescuePortalPage'), 'RescuePortalPage');

/** Đồng bộ hồ sơ, lắng nghe 401 SESSION_REPLACED & luồng SSE thu hồi phiên tức thì. */
function SessionSync() {
  const session = useSession();
  const toast = useToast();
  const nav = useNavigate();

  useEffect(() => {
    if (!authStore.get()) return;
    void api<{ user: UserProfile }>('/api/me')
      .then((res) => authStore.updateUser(res.user))
      .catch((err) => {
        console.warn('[SessionSync] Không thể làm mới hồ sơ phiên khởi động:', err);
      });
  }, []);

  useEffect(() => {
    const onTerminated = (ev: Event): void => {
      const detail = (ev as CustomEvent<SessionTerminatedDetail>).detail;
      toast('error', 'Phiên đăng nhập đã kết thúc', detail.message);
      nav('/auth', { replace: true });
    };
    sessionTerminatedBus.addEventListener('terminated', onTerminated);
    return () => sessionTerminatedBus.removeEventListener('terminated', onTerminated);
  }, [nav, toast]);

  useEffect(() => {
    if (!session?.user || typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    try {
      es = new EventSource(apiUrl('/api/auth/session-events'), { withCredentials: true });
      es.addEventListener('session_terminated', (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent<string>).data) as SessionTerminatedDetail;
          authStore.clear();
          toast('error', 'Phiên đăng nhập bị thu hồi', data.message);
          nav('/auth', { replace: true });
        } catch {
          authStore.clear();
          nav('/auth', { replace: true });
        }
        es?.close();
      });
    } catch {
      // Bỏ qua nếu môi trường test không bật EventSource cookie
    }
    return () => {
      es?.close();
    };
  }, [session?.user?.id, nav, toast]);

  return null;
}

/** Thông báo kết quả đồng bộ Outbox (kể cả đơn gửi lúc ngoại tuyến được xử lý sau). */
function SyncToasts() {
  const toast = useToast();
  const { t } = useI18n();
  useEffect(() => {
    const on = (e: Event): void => {
      const d = (e as CustomEvent<SyncEventDetail>).detail;
      if (d.type === 'report_result') {
        const bad = d.messageCode.startsWith('quarantine');
        toast(
          bad ? 'info' : d.messageCode === 'emergency' ? 'error' : 'success',
          t(`result.${d.messageCode}` as I18nKey),
          d.report.code,
        );
      } else if (d.type === 'item_failed') {
        toast('error', t('outbox.failedToast'), d.message);
      }
    };
    syncBus.addEventListener('sync', on);
    return () => syncBus.removeEventListener('sync', on);
  }, [toast, t]);
  return null;
}

function ScrollTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
  }, [pathname]);
  return null;
}

function RouteSeoSync() {
  useRouteSeo();
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <RouteSeoSync />
      <SessionSync />
      <SyncToasts />
      <RouteErrorBoundary>
        <ScrollTop />
        <Suspense fallback={<RouteLoadingSkeleton fullScreen />}>
          <Routes>
            <Route element={<CommunityLayout />}>
              <Route index element={<HomePage />} />
              <Route path="report" element={<ReportPage />} />
              <Route path="map" element={<MapPage />} />
              <Route path="mine" element={<MinePage />} />
              <Route path="gioi-thieu" element={<AboutPage />} />
              <Route path="phan-anh/:code" element={<PublicReportPage />} />
              <Route path="profile" element={<ProfilePage />} />
              <Route path="volunteer" element={<Navigate to="/ioc" replace />} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
            <Route path="auth" element={<AuthPage />} />
            <Route path="rescue/login" element={<Navigate to="/auth" replace />} />
            <Route
              path="rescue"
              element={
                <RoleGuard allowedRoles={['rescue', 'officer', 'admin']} redirectTo="/auth">
                  <RescuePortalPage />
                </RoleGuard>
              }
            />
            <Route
              path="ioc"
              element={
                <RoleGuard allowedRoles={['officer', 'admin']} redirectTo="/auth">
                  <AdminPage />
                </RoleGuard>
              }
            />
            <Route
              path="admin"
              element={
                <RoleGuard allowedRoles={['admin', 'officer']} redirectTo="/auth">
                  <AdminPage />
                </RoleGuard>
              }
            />
            <Route
              path="dashboard"
              element={
                <RoleGuard allowedRoles={['admin', 'officer']} redirectTo="/auth">
                  <AdminPage />
                </RoleGuard>
              }
            />
          </Routes>
        </Suspense>
      </RouteErrorBoundary>
      <SettingsDrawer />
      <SpotlightTour />
    </BrowserRouter>
  );
}
