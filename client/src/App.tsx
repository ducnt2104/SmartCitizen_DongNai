import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { CommunityLayout } from './components/CommunityLayout';
import { SettingsDrawer } from './components/SettingsDrawer';
import { SpotlightTour } from './components/SpotlightTour';
import { Spinner } from './components/ui';
import { syncBus, type SyncEventDetail } from './db/sync';
import { useI18n, type I18nKey } from './i18n';
import { useToast } from './state/toast';
import HomePage from './pages/Home';

const ReportPage = lazy(() => import('./pages/Report'));
const MapPage = lazy(() => import('./pages/MapPage'));
const MinePage = lazy(() => import('./pages/MinePage'));
const VolunteerPage = lazy(() => import('./pages/VolunteerPage'));
const AuthPage = lazy(() => import('./pages/AuthPage'));
const AdminPage = lazy(() => import('./pages/admin/AdminPage'));

function Fallback() {
  return <div className="grid min-h-[40dvh] place-items-center"><Spinner className="h-8 w-8 text-brand" /></div>;
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
        toast(bad ? 'info' : d.messageCode === 'emergency' ? 'error' : 'success', t(`result.${d.messageCode}` as I18nKey), d.report.code);
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
  useEffect(() => window.scrollTo(0, 0), [pathname]);
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <ScrollTop />
      <SyncToasts />
      <Suspense fallback={<Fallback />}>
        <Routes>
          <Route element={<CommunityLayout />}>
            <Route index element={<HomePage />} />
            <Route path="report" element={<ReportPage />} />
            <Route path="map" element={<MapPage />} />
            <Route path="mine" element={<MinePage />} />
            <Route path="volunteer" element={<VolunteerPage />} />
            <Route path="*" element={<HomePage />} />
          </Route>
          <Route path="auth" element={<AuthPage />} />
          <Route path="admin" element={<AdminPage />} />
        </Routes>
      </Suspense>
      <SettingsDrawer />
      <SpotlightTour />
    </BrowserRouter>
  );
}
