import {
  AlertTriangle,
  Bike,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  ExternalLink,
  Footprints,
  ListFilter,
  MapPin,
  Navigation2,
  Phone,
  RotateCcw,
  Truck,
  Volume2,
  VolumeX,
  Wrench,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { haversineMeters } from '@shared/geo';
import type { ClientReport, RescueMissionItem, RescueStageCode } from '@shared/types';
import { WARD_BY_CODE } from '../../data/dongNaiWards';
import { db } from '../../db/localDb';
import type { LiveNavPosition } from '../../hooks/useLiveNavigationGps';
import { useI18n } from '../../i18n';
import { api, apiMultipart, ApiError } from '../../lib/api';
import { edge } from '../../lib/edgeClient';
import type { EdgeStatsMsg } from '../../lib/imageProcessor';
import { googleMapsDirectionsUrl } from '../../lib/mapConfig';
import { CATEGORY_META } from '../../lib/meta';
import {
  computeActiveStepProgress,
  computeNavigationRoute,
  formatArrivalClock,
  formatDistanceVi,
  type NavigationRoute,
  type TravelVehicleMode,
} from '../../lib/navigationEngine';
import { playMissionSuccessChime } from '../../lib/rescueChime';
import { speak, speechSynthesisSupported, stopSpeaking } from '../../lib/speech';
import { useToast } from '../../state/toast';
import type { CameraCommand } from '../map/GoogleMapEngine';
import { UnifiedMapCanvas } from '../map/UnifiedMapCanvas';
import { TacticalBriefingCard } from '../TacticalBriefingCard';
import { BeforeAfterSlider, SlaClock } from '../Timeline';
import { Spinner } from '../ui';
import { ManeuverIcon } from './ManeuverIcon';

export interface TacticalNavigationWorkspaceProps {
  mission: RescueMissionItem | ClientReport;
  allMarkers?: ClientReport[];
  livePos: LiveNavPosition;
  onRefreshGps: () => void;
  onSelectMarker?: (m: ClientReport) => void;
  onMissionUpdated: (updated: RescueMissionItem) => void;
  /** Khi đơn hoàn thành hoặc trả lại hàng chờ thành công -> quay về màn hình chờ đơn mới */
  onMissionClosed?: (reason: 'resolved' | 'released', updated: RescueMissionItem) => void;
  /** Bật chế độ tài xế đang thực hiện đơn nhận (đồng bộ tọa độ ngầm & hiện nút 1 chạm từng chặng) */
  isActiveDriverTrip?: boolean;
  onToggleMissionDrawer?: () => void;
  missionCountBadge?: number;
  desktopLeftInset?: boolean;
  /** Khi mở dưới dạng Modal toàn màn hình từ giao diện Cán bộ IOC */
  onCloseModal?: () => void;
  headerSlot?: ReactNode;
}

const VEHICLE_MODES: ReadonlyArray<{
  id: TravelVehicleMode;
  label: string;
  gmapsMode: 'driving' | 'two-wheeler' | 'walking';
  Icon: typeof Truck;
}> = [
  { id: 'rescue_truck', label: 'Xe cứu hộ', gmapsMode: 'driving', Icon: Truck },
  { id: 'motorcycle', label: 'Xe máy', gmapsMode: 'two-wheeler', Icon: Bike },
  { id: 'walking', label: 'Đi bộ', gmapsMode: 'walking', Icon: Footprints },
];

function resolveStageCode(mission: ClientReport): RescueStageCode {
  if (mission.status === 'resolved' || mission.rescueStatus === 'RESOLVED' || mission.rescueMission?.status === 'completed') {
    return 'RESOLVED';
  }
  if (mission.rescueStatus === 'IN_PROGRESS' || mission.rescueMission?.status === 'in_progress') {
    return 'IN_PROGRESS';
  }
  if (
    mission.rescueStatus === 'ARRIVED' ||
    mission.rescueMission?.status === 'arrived' ||
    mission.rescueMission?.status === 'on_site'
  ) {
    return 'ARRIVED';
  }
  if (
    mission.rescueStatus === 'EN_ROUTE' ||
    mission.rescueMission?.status === 'en_route' ||
    mission.rescueMission?.status === 'accepted' ||
    Boolean(mission.assignedRescueId || mission.rescueMission?.assignedTeamId)
  ) {
    return 'EN_ROUTE';
  }
  return 'PENDING';
}

const STAGE_BADGE: Record<RescueStageCode, { label: string; className: string }> = {
  PENDING: { label: 'Chờ tiếp nhận', className: 'bg-slate-700/80 text-slate-200 border-slate-600' },
  VERIFIED: { label: 'Đã xác minh', className: 'bg-sky-500/20 text-sky-300 border-sky-400/40' },
  DISPATCHED: { label: 'Đã phát lệnh', className: 'bg-rose-500/20 text-rose-300 border-rose-400/40' },
  EN_ROUTE: { label: 'Đang di chuyển tới hiện trường', className: 'bg-[#1A73E8]/25 text-[#93C5FD] border-[#1A73E8]/50' },
  ARRIVED: { label: 'Đã tới hiện trường', className: 'bg-amber-500/20 text-amber-300 border-amber-400/50' },
  IN_PROGRESS: { label: 'Đang xử lý sự cố', className: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/50' },
  RESOLVED: { label: 'Đã hoàn thành', className: 'bg-emerald-600/25 text-emerald-200 border-emerald-400/60' },
};

export function TacticalNavigationWorkspace({
  mission,
  allMarkers,
  livePos,
  onRefreshGps,
  onSelectMarker,
  onMissionUpdated,
  onMissionClosed,
  isActiveDriverTrip = false,
  onToggleMissionDrawer,
  missionCountBadge,
  desktopLeftInset = false,
  onCloseModal,
  headerSlot,
}: TacticalNavigationWorkspaceProps) {
  const { t } = useI18n();
  const toast = useToast();

  const [vehicleMode, setVehicleMode] = useState<TravelVehicleMode>('rescue_truck');
  const [route, setRoute] = useState<NavigationRoute | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [autoFollow, setAutoFollow] = useState(true);
  const [cameraCmd, setCameraCmd] = useState<CameraCommand | null>(null);
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const [completionOpen, setCompletionOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [releaseReason, setReleaseReason] = useState('');
  const [voiceEnabled, setVoiceEnabled] = useState(false);

  // Đo kích thước thực tế của Top Banner & Bottom Sheet để camera luôn giữ xe ở giữa khoảng trống bản đồ
  const topBannerRef = useRef<HTMLDivElement | null>(null);
  const bottomSheetRef = useRef<HTMLElement | null>(null);
  const [topInsetPx, setTopInsetPx] = useState(108);
  const [bottomInsetPx, setBottomInsetPx] = useState(236);

  // Nghiệm thu & cập nhật trạng thái tác chiến
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [afterPhoto, setAfterPhoto] = useState<{
    previewUrl: string;
    displayBlob: Blob;
    aiBlob: Blob;
    dHash: string;
    stats: EdgeStatsMsg;
  } | null>(null);
  const [completeNote, setCompleteNote] = useState('');
  const [overrideAi, setOverrideAi] = useState(false);
  const [verifyFeedback, setVerifyFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (afterPhoto?.previewUrl.startsWith('blob:')) URL.revokeObjectURL(afterPhoto.previewUrl);
    };
  }, [afterPhoto]);

  const dragStartYRef = useRef<number | null>(null);
  const lastSpokenKeyRef = useRef<string>('');
  const lastRouteMetaRef = useRef<{
    missionId: string;
    mode: TravelVehicleMode;
    at: number;
    originLat: number;
    originLng: number;
  } | null>(null);
  const lastReportedLocRef = useRef<{ lat: number; lng: number; at: number } | null>(null);

  const issueCamera = useCallback((cmd: Omit<CameraCommand, 'seq'>) => {
    setCameraCmd((prev) => ({ ...cmd, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

  // Đo chiều cao động của Top Banner và Bottom Sheet bằng ResizeObserver
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = Math.round(entry.target.getBoundingClientRect().height);
        if (entry.target === topBannerRef.current && h > 0) setTopInsetPx(h + 16);
        if (entry.target === bottomSheetRef.current && h > 0) setBottomInsetPx(h + 12);
      }
    });
    if (topBannerRef.current) ro.observe(topBannerRef.current);
    if (bottomSheetRef.current) ro.observe(bottomSheetRef.current);
    return () => ro.disconnect();
  }, [sheetExpanded, completionOpen, releaseOpen]);

  // Khởi tạo lại trạng thái dẫn đường khi chuyển sang đơn sự cố mới (bật sẵn Auto-Follow bám xe!)
  useEffect(() => {
    setAfterPhoto(null);
    setCompleteNote('');
    setOverrideAi(false);
    setVerifyFeedback(null);
    setCompletionOpen(false);
    setReleaseOpen(false);
    setReleaseReason('');
    setAutoFollow(true);
    lastSpokenKeyRef.current = '';
  }, [mission.id]);

  // Tính tiến độ chặng rẽ hiện tại + độ lệch off-route (mét) theo thời gian thực
  const progress = useMemo(
    () =>
      route
        ? computeActiveStepProgress(route, { lat: livePos.lat, lng: livePos.lng })
        : null,
    [route, livePos.lat, livePos.lng],
  );

  // Tính tuyến đường ban đầu + Tự động tính lại đường đi (Auto Re-route) khi xe đi lệch tuyến > 50m (cooldown >= 10s)
  useEffect(() => {
    const prev = lastRouteMetaRef.current;
    const now = Date.now();
    const missionOrModeChanged = !prev || prev.missionId !== mission.id || prev.mode !== vehicleMode;
    const initialGpsAcquired =
      prev &&
      !livePos.isFallback &&
      haversineMeters(prev.originLat, prev.originLng, livePos.lat, livePos.lng) > 120 &&
      !route;
    const deviatedOffRoute =
      Boolean(route && progress && progress.offRouteMeters > 50) &&
      (!prev || now - prev.at >= 10_000);

    if (!missionOrModeChanged && !initialGpsAcquired && !deviatedOffRoute) {
      return undefined;
    }

    lastRouteMetaRef.current = {
      missionId: mission.id,
      mode: vehicleMode,
      at: now,
      originLat: livePos.lat,
      originLng: livePos.lng,
    };

    const ctrl = new AbortController();
    setRouteLoading(true);
    void computeNavigationRoute(
      { lat: livePos.lat, lng: livePos.lng },
      { lat: mission.lat, lng: mission.lng },
      vehicleMode,
      ctrl.signal,
    )
      .then((r) => {
        if (!ctrl.signal.aborted) setRoute(r);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setRouteLoading(false);
      });

    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mission.id, mission.lat, mission.lng, vehicleMode, livePos.lat, livePos.lng, livePos.isFallback, progress?.offRouteMeters]);

  const stageCode = resolveStageCode(mission);
  const isResolved = stageCode === 'RESOLVED';

  // Đồng bộ tọa độ di chuyển thực tế lên Server (`PATCH /api/rescue/missions/:id/location`) để Cán bộ & Người dân xem ETA
  useEffect(() => {
    if (!isActiveDriverTrip || isResolved) return undefined;
    const now = Date.now();
    const prev = lastReportedLocRef.current;
    const movedEnough =
      !prev ||
      now - prev.at >= 12_000 ||
      (now - prev.at >= 5_000 && haversineMeters(prev.lat, prev.lng, livePos.lat, livePos.lng) >= 12);

    if (!movedEnough) return undefined;
    lastReportedLocRef.current = { lat: livePos.lat, lng: livePos.lng, at: now };

    const ctrl = new AbortController();
    void api(`/api/rescue/missions/${mission.id}/location`, {
      method: 'PATCH',
      body: {
        lat: livePos.lat,
        lng: livePos.lng,
        heading: livePos.heading ?? progress?.suggestedBearingDeg ?? null,
        speed: livePos.speedKmh ?? null,
      },
      signal: ctrl.signal,
      timeoutMs: 8000,
    }).catch(() => undefined);

    return () => ctrl.abort();
  }, [
    isActiveDriverTrip,
    isResolved,
    mission.id,
    livePos.lat,
    livePos.lng,
    livePos.heading,
    livePos.speedKmh,
    progress?.suggestedBearingDeg,
  ]);

  // Đọc hướng dẫn giọng nói tiếng Việt (Web Speech API vi-VN) mỗi khi sang bước rẽ mới
  useEffect(() => {
    if (!voiceEnabled || !progress || !speechSynthesisSupported()) return;
    const stepKey = `${mission.id}:${progress.activeStepIndex}:${progress.currentStep.instructionVi}`;
    if (lastSpokenKeyRef.current === stepKey) return;
    lastSpokenKeyRef.current = stepKey;

    const distPhrase =
      progress.currentStep.maneuver === 'arrive'
        ? progress.currentStep.instructionVi
        : `Sau ${formatDistanceVi(progress.distanceToTurnM)}, ${progress.currentStep.instructionVi}`;
    speak(distPhrase, 'vi');
  }, [voiceEnabled, progress, mission.id]);

  useEffect(() => {
    return () => stopSpeaking();
  }, []);

  const toggleVoice = (): void => {
    if (!speechSynthesisSupported()) {
      toast('info', 'Trình duyệt hiện tại không hỗ trợ giọng đọc tiếng Việt.');
      return;
    }
    const next = !voiceEnabled;
    setVoiceEnabled(next);
    if (!next) {
      stopSpeaking();
    } else if (progress) {
      const distPhrase =
        progress.currentStep.maneuver === 'arrive'
          ? progress.currentStep.instructionVi
          : `Bắt đầu dẫn đường. Sau ${formatDistanceVi(progress.distanceToTurnM)}, ${progress.currentStep.instructionVi}`;
      lastSpokenKeyRef.current = `${mission.id}:${progress.activeStepIndex}:${progress.currentStep.instructionVi}`;
      speak(distPhrase, 'vi');
    }
  };

  const handleRecenter = (): void => {
    setAutoFollow(true);
    onRefreshGps();
    issueCamera({
      kind: 'flyTo',
      lat: livePos.lat,
      lng: livePos.lng,
      zoom: 16.2,
    });
  };

  const advanceStage = async (nextStage: 'EN_ROUTE' | 'ARRIVED' | 'IN_PROGRESS'): Promise<void> => {
    setActionBusy(nextStage);
    try {
      const updated = await api<RescueMissionItem>(`/api/rescue/missions/${mission.id}/status`, {
        method: 'PATCH',
        body: {
          status: nextStage,
          note: '',
          lat: livePos.lat,
          lng: livePos.lng,
        },
      });
      await db.reports.put({ ...updated, syncState: 'synced' }).catch(() => undefined);
      onMissionUpdated(updated);
      playMissionSuccessChime();

      const msgMap: Record<typeof nextStage, string> = {
        EN_ROUTE: 'Đang di chuyển tới hiện trường sự cố',
        ARRIVED: 'Đã xác nhận có mặt tại hiện trường',
        IN_PROGRESS: 'Bắt đầu triển khai xử lý sự cố hiện trường',
      };
      toast('success', msgMap[nextStage], updated.code);
    } catch (e) {
      toast('error', 'Không cập nhật được trạng thái nhiệm vụ', e instanceof ApiError ? e.message : undefined);
    } finally {
      setActionBusy(null);
    }
  };

  const handlePickAfterPhoto = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setActionBusy('photo');
    setCompletionOpen(true);
    try {
      const p = await edge.processImage(file);
      setAfterPhoto({
        previewUrl: p.previewUrl,
        displayBlob: p.displayBlob,
        aiBlob: p.aiBlob,
        dHash: p.dHash,
        stats: p.stats,
      });
      setVerifyFeedback(null);
    } catch (e) {
      toast('error', 'Không xử lý được ảnh nghiệm thu', e instanceof Error ? e.message : undefined);
    } finally {
      setActionBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const submitCompletion = async (): Promise<void> => {
    if (!afterPhoto) {
      fileInputRef.current?.click();
      return;
    }
    setActionBusy('complete');
    try {
      const fd = new FormData();
      fd.append('displayImage', afterPhoto.displayBlob, 'display.webp');
      fd.append('aiImage', afterPhoto.aiBlob, 'ai.webp');
      fd.append(
        'metadata',
        JSON.stringify({
          dHash: afterPhoto.dHash,
          note: completeNote.trim(),
          override: overrideAi,
          edge: afterPhoto.stats,
          lat: livePos.lat,
          lng: livePos.lng,
        }),
      );
      const res = await apiMultipart<{ report: RescueMissionItem; accepted: boolean }>(
        `/api/rescue/missions/${mission.id}/complete`,
        {
          method: 'POST',
          body: fd,
          timeoutMs: 30000,
        },
      );
      await db.reports.put({ ...res.report, syncState: 'synced' }).catch(() => undefined);
      onMissionUpdated(res.report);
      if (res.accepted) {
        playMissionSuccessChime();
        toast('success', 'Đã hoàn thành đơn cứu hộ & nghiệm thu thành công!', res.report.code);
        setAfterPhoto(null);
        setCompleteNote('');
        setVerifyFeedback(null);
        setCompletionOpen(false);
        onMissionClosed?.('resolved', res.report);
      } else {
        setVerifyFeedback({
          ok: false,
          text: res.report.resolution?.summary ?? 'AI chưa xác nhận hiện trường đã được khắc phục hoàn toàn.',
        });
      }
    } catch (e) {
      toast('error', 'Không gửi được biên bản hoàn thành', e instanceof ApiError ? e.message : undefined);
    } finally {
      setActionBusy(null);
    }
  };

  const submitReleaseMission = async (): Promise<void> => {
    const clean = releaseReason.trim();
    if (clean.length < 5) {
      toast('info', 'Vui lòng nhập lý do trả đơn (tối thiểu 5 ký tự).');
      return;
    }
    setActionBusy('release');
    try {
      const released = await api<RescueMissionItem>(`/api/rescue/missions/${mission.id}/release`, {
        method: 'POST',
        body: {
          reason: clean,
          lat: livePos.lat,
          lng: livePos.lng,
        },
      });
      await db.reports.put({ ...released, syncState: 'synced' }).catch(() => undefined);
      onMissionUpdated(released);
      toast('info', 'Đã trả đơn về hàng chờ điều phối', released.code);
      setReleaseOpen(false);
      setReleaseReason('');
      onMissionClosed?.('released', released);
    } catch (e) {
      toast('error', 'Không thể trả đơn về hàng chờ', e instanceof ApiError ? e.message : undefined);
    } finally {
      setActionBusy(null);
    }
  };

  const effectiveHeading = livePos.heading ?? progress?.suggestedBearingDeg ?? 0;
  const ward = WARD_BY_CODE[mission.wardCode];
  const etaMinutes = progress?.remainingDurationMin ?? route?.durationMin ?? ('etaMinutes' in mission && mission.etaMinutes ? mission.etaMinutes : 5);
  const distKm = progress?.remainingDistanceKm ?? route?.distanceKm ?? ('distanceKm' in mission && mission.distanceKm ? mission.distanceKm : 1.2);
  const activeVehicleMeta = VEHICLE_MODES.find((v) => v.id === vehicleMode) ?? VEHICLE_MODES[0];
  const stageMeta = STAGE_BADGE[stageCode];
  const reporterPhone = 'reporterPhone' in mission && mission.reporterPhone ? mission.reporterPhone : null;
  const callHref = `tel:${reporterPhone ?? '114'}`;
  const callLabel = reporterPhone ? 'Gọi người báo' : 'Gọi trực ban 114';

  const leftOffsetClass = desktopLeftInset ? 'lg:left-[23rem]' : 'lg:left-4';
  const activeRoutePath =
    progress?.aheadPath && progress.aheadPath.length >= 2 ? progress.aheadPath : route?.path;

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-slate-950 text-slate-100 select-none">
      {/* Input chụp/chọn ảnh nghiệm thu ẩn (luôn sẵn sàng cho nút 1 chạm Bước 3) */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => void handlePickAfterPhoto(e.target.files?.[0])}
      />

      {/* 1. BẢN ĐỒ DẪN ĐƯỜNG TOÀN MÀN HÌNH (100% VIEWPORT + 60FPS INTERPOLATION + AUTO-FOLLOW) */}
      <UnifiedMapCanvas
        reports={allMarkers && allMarkers.length > 0 ? allMarkers : [mission]}
        initialCenter={[livePos.lat, livePos.lng]}
        initialZoom={16}
        tone="ioc"
        cameraCommand={cameraCmd}
        onRequestCamera={issueCamera}
        userPos={{ lat: livePos.lat, lng: livePos.lng }}
        userHeadingDeg={effectiveHeading}
        navigationMode
        accuracyM={livePos.accuracy}
        activeDestinationId={mission.id}
        autoFollow={autoFollow}
        followPadding={{
          top: topInsetPx,
          bottom: bottomInsetPx,
          left: desktopLeftInset ? 360 : 0,
          right: 0,
        }}
        showArterials={false}
        onSelect={onSelectMarker}
        onUserPan={() => setAutoFollow(false)}
        showLayerSwitcher={false}
        showFallbackBadge={false}
        controlsBottomClassName={sheetExpanded || completionOpen ? 'bottom-[62dvh]' : 'bottom-64 sm:bottom-60'}
        routeOverlay={{
          origin: { lat: livePos.lat, lng: livePos.lng },
          destination: { lat: mission.lat, lng: mission.lng },
          fallbackPath: activeRoutePath,
          travelMode: vehicleMode,
          strokeColor: '#1A73E8',
          preserveViewport: true,
        }}
        className="!h-full !w-full !rounded-none !border-0"
        ariaLabel="Bản đồ dẫn đường trực tiếp tới hiện trường sự cố"
      />

      {headerSlot}

      {/* Nút nổi "Định vị lại" bên góc phải khi người dùng kéo/zoom bản đồ làm tắt Auto-Follow */}
      {!autoFollow && (
        <div
          className={`pointer-events-none absolute right-3 z-[46] transition-all duration-150 ${
            sheetExpanded || completionOpen ? 'bottom-[calc(62dvh+6.5rem)]' : 'bottom-[22.5rem] sm:bottom-[21rem]'
          }`}
        >
          <button
            type="button"
            onClick={handleRecenter}
            className="pointer-events-auto inline-flex min-h-11 items-center gap-2 rounded-full border-2 border-[#1A73E8] bg-white px-4 py-2 text-xs font-extrabold text-[#1A73E8] shadow-[0_8px_24px_rgba(0,0,0,0.45)] transition-transform active:scale-95"
          >
            <Navigation2 className="h-4 w-4 fill-current" aria-hidden />
            Định vị lại
          </button>
        </div>
      )}

      {/* 2. TOP NAVIGATION BANNER (MŨI TÊN RẼ LỚN + KHOẢNG CÁCH + TÊN ĐƯỜNG + GIỌNG ĐỌC TIẾNG VIỆT) */}
      <div
        ref={topBannerRef}
        className={`pointer-events-none absolute inset-x-3 top-3 z-[45] mx-auto max-w-2xl transition-all duration-200 ${leftOffsetClass} lg:right-4 lg:mx-0`}
      >
        <div className="pointer-events-auto overflow-hidden rounded-2xl border border-white/15 bg-[#00875A] text-white shadow-[0_12px_32px_rgba(0,0,0,0.5)]">
          <div className="flex items-center gap-3 px-3.5 py-3 sm:px-4 sm:py-3.5">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-black/20 sm:h-14 sm:w-14">
              {routeLoading && !progress ? (
                <Spinner className="h-6 w-6 text-white" />
              ) : (
                <ManeuverIcon
                  maneuver={progress?.currentStep.maneuver ?? 'straight'}
                  className="h-8 w-8 stroke-[2.6] text-white sm:h-9 sm:w-9"
                />
              )}
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="mono text-2xl font-extrabold leading-none tracking-tight sm:text-3xl">
                  {stageCode === 'ARRIVED' || stageCode === 'IN_PROGRESS'
                    ? 'Tại hiện trường'
                    : progress
                      ? progress.currentStep.maneuver === 'arrive'
                        ? 'Đích đến'
                        : formatDistanceVi(progress.distanceToTurnM)
                      : 'Đang tính…'}
                </span>
                {livePos.speedKmh !== null && livePos.speedKmh > 0 && (
                  <span className="mono rounded-md bg-black/25 px-1.5 py-0.5 text-[11px] font-bold">
                    {livePos.speedKmh} km/h
                  </span>
                )}
              </div>
              <p className="mt-1 line-clamp-2 break-words text-sm font-extrabold leading-snug text-white sm:text-base">
                {stageCode === 'IN_PROGRESS'
                  ? `Đang xử lý tại ${mission.address || mission.title}`
                  : stageCode === 'ARRIVED'
                    ? `Đã tới ${mission.address || mission.title}`
                    : (progress?.currentStep.instructionVi ?? `Đi tới ${mission.address || mission.title}`)}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={toggleVoice}
                aria-pressed={voiceEnabled}
                className={`grid h-11 w-11 place-items-center rounded-xl border transition-colors ${
                  voiceEnabled
                    ? 'border-white bg-white text-[#00875A]'
                    : 'border-white/25 bg-black/20 text-white hover:bg-black/30'
                }`}
                title={voiceEnabled ? 'Tắt giọng đọc chỉ đường tiếng Việt' : 'Bật giọng đọc chỉ đường tiếng Việt (vi-VN)'}
                aria-label="Giọng đọc chỉ đường tiếng Việt"
              >
                {voiceEnabled ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
              </button>

              {onToggleMissionDrawer && (
                <button
                  type="button"
                  onClick={onToggleMissionDrawer}
                  className="relative grid h-11 w-11 place-items-center rounded-xl border border-white/25 bg-black/20 text-white hover:bg-black/30 lg:hidden"
                  title="Danh sách đơn quanh đây"
                  aria-label="Mở danh sách đơn quanh đây"
                >
                  <ListFilter className="h-5 w-5" />
                  {typeof missionCountBadge === 'number' && missionCountBadge > 0 && (
                    <span className="mono absolute -right-1 -top-1 rounded-full bg-rose-600 px-1.5 text-[10px] font-extrabold text-white">
                      {missionCountBadge}
                    </span>
                  )}
                </button>
              )}

              {onCloseModal && (
                <button
                  type="button"
                  onClick={onCloseModal}
                  className="grid h-11 w-11 place-items-center rounded-xl border border-white/25 bg-black/25 text-white hover:bg-black/40"
                  title="Đóng chế độ dẫn đường"
                  aria-label="Đóng chế độ dẫn đường"
                >
                  <X className="h-5 w-5" />
                </button>
              )}
            </div>
          </div>

          {stageCode === 'EN_ROUTE' && progress?.nextStep && (
            <div className="flex items-center gap-2 bg-[#006644] px-4 py-1.5 text-xs font-bold text-emerald-50">
              <span className="uppercase tracking-wider opacity-85">Tiếp theo:</span>
              <ManeuverIcon maneuver={progress.nextStep.maneuver} className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {progress.nextStep.instructionVi}
                {progress.nextStep.distanceM > 0 ? ` (${formatDistanceVi(progress.nextStep.distanceM)})` : ''}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* 3. ACTIVE TRIP BOTTOM ACTION SHEET (1 CHẠM THEO TỪNG BƯỚC TÁC CHIẾN CHUẨN ỨNG DỤNG ĐẶT XE) */}
      <section
        ref={bottomSheetRef}
        aria-label="Bảng tác chiến nhiệm vụ cứu hộ đang thực hiện"
        className={`absolute inset-x-0 bottom-0 z-[45] mx-auto flex max-w-2xl flex-col rounded-t-3xl border-t border-slate-700/90 bg-slate-900/98 shadow-[0_-14px_40px_rgba(0,0,0,0.6)] backdrop-blur-xl transition-all duration-200 ease-out ${leftOffsetClass} lg:right-4 lg:mx-0 ${
          sheetExpanded || completionOpen || releaseOpen ? 'max-h-[82dvh]' : 'max-h-[21.5rem]'
        }`}
      >
        {/* Thanh kéo mở rộng / thu gọn */}
        <div
          role="button"
          tabIndex={0}
          aria-expanded={sheetExpanded}
          aria-label={sheetExpanded ? 'Thu gọn thông tin chuyến cứu hộ' : 'Mở rộng chi tiết chuyến cứu hộ'}
          onClick={() => setSheetExpanded((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setSheetExpanded((v) => !v);
            }
          }}
          onPointerDown={(e) => {
            dragStartYRef.current = e.clientY;
          }}
          onPointerUp={(e) => {
            if (dragStartYRef.current === null) return;
            const dy = e.clientY - dragStartYRef.current;
            dragStartYRef.current = null;
            if (dy < -28) setSheetExpanded(true);
            else if (dy > 28) setSheetExpanded(false);
          }}
          className="flex cursor-grab touch-none flex-col items-center pt-2 pb-1 active:cursor-grabbing"
        >
          <span className="h-1.5 w-12 rounded-full bg-slate-600" />
        </div>

        {/* Khối Tóm tắt Luôn Hiển thị: Trạng thái + ETA + Số km + Địa chỉ + Gọi người báo + Mở Google Maps + 1 Nút Hành Động Chính */}
        <div className="shrink-0 space-y-3 px-4 pb-4 safe-b">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-extrabold ${stageMeta.className}`}>
                  {stageMeta.label}
                </span>
                <span className="mono text-[11px] font-bold text-slate-400">{mission.code}</span>
              </div>

              <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                <span className="mono text-2xl font-extrabold text-[#34D399] sm:text-3xl">
                  {etaMinutes} phút
                </span>
                <span className="mono text-base font-bold text-white sm:text-lg">
                  · {String(distKm).replace('.', ',')} km
                </span>
                <span className="mono text-xs font-semibold text-slate-400">
                  (Dự kiến {formatArrivalClock(etaMinutes)})
                </span>
              </div>

              <p className="mt-1 line-clamp-1 break-words text-xs font-semibold text-slate-200 sm:text-sm">
                <MapPin className="mr-1 inline h-3.5 w-3.5 text-rose-400" aria-hidden />
                {mission.address || `${ward?.name ?? mission.wardCode}, TP. Đồng Nai`}
              </p>
            </div>

            {mission.photos[0] && (
              <img
                src={mission.photos[0].url}
                alt={mission.title}
                className="h-14 w-14 shrink-0 rounded-2xl border border-slate-700 object-cover sm:h-16 sm:w-16"
              />
            )}
          </div>

          {/* Hàng Nút Phụ: Gọi người báo (`tel:`), Mở Google Maps ngoài, Chi tiết */}
          <div className="grid grid-cols-3 gap-2">
            <a
              href={callHref}
              className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-2.5 text-xs font-extrabold text-emerald-300 transition-colors hover:bg-emerald-500/25"
            >
              <Phone className="h-4 w-4 shrink-0" aria-hidden />
              <span className="truncate">{callLabel}</span>
            </a>

            <a
              href={googleMapsDirectionsUrl(
                mission.lat,
                mission.lng,
                { lat: livePos.lat, lng: livePos.lng },
                activeVehicleMeta.gmapsMode,
              )}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-2.5 text-xs font-bold text-slate-100 transition-colors hover:border-[#1A73E8]"
            >
              <ExternalLink className="h-4 w-4 shrink-0 text-[#60A5FA]" aria-hidden />
              <span className="truncate">Google Maps</span>
            </a>

            <button
              type="button"
              onClick={() => setSheetExpanded((v) => !v)}
              className="inline-flex min-h-11 items-center justify-center gap-1 rounded-xl border border-slate-700 bg-slate-800 px-2.5 text-xs font-bold text-slate-200 transition-colors hover:border-slate-500"
            >
              <span className="truncate">{sheetExpanded ? 'Thu gọn' : 'Chi tiết đơn'}</span>
              {sheetExpanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronUp className="h-4 w-4 shrink-0" />}
            </button>
          </div>

          {/* 1 NÚT HÀNH ĐỘNG CHÍNH DUY NHẤT ĐỔI THEO TỪNG BƯỚC TÁC CHIẾN */}
          {!isResolved && (
            <div>
              {(stageCode === 'EN_ROUTE' || stageCode === 'PENDING' || stageCode === 'VERIFIED' || stageCode === 'DISPATCHED') && (
                <button
                  type="button"
                  disabled={actionBusy !== null}
                  onClick={() => void advanceStage('ARRIVED')}
                  className="inline-flex min-h-13 w-full items-center justify-center gap-2 rounded-2xl bg-[#1A73E8] px-5 py-3.5 text-sm font-extrabold uppercase tracking-wide text-white shadow-[0_8px_24px_rgba(26,115,232,0.45)] transition-transform active:scale-[0.98] hover:bg-[#1557B0] disabled:opacity-50 sm:text-base"
                >
                  {actionBusy === 'ARRIVED' ? <Spinner className="h-5 w-5" /> : <MapPin className="h-5 w-5" aria-hidden />}
                  ĐÃ TỚI HIỆN TRƯỜNG
                </button>
              )}

              {stageCode === 'ARRIVED' && (
                <button
                  type="button"
                  disabled={actionBusy !== null}
                  onClick={() => void advanceStage('IN_PROGRESS')}
                  className="inline-flex min-h-13 w-full items-center justify-center gap-2 rounded-2xl bg-amber-500 px-5 py-3.5 text-sm font-extrabold uppercase tracking-wide text-slate-950 shadow-[0_8px_24px_rgba(245,158,11,0.4)] transition-transform active:scale-[0.98] hover:bg-amber-400 disabled:opacity-50 sm:text-base"
                >
                  {actionBusy === 'IN_PROGRESS' ? <Spinner className="h-5 w-5" /> : <Wrench className="h-5 w-5" aria-hidden />}
                  BẮT ĐẦU XỬ LÝ
                </button>
              )}

              {stageCode === 'IN_PROGRESS' && !completionOpen && (
                <button
                  type="button"
                  disabled={actionBusy !== null}
                  onClick={() => {
                    setCompletionOpen(true);
                    if (!afterPhoto) {
                      fileInputRef.current?.click();
                    }
                  }}
                  className="inline-flex min-h-13 w-full items-center justify-center gap-2 rounded-2xl bg-[#00B14F] px-5 py-3.5 text-sm font-extrabold uppercase tracking-wide text-white shadow-[0_8px_24px_rgba(0,177,79,0.45)] transition-transform active:scale-[0.98] hover:bg-[#009944] disabled:opacity-50 sm:text-base"
                >
                  {actionBusy === 'photo' ? <Spinner className="h-5 w-5" /> : <Camera className="h-5 w-5" aria-hidden />}
                  CHỤP ẢNH & HOÀN THÀNH ĐƠN
                </button>
              )}
            </div>
          )}
        </div>

        {/* KHỐI NGHIỆM THU ẢNH SAU XỬ LÝ (Mở tự động ở Bước 3) */}
        {completionOpen && !isResolved && (
          <div className="space-y-3 overflow-y-auto border-t border-slate-800 px-4 py-3.5 safe-b">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-extrabold uppercase tracking-wider text-emerald-300">
                Nghiệm thu hiện trường & Đóng đơn
              </p>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={actionBusy !== null}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 text-xs font-bold text-white hover:border-[#1A73E8]"
              >
                <Camera className="h-3.5 w-3.5 text-[#60A5FA]" aria-hidden />
                {afterPhoto ? 'Chụp lại ảnh' : 'Chụp / Tải ảnh sau xử lý'}
              </button>
            </div>

            {afterPhoto && mission.photos[0] ? (
              <BeforeAfterSlider
                before={mission.photos[0].url}
                after={afterPhoto.previewUrl}
                labelBefore="Trước xử lý"
                labelAfter="Sau xử lý"
              />
            ) : afterPhoto ? (
              <img
                src={afterPhoto.previewUrl}
                alt="Ảnh hiện trường sau xử lý"
                decoding="async"
                className="aspect-video w-full rounded-2xl border border-slate-700 object-cover"
              />
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex min-h-28 w-full flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed border-slate-700 bg-slate-950/70 p-4 text-xs font-semibold text-slate-300 hover:border-[#00B14F]"
              >
                <Camera className="h-6 w-6 text-[#00B14F]" aria-hidden />
                <span>Chạm để chụp ảnh hiện trường sau khi đã khắc phục sự cố</span>
              </button>
            )}

            <input
              className="min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 text-xs text-white placeholder:text-slate-500 focus:border-[#00B14F] focus:outline-none"
              placeholder="Ghi chú kết quả xử lý (vd: Đã thu dọn vật cản, thông tuyến an toàn)…"
              value={completeNote}
              onChange={(e) => setCompleteNote(e.target.value)}
              maxLength={350}
            />

            {verifyFeedback && !verifyFeedback.ok && (
              <div
                role="alert"
                className="space-y-2 rounded-xl border border-rose-500/50 bg-rose-500/15 p-3 text-xs text-rose-200"
              >
                <p className="font-bold">{verifyFeedback.text}</p>
                <label className="flex min-h-9 items-center gap-2 font-semibold text-white">
                  <input
                    type="checkbox"
                    checked={overrideAi}
                    onChange={(e) => setOverrideAi(e.target.checked)}
                    className="h-4 w-4"
                  />
                  Xác nhận hoàn thành thực tế tại hiện trường (ghi nhận vào Nhật ký Kiểm toán)
                </label>
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setCompletionOpen(false)}
                className="inline-flex min-h-12 items-center justify-center rounded-xl border border-slate-700 bg-slate-800 px-4 text-xs font-bold text-slate-300"
              >
                Quay lại
              </button>
              <button
                type="button"
                disabled={!afterPhoto || actionBusy !== null}
                onClick={() => void submitCompletion()}
                className="inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-[#00B14F] px-4 text-sm font-extrabold text-white shadow-lg hover:bg-[#009944] disabled:opacity-40"
              >
                {actionBusy === 'complete' ? (
                  <Spinner className="h-4 w-4" />
                ) : (
                  <CheckCircle2 className="h-5 w-5" aria-hidden />
                )}
                XÁC NHẬN & HOÀN THÀNH ĐƠN
              </button>
            </div>
          </div>
        )}

        {/* KHỐI MỞ RỘNG CHI TIẾT: THÔNG TIN SỰ CỐ, CHỌN PHƯƠNG TIỆN, CÁC BƯỚC RẼ & TRẢ ĐƠN BẤT KHẢ KHÁNG */}
        {sheetExpanded && (
          <div className="flex-1 space-y-4 overflow-y-auto border-t border-slate-800 px-4 py-3.5 safe-b">
            <div className="rounded-2xl border border-slate-800 bg-slate-950/90 p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-cyan-300">
                  {t(CATEGORY_META[mission.category].labelKey)} · {ward?.name ?? mission.wardCode}
                </span>
                {mission.slaDueAt && (
                  <span className="flex items-center gap-1 text-xs text-slate-400">
                    <Clock className="h-3.5 w-3.5 text-amber-400" />
                    SLA: <SlaClock iso={mission.slaDueAt} dark />
                  </span>
                )}
              </div>
              <h2 className="mt-1 break-words text-sm font-extrabold text-white">{mission.title}</h2>
              {mission.description && (
                <p className="mt-1 break-words text-xs leading-relaxed text-slate-400">{mission.description}</p>
              )}
            </div>

            {/* Lựa chọn phương tiện tiếp cận hiện trường */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-800 bg-slate-950 p-2.5">
              <span className="px-1 text-xs font-bold text-slate-400">Phương tiện di chuyển:</span>
              <div role="group" aria-label="Chọn phương tiện dẫn đường" className="inline-flex rounded-xl bg-slate-900 p-1">
                {VEHICLE_MODES.map(({ id, label, Icon }) => {
                  const active = vehicleMode === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setVehicleMode(id)}
                      className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-bold transition-colors ${
                        active ? 'bg-[#1A73E8] text-white shadow' : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      <span className="whitespace-nowrap">{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* AI Tactical Briefing */}
            <TacticalBriefingCard
              report={mission}
              compact
              onBriefingUpdated={(b) => {
                onMissionUpdated({
                  ...mission,
                  distanceKm: 'distanceKm' in mission ? mission.distanceKm : null,
                  etaMinutes: 'etaMinutes' in mission ? mission.etaMinutes : null,
                  ai: { ...mission.ai, tacticalBriefing: b },
                });
              }}
            />

            {/* Danh sách từng bước chỉ đường */}
            <div className="space-y-2 rounded-2xl border border-slate-800 bg-slate-950 p-3.5">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-extrabold uppercase tracking-wider text-slate-300">
                  Lộ trình chi tiết ({route?.steps.length ?? 0} chặng)
                </h3>
                <span className="text-[11px] text-slate-400">Chạm để xem giao lộ</span>
              </div>

              <ol className="divide-y divide-slate-800/80">
                {(route?.steps ?? []).map((step, idx) => {
                  const isCurrent = progress?.activeStepIndex === idx;
                  return (
                    <li key={`${step.index}-${idx}`}>
                      <button
                        type="button"
                        onClick={() => {
                          setAutoFollow(false);
                          issueCamera({
                            kind: 'flyTo',
                            lat: step.startLocation.lat,
                            lng: step.startLocation.lng,
                            zoom: 17,
                          });
                        }}
                        className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors ${
                          isCurrent
                            ? 'bg-[#1A73E8]/20 text-white ring-1 ring-[#1A73E8]/60'
                            : 'text-slate-300 hover:bg-slate-900'
                        }`}
                      >
                        <span
                          className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${
                            isCurrent ? 'bg-[#1A73E8] text-white' : 'bg-slate-800 text-slate-300'
                          }`}
                        >
                          <ManeuverIcon maneuver={step.maneuver} className="h-5 w-5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block break-words text-xs font-bold leading-snug sm:text-sm">
                            {step.instructionVi}
                          </span>
                          {step.distanceM > 0 && (
                            <span className="mono mt-0.5 block text-[11px] text-slate-400">
                              {formatDistanceVi(step.distanceM)} · ~{Math.max(1, Math.round(step.durationSec / 60))} phút
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>

            {/* Trả lại đơn về hàng chờ nếu gặp sự cố bất khả kháng */}
            {isActiveDriverTrip && !isResolved && (
              <div className="rounded-2xl border border-rose-500/30 bg-rose-950/20 p-3.5">
                {!releaseOpen ? (
                  <button
                    type="button"
                    onClick={() => setReleaseOpen(true)}
                    className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 text-xs font-bold text-rose-300 hover:bg-rose-500/20"
                  >
                    <RotateCcw className="h-4 w-4" aria-hidden />
                    Gặp sự cố bất khả kháng — Trả đơn về hàng chờ
                  </button>
                ) : (
                  <div className="space-y-2.5">
                    <p className="flex items-center gap-1.5 text-xs font-extrabold text-rose-300">
                      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                      Nhập lý do trả đơn để Trung tâm điều phối đội khác tiếp ứng:
                    </p>
                    <textarea
                      rows={2}
                      maxLength={350}
                      value={releaseReason}
                      onChange={(e) => setReleaseReason(e.target.value)}
                      placeholder="Ví dụ: Xe chuyên dụng gặp sự cố kỹ thuật trên đường, cần đội gần nhất hỗ trợ ngay…"
                      className="w-full rounded-xl border border-rose-500/40 bg-slate-950 p-2.5 text-xs text-white placeholder:text-slate-500 focus:border-rose-400 focus:outline-none"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setReleaseOpen(false);
                          setReleaseReason('');
                        }}
                        className="inline-flex min-h-10 items-center justify-center rounded-xl border border-slate-700 bg-slate-800 px-3 text-xs font-bold text-slate-300"
                      >
                        Hủy
                      </button>
                      <button
                        type="button"
                        disabled={actionBusy !== null || releaseReason.trim().length < 5}
                        onClick={() => void submitReleaseMission()}
                        className="inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-rose-600 px-3 text-xs font-extrabold text-white hover:bg-rose-500 disabled:opacity-40"
                      >
                        {actionBusy === 'release' ? <Spinner className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
                        Xác nhận trả đơn
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
