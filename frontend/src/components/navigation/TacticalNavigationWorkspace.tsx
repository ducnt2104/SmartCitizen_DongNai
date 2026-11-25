import {
  Bike,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  ExternalLink,
  Footprints,
  ListFilter,
  LocateFixed,
  MapPin,
  Navigation2,
  Play,
  ShieldCheck,
  Square,
  Truck,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ClientReport } from '@shared/types';
import { WARD_BY_CODE } from '../../data/dongNaiWards';
import { db } from '../../db/localDb';
import type { LiveNavPosition } from '../../hooks/useLiveNavigationGps';
import { useI18n } from '../../i18n';
import { api, ApiError } from '../../lib/api';
import { edge } from '../../lib/edgeClient';
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
import { speak, speechSynthesisSupported, stopSpeaking } from '../../lib/speech';
import { useToast } from '../../state/toast';
import type { EdgeStatsMsg } from '../../workers/edgeProcessor.worker';
import type { CameraCommand } from '../map/GoogleMapEngine';
import { UnifiedMapCanvas } from '../map/UnifiedMapCanvas';
import { TacticalBriefingCard } from '../TacticalBriefingCard';
import { BeforeAfterSlider, SlaClock } from '../Timeline';
import { Spinner } from '../ui';
import { ManeuverIcon } from './ManeuverIcon';

export interface TacticalNavigationWorkspaceProps {
  mission: ClientReport;
  allMarkers?: ClientReport[];
  livePos: LiveNavPosition;
  onRefreshGps: () => void;
  onStartSimulation?: (path: Array<{ lat: number; lng: number }>) => void;
  onStopSimulation?: () => void;
  onSelectMarker?: (m: ClientReport) => void;
  onMissionUpdated: (updated: ClientReport) => void;
  /** Hiển thị nút mở danh sách nhiệm vụ trên Mobile / Desktop khi dùng trong /rescue */
  onToggleMissionDrawer?: () => void;
  missionCountBadge?: number;
  desktopLeftInset?: boolean;
  /** Khi mở dưới dạng Modal toàn màn hình từ giao diện Cán bộ (OFFICER) */
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

export function TacticalNavigationWorkspace({
  mission,
  allMarkers,
  livePos,
  onRefreshGps,
  onStartSimulation,
  onStopSimulation,
  onSelectMarker,
  onMissionUpdated,
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
  const [followGps, setFollowGps] = useState(true);
  const [cameraCmd, setCameraCmd] = useState<CameraCommand | null>(null);
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(false);

  // Nghiệm thu & cập nhật trạng thái tác chiến
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [afterPhoto, setAfterPhoto] = useState<{ dataUrl: string; dHash: string; stats: EdgeStatsMsg } | null>(null);
  const [completeNote, setCompleteNote] = useState('');
  const [overrideAi, setOverrideAi] = useState(false);
  const [verifyFeedback, setVerifyFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Cử chỉ vuốt dọc (Touch / Pointer Drag) cho Bottom Sheet
  const dragStartYRef = useRef<number | null>(null);
  const lastSpokenKeyRef = useRef<string>('');
  const lastCalcOriginRef = useRef<{ lat: number; lng: number; missionId: string; mode: TravelVehicleMode } | null>(null);

  const issueCamera = useCallback((cmd: Omit<CameraCommand, 'seq'>) => {
    setCameraCmd((prev) => ({ ...cmd, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

  // Reset trạng thái nghiệm thu khi đổi sự cố
  useEffect(() => {
    setAfterPhoto(null);
    setCompleteNote('');
    setOverrideAi(false);
    setVerifyFeedback(null);
    setFollowGps(false);
    lastSpokenKeyRef.current = '';
  }, [mission.id]);

  // Tính toán tuyến đường (chỉ gọi lại API khi đổi nhiệm vụ, đổi phương tiện, hoặc xe lệch > 80m khỏi lần tính trước khi không mô phỏng)
  useEffect(() => {
    const prev = lastCalcOriginRef.current;
    const movedFar =
      !prev ||
      prev.missionId !== mission.id ||
      prev.mode !== vehicleMode ||
      (!livePos.isSimulating &&
        (Math.abs(prev.lat - livePos.lat) > 0.0008 || Math.abs(prev.lng - livePos.lng) > 0.0008));

    if (!movedFar && route) return undefined;

    lastCalcOriginRef.current = {
      lat: livePos.lat,
      lng: livePos.lng,
      missionId: mission.id,
      mode: vehicleMode,
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
  }, [mission.id, mission.lat, mission.lng, vehicleMode, livePos.lat, livePos.lng, livePos.isSimulating]);

  // Tính tiến độ chặng rẽ hiện tại theo thời gian thực
  const progress = useMemo(
    () =>
      route
        ? computeActiveStepProgress(route, { lat: livePos.lat, lng: livePos.lng })
        : null,
    [route, livePos.lat, livePos.lng],
  );

  // Tự động bám camera theo vị trí xe khi bật followGps
  useEffect(() => {
    if (!followGps) return;
    issueCamera({
      kind: 'flyTo',
      lat: livePos.lat,
      lng: livePos.lng,
      zoom: livePos.isSimulating ? 16.5 : undefined,
    });
  }, [followGps, livePos.lat, livePos.lng, livePos.isSimulating, issueCamera]);

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
      toast('info', 'Trình duyệt hiện tại không hỗ trợ Web Speech API đọc giọng nói.');
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
    setFollowGps(true);
    onRefreshGps();
    issueCamera({
      kind: 'flyTo',
      lat: livePos.lat,
      lng: livePos.lng,
      zoom: 16,
    });
  };

  const updateMissionStatus = async (
    nextStatus: 'ACCEPTED' | 'EN_ROUTE' | 'ON_SITE' | 'RESOLVED',
  ): Promise<void> => {
    setActionBusy(nextStatus);
    try {
      const updated = await api<ClientReport>(`/api/rescue/missions/${mission.id}/status`, {
        method: 'PATCH',
        body: {
          status: nextStatus,
          note: completeNote.trim(),
          lat: livePos.lat,
          lng: livePos.lng,
          ...(afterPhoto ? { afterPhoto: { dataUrl: afterPhoto.dataUrl, dHash: afterPhoto.dHash } } : {}),
          ...(afterPhoto ? { edge: afterPhoto.stats } : {}),
          override: overrideAi,
        },
      });
      await db.reports.put({ ...updated, syncState: 'synced' }).catch(() => undefined);
      onMissionUpdated(updated);

      if (nextStatus === 'EN_ROUTE') {
        setFollowGps(true);
        issueCamera({ kind: 'flyTo', lat: livePos.lat, lng: livePos.lng, zoom: 16 });
      }
      if (nextStatus === 'RESOLVED') {
        setAfterPhoto(null);
        setCompleteNote('');
        setVerifyFeedback(null);
      }

      const msgMap: Record<typeof nextStatus, string> = {
        ACCEPTED: 'Đã nhận nhiệm vụ ứng cứu',
        EN_ROUTE: 'Bắt đầu xuất phát — Đang bám sát lộ trình GPS',
        ON_SITE: 'Đã xác nhận có mặt tại hiện trường',
        RESOLVED: 'Đã hoàn thành xử lý sự cố hiện trường!',
      };
      toast('success', msgMap[nextStatus], updated.code);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ai_verify_rejected') {
        setVerifyFeedback({ ok: false, text: e.message });
      } else {
        toast('error', 'Không cập nhật được trạng thái nhiệm vụ', e instanceof ApiError ? e.message : undefined);
      }
    } finally {
      setActionBusy(null);
    }
  };

  const handlePickAfterPhoto = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setActionBusy('photo');
    try {
      const p = await edge.processImage(file);
      setAfterPhoto({ dataUrl: p.dataUrl, dHash: p.dHash, stats: p.stats });
      setVerifyFeedback(null);
    } catch (e) {
      toast('error', 'Không xử lý được ảnh hiện trường', e instanceof Error ? e.message : undefined);
    } finally {
      setActionBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const submitAiAcceptance = async (): Promise<void> => {
    if (!afterPhoto) return;
    setActionBusy('complete');
    try {
      const res = await api<{ report: ClientReport; accepted: boolean }>(
        `/api/rescue/missions/${mission.id}/complete`,
        {
          method: 'POST',
          body: {
            afterPhoto: { dataUrl: afterPhoto.dataUrl, dHash: afterPhoto.dHash },
            note: completeNote.trim(),
            override: overrideAi,
            edge: afterPhoto.stats,
            lat: livePos.lat,
            lng: livePos.lng,
          },
          timeoutMs: 30000,
        },
      );
      await db.reports.put({ ...res.report, syncState: 'synced' }).catch(() => undefined);
      onMissionUpdated(res.report);
      if (res.accepted) {
        toast('success', 'Đã hoàn thành & vượt qua kiểm định AI Trước/Sau!', res.report.code);
        setAfterPhoto(null);
        setCompleteNote('');
        setVerifyFeedback(null);
      } else {
        setVerifyFeedback({
          ok: false,
          text: res.report.resolution?.summary ?? 'AI chưa xác nhận hiện trường đã được khắc phục.',
        });
      }
    } catch (e) {
      toast('error', 'Không gửi được ảnh nghiệm thu', e instanceof ApiError ? e.message : undefined);
    } finally {
      setActionBusy(null);
    }
  };

  const effectiveHeading = livePos.heading ?? progress?.suggestedBearingDeg ?? 0;
  const ward = WARD_BY_CODE[mission.wardCode];
  const curStage = mission.rescueMission?.status ?? 'unassigned';
  const isResolved = mission.status === 'resolved' || curStage === 'completed';
  const etaMinutes = progress?.remainingDurationMin ?? route?.durationMin ?? 5;
  const distKm = progress?.remainingDistanceKm ?? route?.distanceKm ?? 1.2;
  const activeVehicleMeta = VEHICLE_MODES.find((v) => v.id === vehicleMode) ?? VEHICLE_MODES[0];

  const leftOffsetClass = desktopLeftInset ? 'lg:left-[23rem]' : 'lg:left-4';

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-slate-950 text-slate-100 select-none">
      {/* 1. BẢN ĐỒ TÁC CHIẾN TOÀN MÀN HÌNH (100% VIEWPORT) */}
      <UnifiedMapCanvas
        reports={allMarkers && allMarkers.length > 0 ? allMarkers : [mission]}
        initialCenter={[mission.lat, mission.lng]}
        initialZoom={14}
        tone="ioc"
        cameraCommand={cameraCmd}
        onRequestCamera={issueCamera}
        userPos={{ lat: livePos.lat, lng: livePos.lng }}
        userHeadingDeg={effectiveHeading}
        navigationMode
        accuracyM={livePos.accuracy}
        showArterials
        onSelect={onSelectMarker}
        onUserPan={() => setFollowGps(false)}
        showLayerSwitcher={false}
        showFallbackBadge={false}
        controlsBottomClassName={sheetExpanded ? 'bottom-[58dvh]' : 'bottom-56 sm:bottom-52'}
        routeOverlay={{
          origin: { lat: livePos.lat, lng: livePos.lng },
          destination: { lat: mission.lat, lng: mission.lng },
          fallbackPath: route?.path,
          travelMode: vehicleMode,
          strokeColor: '#1A73E8',
          preserveViewport: followGps || livePos.isSimulating,
        }}
        className="!h-full !w-full !rounded-none !border-0"
        ariaLabel="Bản đồ dẫn đường tác chiến Turn-by-Turn từ vị trí hiện tại tới hiện trường sự cố"
      />

      {headerSlot}

      {/* 2. THANH CHỈ DẪN PHÍA TRÊN (TOP TURN-BY-TURN BANNER — GOOGLE MAPS STYLE) */}
      <div
        className={`pointer-events-none absolute inset-x-3 top-3 z-[45] mx-auto max-w-2xl transition-all duration-200 ${leftOffsetClass} lg:right-4 lg:mx-0`}
      >
        <div className="pointer-events-auto overflow-hidden rounded-2xl border border-white/15 bg-[#0F9D58] text-white shadow-[0_12px_32px_rgba(0,0,0,0.48)]">
          <div className="flex items-center gap-3 px-3.5 py-3 sm:px-4 sm:py-3.5">
            {/* Icon Mũi tên rẽ lớn */}
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-black/15 sm:h-14 sm:w-14">
              {routeLoading && !progress ? (
                <Spinner className="h-6 w-6 text-white" />
              ) : (
                <ManeuverIcon
                  maneuver={progress?.currentStep.maneuver ?? 'straight'}
                  className="h-8 w-8 stroke-[2.5] text-white sm:h-9 sm:w-9"
                />
              )}
            </div>

            {/* Khoảng cách tới ngã rẽ + Tên đường tiếng Việt */}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="mono text-2xl font-extrabold leading-none tracking-tight sm:text-3xl">
                  {progress
                    ? progress.currentStep.maneuver === 'arrive'
                      ? 'Đích đến'
                      : formatDistanceVi(progress.distanceToTurnM)
                    : 'Đang tính…'}
                </span>
                {livePos.speedKmh !== null && (
                  <span className="mono rounded-md bg-black/20 px-1.5 py-0.5 text-[11px] font-bold">
                    {livePos.speedKmh} km/h
                  </span>
                )}
                <span className="rounded-md bg-black/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-50">
                  {route?.source === 'google_directions'
                    ? 'Google Directions'
                    : route?.source === 'osrm'
                      ? 'OSRM VN'
                      : 'Tuyến Dự Phòng'}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 break-words text-sm font-extrabold leading-snug text-white sm:text-base">
                {progress?.currentStep.instructionVi ?? `Đang tìm đường tới ${mission.address || mission.title}`}
              </p>
            </div>

            {/* Cụm nút nhanh trên Top Banner: Loa tiếng Việt, Danh sách nhiệm vụ (mobile), Đóng (modal) */}
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={toggleVoice}
                aria-pressed={voiceEnabled}
                className={`grid h-11 w-11 place-items-center rounded-xl border transition-colors ${
                  voiceEnabled
                    ? 'border-white bg-white text-[#0F9D58]'
                    : 'border-white/25 bg-black/15 text-white hover:bg-black/25'
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
                  className="relative grid h-11 w-11 place-items-center rounded-xl border border-white/25 bg-black/15 text-white hover:bg-black/25 lg:hidden"
                  title="Danh sách sự cố cứu hộ"
                  aria-label="Mở danh sách sự cố"
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
                  className="grid h-11 w-11 place-items-center rounded-xl border border-white/25 bg-black/20 text-white hover:bg-black/35"
                  title="Đóng chế độ dẫn đường"
                  aria-label="Đóng chế độ dẫn đường"
                >
                  <X className="h-5 w-5" />
                </button>
              )}
            </div>
          </div>

          {/* Dải phụ báo bước rẽ kế tiếp ("Tiếp theo: ...") */}
          {progress?.nextStep && (
            <div className="flex items-center gap-2 bg-[#0B8043] px-4 py-1.5 text-xs font-bold text-emerald-50">
              <span className="uppercase tracking-wider opacity-85">Tiếp theo:</span>
              <ManeuverIcon maneuver={progress.nextStep.maneuver} className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {progress.nextStep.instructionVi}
                {progress.nextStep.distanceM > 0 ? ` (${formatDistanceVi(progress.nextStep.distanceM)})` : ''}
              </span>
            </div>
          )}
        </div>

        {/* Huy hiệu trạng thái Live GPS + Nút "Về vị trí của tôi" (Re-center) khi người dùng kéo bản đồ */}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <div className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-slate-700/90 bg-slate-900/90 px-3 py-1 text-[11px] font-semibold text-slate-200 shadow-lg backdrop-blur-md">
            <span
              className={`h-2 w-2 rounded-full ${
                livePos.isSimulating
                  ? 'animate-ping bg-cyan-400'
                  : livePos.isFallback
                    ? 'bg-amber-400'
                    : 'animate-pulse bg-emerald-400'
              }`}
            />
            <span className="truncate">
              {livePos.isSimulating
                ? 'Đang mô phỏng di chuyển GPS dọc tuyến'
                : livePos.isFallback
                  ? `Điểm xuất phát mặc định (${ward?.shortName ?? 'P. Trấn Biên'})`
                  : `Live GPS ±${livePos.accuracy}m`}
            </span>
          </div>

          <div className="pointer-events-auto flex items-center gap-2">
            {!followGps && (
              <button
                type="button"
                onClick={handleRecenter}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-[#1A73E8] bg-white px-3.5 py-1.5 text-xs font-extrabold text-[#1A73E8] shadow-xl transition-transform active:scale-95"
              >
                <Navigation2 className="h-4 w-4 fill-current" aria-hidden />
                Về vị trí của tôi
              </button>
            )}

            {onStartSimulation && onStopSimulation && route && route.path.length >= 2 && (
              <button
                type="button"
                onClick={() => {
                  if (livePos.isSimulating) {
                    onStopSimulation();
                  } else {
                    setFollowGps(true);
                    onStartSimulation(route.path);
                  }
                }}
                className={`inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold shadow-lg backdrop-blur-md transition-transform active:scale-95 ${
                  livePos.isSimulating
                    ? 'border-rose-400 bg-rose-600 text-white'
                    : 'border-slate-700 bg-slate-900/90 text-cyan-300 hover:border-cyan-400'
                }`}
                title="Mô phỏng xe cứu hộ di chuyển dọc tuyến đường #1A73E8"
              >
                {livePos.isSimulating ? (
                  <>
                    <Square className="h-3.5 w-3.5 fill-current" /> Dừng chạy thử
                  </>
                ) : (
                  <>
                    <Play className="h-3.5 w-3.5 fill-current" /> Chạy thử GPS
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 3. BOTTOM SHEET ĐIỀU KHIỂN TÁC CHIẾN (VUỐT / MỞ RỘNG CHUẨN GOOGLE MAPS) */}
      <section
        aria-label="Bảng điều khiển dẫn đường và tác chiến hiện trường"
        className={`absolute inset-x-0 bottom-0 z-[45] mx-auto flex max-w-3xl flex-col rounded-t-3xl border-t border-slate-700/90 bg-slate-900/98 shadow-[0_-12px_36px_rgba(0,0,0,0.55)] backdrop-blur-xl transition-transform duration-200 ease-out ${leftOffsetClass} lg:right-4 lg:mx-0 ${
          sheetExpanded ? 'max-h-[78dvh]' : 'max-h-[16.5rem] sm:max-h-[14.5rem]'
        }`}
      >
        {/* Thanh nắm vuốt mở rộng / thu gọn */}
        <div
          role="button"
          tabIndex={0}
          aria-expanded={sheetExpanded}
          aria-label={sheetExpanded ? 'Thu gọn bảng chỉ đường' : 'Mở rộng xem từng bước chỉ đường và tác chiến'}
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

        {/* Hàng Tóm tắt Luôn Hiển thị (Chế độ Thu gọn): ETA | Quãng đường | Địa chỉ | Phương tiện | Giọng nói | Mở Google Maps gốc */}
        <div className="shrink-0 space-y-2.5 px-4 pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                <span className="mono text-2xl font-extrabold text-[#34A853] sm:text-3xl">
                  {etaMinutes} phút
                </span>
                <span className="mono text-base font-bold text-slate-200 sm:text-lg">
                  ({distKm} km)
                </span>
                <span className="mono text-xs font-semibold text-slate-400">
                  · Đến lúc {formatArrivalClock(etaMinutes)}
                </span>
              </div>
              <p className="mt-0.5 truncate text-xs font-semibold text-slate-300 sm:text-sm">
                <span className="mono mr-1.5 rounded bg-[#1A73E8]/20 px-1.5 py-0.5 text-[11px] font-bold text-[#60A5FA]">
                  {mission.code}
                </span>
                {mission.address || `${ward?.name ?? mission.wardCode}, TP. Đồng Nai`}
              </p>
            </div>

            <button
              type="button"
              onClick={() => setSheetExpanded((v) => !v)}
              className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-xl border border-slate-700 bg-slate-800 px-3 text-xs font-extrabold text-white hover:border-[#1A73E8]"
            >
              {sheetExpanded ? (
                <>
                  Thu gọn <ChevronDown className="h-4 w-4" />
                </>
              ) : (
                <>
                  Chi tiết ({route?.steps.length ?? 0} chặng) <ChevronUp className="h-4 w-4" />
                </>
              )}
            </button>
          </div>

          {/* Hàng công cụ nhanh: Phương tiện (Xe cứu hộ / Xe máy / Đi bộ) + Giọng nói + Mở Google Maps gốc */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div
              role="group"
              aria-label="Chọn phương tiện dẫn đường"
              className="inline-flex rounded-xl border border-slate-800 bg-slate-950 p-1"
            >
              {VEHICLE_MODES.map(({ id, label, Icon }) => {
                const active = vehicleMode === id;
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setVehicleMode(id)}
                    className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-bold transition-colors ${
                      active
                        ? 'bg-[#1A73E8] text-white shadow'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="whitespace-nowrap">{label}</span>
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={toggleVoice}
                aria-pressed={voiceEnabled}
                className={`inline-flex min-h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-bold transition-colors ${
                  voiceEnabled
                    ? 'border-emerald-400/60 bg-emerald-500/20 text-emerald-300'
                    : 'border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-600'
                }`}
              >
                {voiceEnabled ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
                <span>{voiceEnabled ? 'Đang bật giọng nói' : 'Giọng nói VI'}</span>
              </button>

              <button
                type="button"
                onClick={handleRecenter}
                className="inline-flex min-h-9 items-center gap-1 rounded-xl border border-slate-700 bg-slate-800 px-2.5 text-xs font-bold text-slate-200 hover:border-[#1A73E8]"
                title="Định vị lại GPS hiện tại"
              >
                <LocateFixed className="h-3.5 w-3.5 text-[#60A5FA]" />
                <span className="hidden sm:inline">Định vị</span>
              </button>

              <a
                href={googleMapsDirectionsUrl(
                  mission.lat,
                  mission.lng,
                  { lat: livePos.lat, lng: livePos.lng },
                  activeVehicleMeta.gmapsMode,
                )}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-9 items-center gap-1.5 rounded-xl bg-[#1A73E8] px-3 text-xs font-extrabold text-white shadow hover:bg-[#1557B0]"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                <span>Mở Google Maps gốc</span>
              </a>
            </div>
          </div>
        </div>

        {/* 4. NỘI DUNG MỞ RỘNG: QUY TRÌNH TÁC CHIẾN 1-CHẠM + ẢNH HIỆN TRƯỜNG + TỪNG BƯỚC RẼ (TURN-BY-TURN STEPS) */}
        {sheetExpanded && (
          <div className="flex-1 space-y-4 overflow-y-auto border-t border-slate-800 px-4 py-3.5 safe-b">
            {/* Khối thông tin nhanh sự cố */}
            <div className="rounded-2xl border border-slate-800 bg-slate-950/90 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-cyan-300">
                  {t(CATEGORY_META[mission.category].labelKey)} · {ward?.name ?? mission.wardCode}
                </span>
                <span className="flex items-center gap-1 text-xs text-slate-400">
                  <Clock className="h-3.5 w-3.5 text-amber-400" />
                  SLA: <SlaClock iso={mission.slaDueAt} dark />
                </span>
              </div>
              <h2 className="mt-1 break-words text-sm font-extrabold text-white">{mission.title}</h2>
              {mission.description && (
                <p className="mt-1 break-words text-xs leading-relaxed text-slate-400">{mission.description}</p>
              )}
            </div>

            {/* Các nút 1-chạm cập nhật trạng thái nhanh (ACCEPTED -> EN_ROUTE -> ON_SITE -> RESOLVED) */}
            {!isResolved ? (
              <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-950 p-3.5">
                <p className="text-xs font-extrabold uppercase tracking-wider text-slate-300">
                  Điều khiển trạng thái tác chiến 1 chạm
                </p>

                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    disabled={actionBusy !== null || curStage !== 'unassigned'}
                    onClick={() => void updateMissionStatus('ACCEPTED')}
                    className={`flex min-h-12 flex-col items-center justify-center rounded-xl border px-2 py-2 text-xs font-extrabold transition-colors ${
                      curStage !== 'unassigned'
                        ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                        : 'border-[#1A73E8] bg-[#1A73E8]/25 text-white hover:bg-[#1A73E8]/40'
                    }`}
                  >
                    {actionBusy === 'ACCEPTED' ? <Spinner className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
                    <span className="mt-0.5 text-center leading-tight">Nhận lệnh</span>
                  </button>

                  <button
                    type="button"
                    disabled={actionBusy !== null || curStage === 'en_route' || curStage === 'on_site'}
                    onClick={() => void updateMissionStatus('EN_ROUTE')}
                    className={`flex min-h-12 flex-col items-center justify-center rounded-xl border px-2 py-2 text-xs font-extrabold transition-colors ${
                      curStage === 'en_route' || curStage === 'on_site'
                        ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                        : 'border-amber-400/60 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
                    }`}
                  >
                    {actionBusy === 'EN_ROUTE' ? <Spinner className="h-4 w-4" /> : <Truck className="h-4 w-4" />}
                    <span className="mt-0.5 text-center leading-tight">Bắt đầu xuất phát</span>
                  </button>

                  <button
                    type="button"
                    disabled={actionBusy !== null || curStage === 'on_site'}
                    onClick={() => void updateMissionStatus('ON_SITE')}
                    className={`flex min-h-12 flex-col items-center justify-center rounded-xl border px-2 py-2 text-xs font-extrabold transition-colors ${
                      curStage === 'on_site'
                        ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                        : 'border-rose-400/60 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25'
                    }`}
                  >
                    {actionBusy === 'ON_SITE' ? <Spinner className="h-4 w-4" /> : <MapPin className="h-4 w-4" />}
                    <span className="mt-0.5 text-center leading-tight">Đã tới hiện trường</span>
                  </button>
                </div>

                {/* Chụp ảnh đối chiếu Trước/Sau & Hoàn thành */}
                <div className="space-y-2.5 rounded-xl border border-slate-800 bg-slate-900/90 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-extrabold text-emerald-300">
                      Hoàn thành & Chụp ảnh đối chiếu hiện trường
                    </span>
                    <button
                      type="button"
                      disabled={actionBusy !== null}
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 text-xs font-bold text-white hover:border-[#1A73E8]"
                    >
                      {actionBusy === 'photo' ? (
                        <Spinner className="h-4 w-4" />
                      ) : (
                        <Camera className="h-4 w-4 text-[#60A5FA]" />
                      )}
                      {afterPhoto ? 'Chụp / Chọn lại ảnh' : 'Chụp ảnh đối chiếu'}
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                      onChange={(e) => void handlePickAfterPhoto(e.target.files?.[0])}
                    />
                  </div>

                  {mission.photos[0] && !afterPhoto && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div>
                        <p className="mb-1 text-[11px] text-slate-400">Ảnh hiện trường sự cố:</p>
                        <img
                          src={mission.photos[0].url}
                          alt={mission.title}
                          className="aspect-video w-full rounded-xl border border-slate-800 object-cover"
                        />
                      </div>
                      <div className="flex items-center justify-center rounded-xl border border-dashed border-slate-700 p-3 text-center text-xs text-slate-400">
                        Chụp ảnh SAU khi khắc phục để AI đối chiếu cảnh vật (`sceneMatchScore`) & mức độ sạch (`resolutionScore`).
                      </div>
                    </div>
                  )}

                  {afterPhoto && mission.photos[0] && (
                    <BeforeAfterSlider
                      before={mission.photos[0].url}
                      after={afterPhoto.dataUrl}
                      labelBefore="Trước"
                      labelAfter="Sau xử lý"
                    />
                  )}

                  <input
                    className="min-h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-xs text-white placeholder:text-slate-500"
                    placeholder="Ghi chú biên bản hoàn thành (vd: Đã thu dọn vật cản, đảm bảo lưu thông an toàn)…"
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
                        Xác nhận hoàn thành thủ công tại hiện trường (lưu Nhật ký Kiểm toán)
                      </label>
                    </div>
                  )}

                  <div className="grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      disabled={!afterPhoto || actionBusy !== null}
                      onClick={() => void submitAiAcceptance()}
                      className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-[#0F9D58] px-3 text-xs font-extrabold text-white shadow hover:bg-[#0B8043] disabled:opacity-40"
                    >
                      {actionBusy === 'complete' ? (
                        <Spinner className="h-4 w-4" />
                      ) : (
                        <CheckCircle2 className="h-4 w-4" aria-hidden />
                      )}
                      AI Nghiệm Thu & Đóng Đơn
                    </button>

                    <button
                      type="button"
                      disabled={actionBusy !== null}
                      onClick={() => void updateMissionStatus('RESOLVED')}
                      className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-emerald-500/50 bg-emerald-500/15 px-3 text-xs font-bold text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40"
                    >
                      {actionBusy === 'RESOLVED' ? (
                        <Spinner className="h-4 w-4" />
                      ) : (
                        <CheckCircle2 className="h-4 w-4" aria-hidden />
                      )}
                      Xác nhận Hoàn thành Nhanh
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-2 rounded-2xl border border-emerald-500/40 bg-emerald-950/25 p-3.5">
                <p className="flex items-center gap-2 text-sm font-extrabold text-emerald-300">
                  <CheckCircle2 className="h-5 w-5" /> Nhiệm vụ đã hoàn thành tại hiện trường
                </p>
                {mission.afterPhoto && mission.photos[0] && (
                  <BeforeAfterSlider
                    before={mission.photos[0].url}
                    after={mission.afterPhoto.url}
                    labelBefore="Trước"
                    labelAfter="Sau"
                  />
                )}
              </div>
            )}

            {/* AI Tactical Briefing */}
            <TacticalBriefingCard
              report={mission}
              compact
              onBriefingUpdated={(b) => {
                onMissionUpdated({ ...mission, ai: { ...mission.ai, tacticalBriefing: b } });
              }}
            />

            {/* Danh sách đầy đủ Từng bước chỉ đường (Turn-by-Turn Steps) */}
            <div className="space-y-2 rounded-2xl border border-slate-800 bg-slate-950 p-3.5">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-extrabold uppercase tracking-wider text-slate-300">
                  Chi tiết từng chặng rẽ ({route?.steps.length ?? 0} bước)
                </h3>
                <span className="mono text-[11px] text-slate-400">
                  Bấm vào từng bước để xem giao lộ
                </span>
              </div>

              <ol className="divide-y divide-slate-800/80">
                {(route?.steps ?? []).map((step, idx) => {
                  const isCurrent = progress?.activeStepIndex === idx;
                  return (
                    <li key={`${step.index}-${idx}`}>
                      <button
                        type="button"
                        onClick={() => {
                          setFollowGps(false);
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
          </div>
        )}
      </section>
    </div>
  );
}
