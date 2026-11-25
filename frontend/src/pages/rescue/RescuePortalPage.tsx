import {
  CheckCircle2,
  Clock,
  ListFilter,
  LogOut,
  MapPin,
  Navigation2,
  Power,
  RefreshCw,
  Search,
  ShieldAlert,
  Siren,
  SkipForward,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { normalizeRole } from '@shared/constants';
import type { RescueMissionItem, RescueMissionsResponse } from '@shared/types';
import { Logo } from '../../components/Logo';
import type { CameraCommand } from '../../components/map/GoogleMapEngine';
import { UnifiedMapCanvas } from '../../components/map/UnifiedMapCanvas';
import { TacticalNavigationWorkspace } from '../../components/navigation/TacticalNavigationWorkspace';
import { Spinner } from '../../components/ui';
import { WARD_BY_CODE } from '../../data/dongNaiWards';
import { db } from '../../db/localDb';
import { useLiveNavigationGps } from '../../hooks/useLiveNavigationGps';
import { useI18n } from '../../i18n';
import { api, ApiError } from '../../lib/api';
import { authStore, useSession } from '../../lib/authStore';
import { CATEGORY_META } from '../../lib/meta';
import { computeNavigationRoute, type NavigationRoute } from '../../lib/navigationEngine';
import { playIncomingMissionChime, playMissionSuccessChime } from '../../lib/rescueChime';
import { useToast } from '../../state/toast';

type DrawerTab = 'available' | 'sos' | 'resolved';

const DUTY_STORAGE_KEY = 'sc_rescue_duty_online';

function getUrgencyBadge(m: RescueMissionItem): {
  label: 'KHẨN CẤP' | 'CAO' | 'BÌNH THƯỜNG';
  className: string;
  isUrgent: boolean;
} {
  if (m.severityLabel === 'CRITICAL' || m.isEmergency || m.emergencyLevel === 1) {
    return {
      label: 'KHẨN CẤP',
      className: 'bg-rose-600 text-white shadow-sm',
      isUrgent: true,
    };
  }
  if (m.severityLabel === 'HIGH' || m.priority === 'high' || m.severity >= 4) {
    return {
      label: 'CAO',
      className: 'bg-amber-500 text-slate-950',
      isUrgent: false,
    };
  }
  return {
    label: 'BÌNH THƯỜNG',
    className: 'bg-[#1A73E8] text-white',
    isUrgent: false,
  };
}

export default function RescuePortalPage() {
  const { t } = useI18n();
  const nav = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();
  const session = useSession();
  const me = session?.user;

  const { pos: livePos, refreshNow } = useLiveNavigationGps(me?.wardCode);

  const [isOnline, setIsOnline] = useState<boolean>(() => {
    try {
      const saved = sessionStorage.getItem(DUTY_STORAGE_KEY);
      return saved === null ? true : saved === '1';
    } catch {
      return true;
    }
  });

  const [activeMission, setActiveMission] = useState<RescueMissionItem | null>(null);
  const [availableMissions, setAvailableMissions] = useState<RescueMissionItem[]>([]);
  const [resolvedMissions, setResolvedMissions] = useState<RescueMissionItem[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);

  // Điều khiển thẻ nhận đơn nổi & ngăn kéo danh sách đơn quanh đây
  const [skippedIds, setSkippedIds] = useState<string[]>([]);
  const [focusedId, setFocusedId] = useState<string | null>(() => searchParams.get('missionId'));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('available');
  const [queryText, setQueryText] = useState('');

  // Bản đồ ở chế độ trực chiến chờ nhận đơn (Standby Map)
  const [standbyAutoFollow, setStandbyAutoFollow] = useState(false);
  const [standbyCameraCmd, setStandbyCameraCmd] = useState<CameraCommand | null>(null);
  const [fitRouteSeq, setFitRouteSeq] = useState(1);
  const [previewRoute, setPreviewRoute] = useState<NavigationRoute | null>(null);

  const knownMissionIdsRef = useRef<Set<string> | null>(null);
  const livePosRef = useRef(livePos);
  livePosRef.current = livePos;

  const issueStandbyCamera = useCallback((cmd: Omit<CameraCommand, 'seq'>) => {
    setStandbyCameraCmd((prev) => ({ ...cmd, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

  const toggleDutyOnline = (): void => {
    const next = !isOnline;
    setIsOnline(next);
    try {
      sessionStorage.setItem(DUTY_STORAGE_KEY, next ? '1' : '0');
    } catch {
      // ignore storage quota
    }
    if (next) {
      setSkippedIds([]);
      playMissionSuccessChime();
      toast('success', 'Đang trực chiến — Tự động quét đơn sự cố mới mỗi 5 giây');
    } else {
      toast('info', 'Đã chuyển sang chế độ Tạm nghỉ ca');
    }
  };

  const fetchMissions = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true);
      try {
        const curPos = livePosRef.current;
        const qs = new URLSearchParams({
          lat: String(curPos.lat),
          lng: String(curPos.lng),
          includeResolved: '1',
        });
        const data = await api<RescueMissionsResponse>(`/api/rescue/missions?${qs.toString()}`, {
          timeoutMs: 12000,
        });

        setActiveMission(data.activeMission);
        setAvailableMissions(data.availableMissions);
        setResolvedMissions(data.resolvedMissions ?? []);

        // Phát âm báo nhẹ khi có đơn sự cố mới xuất hiện trong ca trực tuyến
        const nextIds = new Set(data.availableMissions.map((m) => m.id));
        if (knownMissionIdsRef.current !== null && isOnline && !data.activeMission) {
          const brandNew = data.availableMissions.filter((m) => !knownMissionIdsRef.current!.has(m.id));
          if (brandNew.length > 0) {
            const hasSos = brandNew.some(
              (m) => m.severityLabel === 'CRITICAL' || m.isEmergency || m.emergencyLevel === 1,
            );
            playIncomingMissionChime(hasSos);
          }
        }
        knownMissionIdsRef.current = nextIds;
      } catch (e) {
        if (!silent) {
          toast('error', 'Không tải được danh sách đơn cứu hộ', e instanceof ApiError ? e.message : undefined);
        }
      } finally {
        setInitialLoading(false);
        setRefreshing(false);
      }
    },
    [isOnline, toast],
  );

  // Nạp ngay khi mở trang (ưu tiên khôi phục ngay `activeMission` nếu F5 giữa chừng)
  useEffect(() => {
    void fetchMissions(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tự động lắng nghe đơn mới mỗi 5 giây khi bật "Đang trực chiến" và chưa khóa vào chuyến đang chạy
  useEffect(() => {
    if (!isOnline || activeMission) return undefined;
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void fetchMissions(true);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [isOnline, activeMission, fetchMissions]);

  // Đơn sự cố nổi đang đề xuất nhận ngay (giống thẻ nổ đơn Grab Driver)
  const incomingMission = useMemo(() => {
    if (!isOnline || availableMissions.length === 0) return null;
    if (focusedId) {
      const explicit = availableMissions.find((m) => m.id === focusedId);
      if (explicit && !skippedIds.includes(explicit.id)) return explicit;
    }
    const unskipped = availableMissions.filter((m) => !skippedIds.includes(m.id));
    return unskipped[0] ?? null;
  }, [isOnline, availableMissions, focusedId, skippedIds]);

  // Tính đường đi xem trước (Google Directions -> OSRM) cho thẻ nhận đơn đang nổi
  useEffect(() => {
    if (activeMission || !incomingMission) {
      setPreviewRoute(null);
      return undefined;
    }
    const ctrl = new AbortController();
    void computeNavigationRoute(
      { lat: livePos.lat, lng: livePos.lng },
      { lat: incomingMission.lat, lng: incomingMission.lng },
      'rescue_truck',
      ctrl.signal,
    ).then((r) => {
      if (!ctrl.signal.aborted) {
        setPreviewRoute(r);
        setFitRouteSeq((s) => s + 1);
      }
    });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMission?.id, incomingMission?.id]);

  // Camera tự động bám xe trên màn hình chờ nếu người dùng bấm "Định vị lại"
  useEffect(() => {
    if (!standbyAutoFollow || activeMission) return;
    issueStandbyCamera({
      kind: 'flyTo',
      lat: livePos.lat,
      lng: livePos.lng,
      zoom: 15.8,
    });
  }, [standbyAutoFollow, activeMission, livePos.lat, livePos.lng, issueStandbyCamera]);

  const handleAcceptMission = async (target: RescueMissionItem): Promise<void> => {
    if (acceptingId) return;
    setAcceptingId(target.id);
    try {
      const claimed = await api<RescueMissionItem>(`/api/rescue/missions/${target.id}/accept`, {
        method: 'POST',
        body: {
          lat: livePos.lat,
          lng: livePos.lng,
        },
      });
      await db.reports.put({ ...claimed, syncState: 'synced' }).catch(() => undefined);
      playMissionSuccessChime();
      setActiveMission(claimed);
      setAvailableMissions((prev) => prev.filter((m) => m.id !== claimed.id));
      setDrawerOpen(false);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('missionId', claimed.id);
          return next;
        },
        { replace: true },
      );
      toast('success', 'Đã nhận đơn cứu hộ — Bắt đầu dẫn đường tới hiện trường!', claimed.code);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast('error', e.message || 'Đơn sự cố này đã được đội khác tiếp nhận');
        void fetchMissions(true);
      } else {
        toast('error', 'Không thể tiếp nhận đơn sự cố', e instanceof ApiError ? e.message : undefined);
      }
    } finally {
      setAcceptingId(null);
    }
  };

  const handleSkipIncoming = (id: string): void => {
    setSkippedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    if (focusedId === id) setFocusedId(null);
  };

  const handleFocusMissionFromMapOrDrawer = (m: RescueMissionItem): void => {
    setStandbyAutoFollow(false);
    setSkippedIds((prev) => prev.filter((id) => id !== m.id));
    setFocusedId(m.id);
    setDrawerOpen(false);
    setFitRouteSeq((s) => s + 1);
  };

  const handleActiveMissionUpdated = useCallback((updated: RescueMissionItem) => {
    if (updated.status === 'resolved' || updated.rescueStatus === 'RESOLVED') {
      setActiveMission(null);
      setResolvedMissions((prev) => [updated, ...prev.filter((x) => x.id !== updated.id)]);
    } else if (!updated.assignedRescueId && updated.rescueMission?.status === 'unassigned') {
      setActiveMission(null);
    } else {
      setActiveMission(updated);
    }
  }, []);

  const handleMissionClosed = useCallback(
    (_reason: 'resolved' | 'released', _updated: RescueMissionItem) => {
      setActiveMission(null);
      setSkippedIds([]);
      setFocusedId(null);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('missionId');
          return next;
        },
        { replace: true },
      );
      void fetchMissions(true);
    },
    [fetchMissions, setSearchParams],
  );

  const filteredDrawerList = useMemo(() => {
    const base =
      drawerTab === 'resolved'
        ? resolvedMissions
        : drawerTab === 'sos'
          ? availableMissions.filter(
              (m) => m.severityLabel === 'CRITICAL' || m.isEmergency || m.emergencyLevel === 1,
            )
          : availableMissions;
    const lowQ = queryText.trim().toLowerCase();
    if (!lowQ) return base;
    return base.filter((m) => {
      const wardName = WARD_BY_CODE[m.wardCode]?.name.toLowerCase() ?? '';
      return (
        m.title.toLowerCase().includes(lowQ) ||
        m.code.toLowerCase().includes(lowQ) ||
        m.address.toLowerCase().includes(lowQ) ||
        m.wardCode.toLowerCase().includes(lowQ) ||
        wardName.includes(lowQ)
      );
    });
  }, [drawerTab, availableMissions, resolvedMissions, queryText]);

  if (initialLoading) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-slate-950 p-6 text-center text-slate-200">
        <Spinner className="h-8 w-8 text-[#00B14F]" />
        <p className="text-sm font-bold">Đang kết nối Trung tâm Điều phối Cứu hộ Đồng Nai…</p>
      </div>
    );
  }

  // ── CHẾ ĐỘ 1: ĐANG THỰC HIỆN NHIỆM VỤ (ACTIVE TRIP LOCKED MODE) ──
  if (activeMission) {
    return (
      <TacticalNavigationWorkspace
        mission={activeMission}
        allMarkers={[activeMission]}
        livePos={livePos}
        onRefreshGps={() => void refreshNow()}
        onMissionUpdated={handleActiveMissionUpdated}
        onMissionClosed={handleMissionClosed}
        isActiveDriverTrip
      />
    );
  }

  // ── CHẾ ĐỘ 2: TRỰC CHIẾN CHỜ NHẬN ĐƠN (FULL-SCREEN MAP + FLOATING GRAB DRIVER CONTROLS) ──
  const badgeMeta = incomingMission ? getUrgencyBadge(incomingMission) : null;
  const incomingWard = incomingMission ? WARD_BY_CODE[incomingMission.wardCode] : null;
  const displayDistKm = previewRoute?.distanceKm ?? incomingMission?.distanceKm ?? null;
  const displayEtaMin = previewRoute?.durationMin ?? incomingMission?.etaMinutes ?? null;

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-slate-950 text-slate-100 select-none">
      {/* Bản đồ toàn màn hình hiển thị vị trí đội cứu hộ + các sự cố quanh đây + tuyến đường xem trước */}
      <UnifiedMapCanvas
        reports={availableMissions}
        initialCenter={[livePos.lat, livePos.lng]}
        initialZoom={14}
        tone="ioc"
        cameraCommand={standbyCameraCmd}
        onRequestCamera={issueStandbyCamera}
        userPos={{ lat: livePos.lat, lng: livePos.lng }}
        userHeadingDeg={livePos.heading}
        navigationMode
        accuracyM={livePos.accuracy}
        activeDestinationId={incomingMission?.id ?? null}
        autoFollow={standbyAutoFollow}
        followPadding={{
          top: 84,
          bottom: incomingMission ? 280 : 120,
          left: 0,
          right: 0,
        }}
        fitRouteSeq={incomingMission ? fitRouteSeq : undefined}
        onSelect={(m) => {
          const found = availableMissions.find((x) => x.id === m.id);
          if (found) handleFocusMissionFromMapOrDrawer(found);
        }}
        onUserPan={() => setStandbyAutoFollow(false)}
        showLayerSwitcher={false}
        showFallbackBadge={false}
        controlsBottomClassName={incomingMission ? 'bottom-[19rem] sm:bottom-[17.5rem]' : 'bottom-24'}
        routeOverlay={
          incomingMission
            ? {
                origin: { lat: livePos.lat, lng: livePos.lng },
                destination: { lat: incomingMission.lat, lng: incomingMission.lng },
                fallbackPath: previewRoute?.path,
                travelMode: 'rescue_truck',
                strokeColor: '#1A73E8',
                preserveViewport: true,
              }
            : null
        }
        className="!h-full !w-full !rounded-none !border-0"
        ariaLabel="Bản đồ trực chiến nhận đơn ứng cứu khẩn cấp"
      />

      {/* 1. THANH TRẠNG THÁI TRỰC CHIẾN TRÊN CÙNG (FLOATING DUTY BAR) */}
      <header className="pointer-events-none absolute inset-x-3 top-3 z-[45] mx-auto flex max-w-3xl items-center justify-between gap-2">
        {/* Khối thông tin đội cứu hộ bên trái */}
        <div className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-2xl border border-slate-800/95 bg-slate-900/95 px-3 py-2 shadow-2xl backdrop-blur-md">
          <Link to="/" aria-label="Về trang chủ" className="shrink-0">
            <Logo dark />
          </Link>
          <div className="hidden min-w-0 border-l border-slate-700 pl-2.5 sm:block">
            <p className="truncate text-xs font-extrabold text-white">{me?.name}</p>
            <p className="mono truncate text-[10px] font-bold text-cyan-300">
              {me?.staffCode ?? me?.unitCode ?? 'RESCUE'}
            </p>
          </div>
        </div>

        {/* Nút gạt Trực tuyến / Nghỉ ca (Grab Driver Style) */}
        <button
          type="button"
          role="switch"
          aria-checked={isOnline}
          onClick={toggleDutyOnline}
          className={`pointer-events-auto inline-flex min-h-11 items-center gap-2 rounded-full border px-4 py-2 text-xs font-extrabold shadow-2xl transition-all active:scale-95 sm:text-sm ${
            isOnline
              ? 'border-emerald-400/70 bg-[#00B14F] text-white shadow-[0_6px_24px_rgba(0,177,79,0.45)]'
              : 'border-slate-700 bg-slate-800/95 text-slate-300'
          }`}
        >
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              isOnline ? 'animate-pulse bg-white' : 'bg-slate-500'
            }`}
          />
          <Power className="h-4 w-4 shrink-0" aria-hidden />
          <span>{isOnline ? 'Đang trực chiến' : 'Tạm nghỉ'}</span>
        </button>

        {/* Cụm nút phụ góc phải (IOC nếu có quyền + Làm mới + Đăng xuất) */}
        <div className="pointer-events-auto flex items-center gap-1.5 rounded-2xl border border-slate-800/95 bg-slate-900/95 p-1.5 shadow-2xl backdrop-blur-md">
          {me && (normalizeRole(me.role) === 'admin' || normalizeRole(me.role) === 'officer') && (
            <Link
              to={normalizeRole(me.role) === 'admin' ? '/admin' : '/ioc'}
              className="inline-flex h-9 items-center rounded-xl border border-slate-700 bg-slate-800 px-2.5 text-xs font-extrabold text-cyan-300 hover:border-cyan-400"
            >
              IOC
            </Link>
          )}
          <button
            type="button"
            onClick={() => void fetchMissions(false)}
            disabled={refreshing}
            className="grid h-9 w-9 place-items-center rounded-xl border border-slate-700 bg-slate-800 text-slate-200 hover:border-[#1A73E8]"
            title="Làm mới danh sách sự cố"
            aria-label="Làm mới danh sách sự cố"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={() => void authStore.signOut().then(() => nav('/auth'))}
            className="grid h-9 w-9 place-items-center rounded-xl border border-slate-700 bg-slate-800 text-slate-300 hover:text-rose-300"
            title="Đăng xuất"
            aria-label="Đăng xuất"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* Nút nổi "Định vị lại" bên góc phải */}
      {!standbyAutoFollow && (
        <div
          className={`pointer-events-none absolute right-3 z-[44] ${
            incomingMission ? 'bottom-[24.5rem] sm:bottom-[23rem]' : 'bottom-40'
          }`}
        >
          <button
            type="button"
            onClick={() => {
              setStandbyAutoFollow(true);
              void refreshNow();
              issueStandbyCamera({ kind: 'flyTo', lat: livePos.lat, lng: livePos.lng, zoom: 15.8 });
            }}
            className="pointer-events-auto inline-flex min-h-11 items-center gap-1.5 rounded-full border-2 border-[#1A73E8] bg-white px-3.5 py-2 text-xs font-extrabold text-[#1A73E8] shadow-xl transition-transform active:scale-95"
          >
            <Navigation2 className="h-4 w-4 fill-current" aria-hidden />
            Định vị lại
          </button>
        </div>
      )}

      {/* 2. NÚT MỞ DANH SÁCH "TẤT CẢ ĐƠN QUANH ĐÂY (N)" + THẺ NHẬN ĐƠN NỔI PHÍA DƯỚI */}
      <div className="pointer-events-none absolute inset-x-3 bottom-3 z-[45] mx-auto flex max-w-xl flex-col gap-2 safe-b">
        {/* Nút mở Drawer danh sách tất cả đơn quanh đây */}
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="pointer-events-auto inline-flex min-h-10 items-center gap-2 rounded-full border border-slate-700 bg-slate-900/95 px-4 py-2 text-xs font-extrabold text-white shadow-xl backdrop-blur-md transition-transform active:scale-95 hover:border-[#1A73E8]"
          >
            <ListFilter className="h-4 w-4 text-[#60A5FA]" aria-hidden />
            <span>Tất cả đơn quanh đây ({availableMissions.length})</span>
          </button>

          {skippedIds.length > 0 && isOnline && availableMissions.length > 0 && (
            <button
              type="button"
              onClick={() => setSkippedIds([])}
              className="pointer-events-auto inline-flex min-h-10 items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900/95 px-3.5 py-2 text-xs font-bold text-cyan-300 shadow-xl backdrop-blur-md hover:border-cyan-400"
            >
              Xem lại đơn đã bỏ qua ({skippedIds.length})
            </button>
          )}
        </div>

        {/* THẺ NHẬN ĐƠN NỔI (INCOMING MISSION POPUP / CARD — GRAB DRIVER STYLE) */}
        {!isOnline ? (
          <div className="pointer-events-auto rounded-3xl border border-slate-800 bg-slate-900/98 p-4 shadow-2xl backdrop-blur-xl">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-extrabold text-white">Đội của bạn đang tạm nghỉ ca</p>
                <p className="mt-0.5 text-xs text-slate-400">
                  Bật trực chiến để tự động nhận các lệnh ứng cứu khẩn cấp gần vị trí của bạn.
                </p>
              </div>
              <button
                type="button"
                onClick={toggleDutyOnline}
                className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-2xl bg-[#00B14F] px-4 text-xs font-extrabold text-white shadow-lg hover:bg-[#009944]"
              >
                <Power className="h-4 w-4" aria-hidden />
                Bật trực chiến ngay
              </button>
            </div>
          </div>
        ) : incomingMission && badgeMeta ? (
          <section
            aria-label="Đơn sự cố gần nhất đang chờ tiếp nhận"
            className={`pointer-events-auto rounded-3xl border bg-slate-900/98 p-4 shadow-[0_16px_48px_rgba(0,0,0,0.65)] backdrop-blur-xl ${
              badgeMeta.isUrgent ? 'border-rose-500/70 ring-1 ring-rose-500/40' : 'border-slate-700/95'
            }`}
          >
            {/* Hàng trên: Badge khẩn cấp + Loại sự cố + Mã đơn */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span
                  className={`inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] font-extrabold uppercase tracking-wider ${badgeMeta.className}`}
                >
                  {badgeMeta.isUrgent && <Siren className="h-3.5 w-3.5 animate-pulse" aria-hidden />}
                  {badgeMeta.label}
                </span>
                <span className="truncate rounded-lg bg-slate-800 px-2 py-0.5 text-[11px] font-bold text-cyan-300">
                  {t(CATEGORY_META[incomingMission.category].labelKey)}
                </span>
              </div>
              <span className="mono shrink-0 text-[11px] font-bold text-slate-400">
                {incomingMission.code}
              </span>
            </div>

            {/* Hàng giữa: Khoảng cách + Thời gian chạy xe + Địa chỉ cụ thể + Ảnh thu nhỏ */}
            <div className="mt-2.5 flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                  <span className="mono text-xl font-extrabold text-white sm:text-2xl">
                    {displayDistKm !== null ? `${String(displayDistKm).replace('.', ',')} km` : 'Gần bạn'}
                  </span>
                  {displayEtaMin !== null && (
                    <span className="inline-flex items-center gap-1 font-extrabold text-[#34D399] sm:text-lg">
                      <Clock className="h-4 w-4" aria-hidden />
                      <span className="mono">{displayEtaMin} phút</span>
                    </span>
                  )}
                </div>

                <h2 className="mt-1 line-clamp-1 break-words text-sm font-extrabold leading-snug text-slate-100">
                  {incomingMission.title}
                </h2>
                <p className="mt-0.5 line-clamp-2 break-words text-xs font-medium leading-snug text-slate-300">
                  <MapPin className="mr-1 inline h-3.5 w-3.5 text-rose-400" aria-hidden />
                  {incomingMission.address || `${incomingWard?.name ?? incomingMission.wardCode}, TP. Đồng Nai`}
                </p>
              </div>

              {incomingMission.photos[0] && (
                <img
                  src={incomingMission.photos[0].url}
                  alt={incomingMission.title}
                  className="h-16 w-16 shrink-0 rounded-2xl border border-slate-700 object-cover sm:h-20 sm:w-20"
                />
              )}
            </div>

            {/* Hàng nút hành động: Bỏ qua + NHẬN ĐƠN NGAY */}
            <div className="mt-3.5 flex items-center gap-2.5">
              <button
                type="button"
                disabled={acceptingId !== null}
                onClick={() => handleSkipIncoming(incomingMission.id)}
                className="inline-flex min-h-12 items-center justify-center gap-1.5 rounded-2xl border border-slate-700 bg-slate-800 px-4 text-xs font-extrabold text-slate-300 transition-transform active:scale-95 hover:border-slate-500 hover:text-white disabled:opacity-40"
              >
                <SkipForward className="h-4 w-4" aria-hidden />
                Bỏ qua
              </button>

              <button
                type="button"
                disabled={acceptingId !== null}
                onClick={() => void handleAcceptMission(incomingMission)}
                className={`inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-2xl px-5 text-sm font-extrabold uppercase tracking-wide text-white shadow-xl transition-transform active:scale-[0.98] disabled:opacity-50 sm:text-base ${
                  badgeMeta.isUrgent
                    ? 'bg-rose-600 shadow-[0_8px_24px_rgba(225,29,72,0.45)] hover:bg-rose-500'
                    : 'bg-[#00B14F] shadow-[0_8px_24px_rgba(0,177,79,0.45)] hover:bg-[#009944]'
                }`}
              >
                {acceptingId === incomingMission.id ? (
                  <Spinner className="h-5 w-5" />
                ) : (
                  <CheckCircle2 className="h-5 w-5" aria-hidden />
                )}
                NHẬN ĐƠN NGAY
              </button>
            </div>
          </section>
        ) : (
          <div className="pointer-events-auto rounded-3xl border border-slate-800 bg-slate-900/95 p-4 text-center shadow-2xl backdrop-blur-xl">
            <p className="flex items-center justify-center gap-2 text-sm font-extrabold text-emerald-300">
              <span className="h-2.5 w-2.5 animate-ping rounded-full bg-emerald-400" />
              Đang trực canh tín hiệu sự cố quanh khu vực của bạn…
            </p>
            <p className="mt-1 text-xs text-slate-400">
              {availableMissions.length > 0
                ? 'Bạn đã tạm bỏ qua các đơn hiện tại. Bấm "Xem lại" phía trên nếu muốn nhận đơn.'
                : 'Hệ thống tự động cập nhật mỗi 5 giây và báo chuông ngay khi có đơn SOS mới.'}
            </p>
          </div>
        )}
      </div>

      {/* 3. DRAWER TRƯỢT LÊN: "TẤT CẢ ĐƠN QUANH ĐÂY (N)" */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/70 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Danh sách tất cả đơn sự cố quanh đây"
        >
          <button
            type="button"
            className="flex-1 cursor-default"
            aria-label="Đóng danh sách đơn"
            onClick={() => setDrawerOpen(false)}
          />

          <div className="mx-auto flex max-h-[82dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl border-t border-slate-700 bg-slate-900 shadow-2xl">
            <div className="border-b border-slate-800 px-4 pt-3.5 pb-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-base font-extrabold text-white">
                    Tất cả đơn quanh đây ({availableMissions.length})
                  </h2>
                  <p className="text-xs text-slate-400">
                    Sắp xếp theo mức độ khẩn cấp và khoảng cách gần nhất tới vị trí xe
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  className="grid h-10 w-10 place-items-center rounded-xl border border-slate-700 bg-slate-800 text-slate-300 hover:text-white"
                  aria-label="Đóng ngăn kéo"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="mt-3 flex items-center gap-2">
                <div className="relative flex-1">
                  <Search
                    className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400"
                    aria-hidden
                  />
                  <input
                    value={queryText}
                    onChange={(e) => setQueryText(e.target.value)}
                    placeholder="Tìm tên đường, phường/xã, mã đơn…"
                    className="min-h-10 w-full rounded-xl border border-slate-700 bg-slate-950 pl-9 pr-3 text-xs text-white placeholder:text-slate-500 focus:border-[#1A73E8] focus:outline-none"
                  />
                </div>
              </div>

              <div className="mt-2.5 grid grid-cols-3 gap-1 rounded-xl border border-slate-800 bg-slate-950 p-1 text-xs font-extrabold">
                {(
                  [
                    ['available', `Chờ nhận (${availableMissions.length})`],
                    [
                      'sos',
                      `Khẩn cấp (${availableMissions.filter((m) => m.severityLabel === 'CRITICAL' || m.isEmergency || m.emergencyLevel === 1).length})`,
                    ],
                    ['resolved', `Đã hoàn thành (${resolvedMissions.length})`],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setDrawerTab(id)}
                    className={`min-h-9 rounded-lg px-2 transition-colors ${
                      drawerTab === id ? 'bg-[#1A73E8] text-white' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 space-y-2.5 overflow-y-auto p-4 safe-b">
              {filteredDrawerList.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-2xl border border-slate-800 bg-slate-950/70 p-8 text-center text-xs text-slate-400">
                  <ShieldAlert className="h-8 w-8 text-slate-500" aria-hidden />
                  <p>Không có đơn sự cố nào khớp bộ lọc hiện tại.</p>
                </div>
              ) : (
                filteredDrawerList.map((m) => {
                  const uBadge = getUrgencyBadge(m);
                  const w = WARD_BY_CODE[m.wardCode];
                  const isDone = m.status === 'resolved';
                  return (
                    <div
                      key={m.id}
                      className={`rounded-2xl border p-3.5 transition-colors ${
                        uBadge.isUrgent && !isDone
                          ? 'border-rose-500/50 bg-rose-950/15'
                          : 'border-slate-800 bg-slate-950/90'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span
                              className={`rounded-md px-2 py-0.5 text-[10px] font-extrabold uppercase ${
                                isDone ? 'bg-emerald-600/25 text-emerald-300' : uBadge.className
                              }`}
                            >
                              {isDone ? 'ĐÃ HOÀN THÀNH' : uBadge.label}
                            </span>
                            <span className="rounded-md bg-slate-800 px-2 py-0.5 text-[10px] font-bold text-cyan-300">
                              {t(CATEGORY_META[m.category].labelKey)}
                            </span>
                            {m.distanceKm !== null && (
                              <span className="mono text-xs font-extrabold text-[#34D399]">
                                {String(m.distanceKm).replace('.', ',')} km
                                {m.etaMinutes !== null ? ` · ${m.etaMinutes} phút` : ''}
                              </span>
                            )}
                          </div>

                          <h3 className="mt-1.5 break-words text-sm font-extrabold leading-snug text-white">
                            {m.title}
                          </h3>
                          <p className="mt-1 break-words text-xs text-slate-400">
                            <MapPin className="mr-1 inline h-3.5 w-3.5 text-rose-400" aria-hidden />
                            {m.address || `${w?.name ?? m.wardCode}, TP. Đồng Nai`}
                          </p>
                        </div>

                        {m.photos[0] && (
                          <img
                            src={m.photos[0].url}
                            alt={m.title}
                            className="h-16 w-16 shrink-0 rounded-xl border border-slate-800 object-cover"
                          />
                        )}
                      </div>

                      {!isDone && (
                        <div className="mt-3 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleFocusMissionFromMapOrDrawer(m)}
                            className="inline-flex min-h-10 items-center justify-center rounded-xl border border-slate-700 bg-slate-800 px-3 text-xs font-bold text-slate-200 hover:border-[#1A73E8]"
                          >
                            Xem trên bản đồ
                          </button>
                          <button
                            type="button"
                            disabled={acceptingId !== null}
                            onClick={() => void handleAcceptMission(m)}
                            className="inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#00B14F] px-4 text-xs font-extrabold uppercase text-white shadow hover:bg-[#009944] disabled:opacity-50"
                          >
                            {acceptingId === m.id ? <Spinner className="h-4 w-4" /> : null}
                            NHẬN ĐƠN NGAY
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
