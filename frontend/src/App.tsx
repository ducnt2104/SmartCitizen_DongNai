import { Suspense, useEffect } from 'react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { UserProfile } from '@shared/types';
import { CommunityLayout } from './components/CommunityLayout';
import { RoleGuard } from './components/RoleGuard';
import { RouteErrorBoundary, RouteLoadingSkeleton } from './components/RouteErrorBoundary';
import { SettingsDrawer } from './components/SettingsDrawer';
import { SpotlightTour } from './components/SpotlightTour';
import { syncBus, type SyncEventDetail } from './db/sync';
import { useI18n, type I18nKey } from './i18n';
import { api } from './lib/api';
import { authStore } from './lib/authStore';
import HomePage from './pages/Home';
import { useToast } from './state/toast';
import { lazyWithRetry } from './utils/lazyWithRetry';

const ReportPage = lazyWithRetry(() => import('./pages/Report'), 'ReportPage');
const MapPage = lazyWithRetry(() => import('./pages/MapPage'), 'MapPage');
const MinePage = lazyWithRetry(() => import('./pages/MinePage'), 'MinePage');
const ProfilePage = lazyWithRetry(() => import('./pages/ProfilePage'), 'ProfilePage');
const VolunteerPage = lazyWithRetry(() => import('./pages/VolunteerPage'), 'VolunteerPage');
const AuthPage = lazyWithRetry(() => import('./pages/AuthPage'), 'AuthPage');
const AdminPage = lazyWithRetry(() => import('./pages/admin/AdminPage'), 'AdminPage');
const RescueLoginPage = lazyWithRetry(() => import('./pages/rescue/RescueLoginPage'), 'RescueLoginPage');
const RescuePortalPage = lazyWithRetry(() => import('./pages/rescue/RescuePortalPage'), 'RescuePortalPage');

/** Đồng bộ hồ sơ & xoay vòng cookie phiên khi khởi động nếu trình duyệt đang lưu phiên. */
function SessionSync() {
  useEffect(() => {
    if (!authStore.get()) return;
    void api<{ user: UserProfile }>('/api/me')
      .then((res) => authStore.updateUser(res.user))
      .catch((err) => {
        console.warn('[SessionSync] Không thể làm mới hồ sơ phiên khởi động:', err);
      });
  }, []);
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
    // Bắt buộc bọc ngoặc nhọn {}: trên Chromium mới, window.scrollTo() trả về Promise thay vì undefined;
    // nếu trả về ngầm Promise từ useEffect, React sẽ gọi Promise như hàm cleanup khi đổi route và gây crash trắng trang!
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
  }, [pathname]);
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
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
              <Route path="profile" element={<ProfilePage />} />
              <Route path="volunteer" element={<VolunteerPage />} />
              <Route path="*" element={<HomePage />} />
            </Route>
            <Route path="auth" element={<AuthPage />} />
            <Route path="rescue/login" element={<RescueLoginPage />} />
            <Route
              path="rescue"
              element={
                <RoleGuard
                  allowedRoles={['rescue_team', 'ward_officer', 'city_admin', 'super_admin']}
                  redirectTo="/rescue/login"
                >
                  <RescuePortalPage />
                </RoleGuard>
              }
            />
            <Route
              path="admin"
              element={
                <RoleGuard
                  allowedRoles={['ward_officer', 'city_admin', 'super_admin']}
                  redirectTo="/auth"
                >
                  <AdminPage />
                </RoleGuard>
              }
            />
            <Route
              path="dashboard"
              element={
                <RoleGuard
                  allowedRoles={['ward_officer', 'city_admin', 'super_admin']}
                  redirectTo="/auth"
                >
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
