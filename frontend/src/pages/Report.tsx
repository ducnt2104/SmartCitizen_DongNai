import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Flame,
  Loader2,
  MapPin,
  Mic,
  MicOff,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { nearestWard } from '@shared/geo';
import { normalizeRole } from '@shared/constants';
import type { Category, ClientReport, VisionResult } from '@shared/types';
import { CameraCapture } from '../components/CameraCapture';
import type { ResolvedGeoState } from '../components/map';
import { PhotoExamples } from '../components/PhotoExamples';
import { Spinner } from '../components/ui';

const PrecisionLocationPicker = lazy(() =>
  import('../components/map').then((m) => ({ default: m.PrecisionLocationPicker })),
);
import { WARD_BY_CODE } from '../data/dongNaiWards';
import { useOnline } from '../db/hooks';
import { db } from '../db/localDb';
import { syncBus, type SyncEventDetail } from '../db/sync';
import { usePreciseLocation } from '../hooks/usePreciseLocation';
import { useI18n, type I18nKey } from '../i18n';
import { api, apiMultipart, ApiError, NetworkError } from '../lib/api';
import { useSession } from '../lib/authStore';
import { edge } from '../lib/edgeClient';
import type { EdgeStatsMsg, ExifGpsCoords, ExtractedExifMetadata } from '../lib/imageProcessor';
import { localVision } from '../lib/localVision';
import { CATEGORY_META } from '../lib/meta';
import { speechRecognitionSupported, startListening } from '../lib/speech';
import { attachAngle, confirmReport, submitReport } from '../lib/submitReport';
import { useAuthGate } from '../state/authGate';
import { useSettings } from '../state/settings';
import { useToast } from '../state/toast';

interface PhotoState {
  previewUrl: string;
  aiBlob: Blob;
  displayBlob: Blob;
  dHash: string;
  pHash: string;
  subGridHashes: string[];
  colorHistogram: number[];
  bytes: number;
  aiBytes: number;
  originalBytes: number;
  width: number;
  height: number;
  totalMs: number;
  hashMs: number;
  stats: EdgeStatsMsg;
  exif: ExtractedExifMetadata;
  exifGps: ExifGpsCoords | null;
}

const CATS: Category[] = ['rac_thai', 'den_duong', 'ngap_nuoc', 'mat_duong', 'khac'];

function StepDots({ step }: { step: number }) {
  const { t } = useI18n();
  const labels: I18nKey[] = ['report.step1', 'report.step2', 'report.step3'];
  return (
    <ol className="card grid grid-cols-3 gap-2 p-2.5 sm:p-3" aria-label={t('report.steps')}>
      {labels.map((k, i) => {
        const active = step === i + 1;
        const done = i + 1 <= step;
        return (
          <li key={k} className="min-w-0" aria-current={active ? 'step' : undefined}>
            <div className={`h-1.5 rounded-full transition-colors ${done ? 'bg-brand' : 'bg-line'}`} />
            <p className={`mt-1.5 flex items-center gap-1 truncate text-xs font-bold ${active ? 'text-brand' : done ? 'text-ink' : 'text-muted'}`}>
              <span
                className={`mono inline-grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] ${
                  active ? 'bg-brand text-brand-ink' : done ? 'bg-brand-soft text-brand' : 'bg-surface-2 text-muted'
                }`}
              >
                {i + 1}
              </span>
              <span className="truncate">{t(k)}</span>
            </p>
          </li>
        );
      })}
    </ol>
  );
}

export default function ReportPage() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const nav = useNavigate();
  const online = useOnline();
  const session = useSession();
  const { settings } = useSettings();
  const { requireAuth } = useAuthGate();
  const [params] = useSearchParams();
  const proxy = params.get('proxy') === '1' && Boolean(session?.user && normalizeRole(session.user.role) === 'officer');
  const autoCapture = params.get('capture') === '1';

  const [step, setStep] = useState(1);
  // Bước 1: Ảnh hiện trường + AI phân tích
  const [photo, setPhoto] = useState<PhotoState | null>(null);
  const [processing, setProcessing] = useState(false);
  const [vision, setVision] = useState<VisionResult | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [category, setCategory] = useState<Category | null>(null);
  const [otherLabel, setOtherLabel] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [localDup, setLocalDup] = useState<number | null>(null);
  const [listening, setListening] = useState(false);
  const [honeypot, setHoneypot] = useState('');
  const formLoadedAtRef = useRef(Date.now());
  const stopListen = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const visionAbortRef = useRef<AbortController | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const [dupConfirming, setDupConfirming] = useState(false);

  const replacePreviewUrl = useCallback((nextUrl: string | null) => {
    const prev = previewUrlRef.current;
    if (prev && prev.startsWith('blob:') && prev !== nextUrl) {
      URL.revokeObjectURL(prev);
    }
    previewUrlRef.current = nextUrl;
  }, []);

  // Bước 2: PrecisionLocationPicker (GPS 4s + Center Crosshair Pin + Reverse Geocode 95 Phường/Xã)
  const { fix, status: gpsStatus, samples: gpsSamples, isLowAccuracy, locate: locatePrecise } = usePreciseLocation();
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [exifApplied, setExifApplied] = useState(false);
  const [address, setAddress] = useState('');
  const [geo, setGeo] = useState<ResolvedGeoState | null>(null);
  const [manualWardCode, setManualWardCode] = useState<string>('');
  const [leftScene, setLeftScene] = useState(false);

  // Bước 3: Gửi Local-First Outbox
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<ClientReport | null>(null);
  const [outcome, setOutcome] = useState<{ code: string; report: ClientReport } | null>(null);
  const [rejectedMessage, setRejectedMessage] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopListen.current?.();
      visionAbortRef.current?.abort();
      replacePreviewUrl(null);
    };
  }, [replacePreviewUrl]);

  // ── Bước 1: Web Worker nén song song aiBlob/displayBlob + trích xuất EXIF + dHash → 3-Stage AI ──
  const onFile = useCallback(
    async (file: File) => {
      visionAbortRef.current?.abort();
      const ctrl = new AbortController();
      visionAbortRef.current = ctrl;
      setProcessing(true);
      setVision(null);
      setLocalDup(null);
      setExifApplied(false);
      try {
        const p = await edge.processImage(file);
        if (!mountedRef.current) {
          if (p.previewUrl.startsWith('blob:')) URL.revokeObjectURL(p.previewUrl);
          return;
        }
        replacePreviewUrl(p.previewUrl);
        setPhoto({
          previewUrl: p.previewUrl,
          aiBlob: p.aiBlob,
          displayBlob: p.displayBlob,
          dHash: p.dHash,
          pHash: p.pHash,
          subGridHashes: p.subGridHashes,
          colorHistogram: p.colorHistogram,
          bytes: p.displayBytes,
          aiBytes: p.aiBytes,
          originalBytes: p.originalBytes,
          width: p.width,
          height: p.height,
          totalMs: p.timings.totalMs,
          hashMs: p.timings.hashMs,
          stats: p.stats,
          exif: p.exif,
          exifGps: p.exifGps,
        });

        // Tự động đặt ghim nếu ảnh gốc có EXIF GPS hợp lệ thuộc Thành phố Đồng Nai
        if (p.exifGps?.inBounds) {
          setPin({ lat: p.exifGps.lat, lng: p.exifGps.lng });
          setExifApplied(true);
        }

        // Tầng Edge chống spam đa tầng: dHash + pHash + 3x3 sub-grid (crop) + Color Histogram ngay trong Web Worker
        const known = (await db.reports.toArray()).flatMap((r) =>
          (r.photos ?? []).map((x) => ({
            id: r.id,
            dHash: x.dHash,
            ...(x.pHash ? { pHash: x.pHash } : {}),
            ...(x.subGridHashes ? { subGridHashes: x.subGridHashes } : {}),
            ...(x.colorHistogram ? { colorHistogram: x.colorHistogram } : {}),
          })),
        );
        const dupRes = await edge.duplicateMatch(
          {
            dHash: p.dHash,
            pHash: p.pHash,
            subGridHashes: p.subGridHashes,
            colorHistogram: p.colorHistogram,
          },
          known,
        );
        if (!mountedRef.current) return;
        const firstDup = dupRes.matches.find((item) => item.isDuplicate);
        setLocalDup(firstDup ? firstDup.dHashDist : null);

        setAiBusy(true);
        let v: VisionResult | null = null;
        const cached = await db.aiVisionCache.get(p.dHash);
        if (cached) v = { ...cached.result, cached: true };
        if (!v && navigator.onLine) {
          try {
            const fd = new FormData();
            fd.append('aiImage', p.aiBlob, 'ai.webp');
            const hint = `${title} ${description}`.trim();
            fd.append(
              'metadata',
              JSON.stringify({
                dHash: p.dHash,
                pHash: p.pHash,
                subGridHashes: p.subGridHashes,
                colorHistogram: p.colorHistogram,
                ...(category ? { category } : {}),
                ...(hint ? { hintText: hint } : {}),
                ...(p.exifGps ? { lat: p.exifGps.lat, lng: p.exifGps.lng } : {}),
                edge: p.stats,
                exif: p.exif,
              }),
            );
            v = await apiMultipart<VisionResult>('/api/ai/analyze-image', {
              body: fd,
              timeoutMs: 25_000,
              signal: ctrl.signal,
            });
            if ((v.mode === 'gemini' || v.mode === 'local_ai') && v.status !== 'DUPLICATE_FOUND' && v.decision !== 'AUTO_REJECT') {
              await db.aiVisionCache.put({ dHash: p.dHash, result: v, at: Date.now() });
            }
          } catch (err) {
            if (ctrl.signal.aborted || !mountedRef.current) return;
            if (err instanceof ApiError && err.status === 429) toast('info', t('report.aiLimit'), err.message);
            else if (err instanceof ApiError && err.status === 400) toast('error', t('report.photoFail'), err.message);
            else if (!(err instanceof NetworkError)) console.warn('AI Vision lỗi, dùng bộ phân loại cục bộ:', err);
          }
        }
        if (!mountedRef.current) return;
        if (!v) v = localVision(category, `${title} ${description}`, p.stats);
        setVision(v);
        setCategory((c) => c ?? v!.category);
        if (v.aiSuggestedLabel) setOtherLabel((prev) => prev || v!.aiSuggestedLabel || '');
        setTitle((x) => x || (v!.suggestedTitle ?? v!.title));
        setDescription((x) => x || (v!.suggestedDescription ?? v!.description));
      } catch (err) {
        if (!mountedRef.current) return;
        toast('error', t('report.photoFail'), err instanceof Error ? err.message : undefined);
        replacePreviewUrl(null);
        setPhoto(null);
      } finally {
        if (mountedRef.current) {
          setProcessing(false);
          setAiBusy(false);
        }
      }
    },
    [category, title, description, toast, t, replacePreviewUrl],
  );

  const toggleMic = (): void => {
    if (listening) {
      stopListen.current?.();
      return;
    }
    setListening(true);
    stopListen.current = startListening(lang, {
      onText: (text) => setDescription(text),
      onEnd: () => setListening(false),
      onError: (c) => toast('error', c === 'not-allowed' ? t('chat.micDenied') : t('chat.micError')),
    });
  };

  const activeWardCode =
    manualWardCode || geo?.ward?.wardCode || (pin ? nearestWard(pin.lat, pin.lng).wardCode : '');
  const activeWard = activeWardCode ? WARD_BY_CODE[activeWardCode] : undefined;

  const useNearby = useCallback(
    async (mode: 'confirm' | 'attach', reportId: string): Promise<void> => {
      if (!photo) return;
      if (!(await requireAuth())) return;
      const target = await db.reports.get(reportId);
      if (!target) return;
      if (mode === 'confirm') await confirmReport(target);
      else await attachAngle(target, { displayBlob: photo.displayBlob, aiBlob: photo.aiBlob, dHash: photo.dHash });
      toast('success', mode === 'confirm' ? t('detail.confirmed') : t('detail.attachOk'), t('report.nearbyDone'));
      nav('/mine');
    },
    [photo, requireAuth, toast, t, nav],
  );

  const confirmDuplicateById = useCallback(
    async (incidentId: string): Promise<void> => {
      if (!(await requireAuth())) return;
      setDupConfirming(true);
      try {
        await api(`/api/reports/${incidentId}/confirm`, { method: 'POST' });
        toast('success', t('detail.confirmed'), t('report.nearbyDone'));
        nav('/mine');
      } catch (err) {
        toast('error', t('report.submitFail'), err instanceof Error ? err.message : undefined);
      } finally {
        if (mountedRef.current) setDupConfirming(false);
      }
    },
    [requireAuth, toast, t, nav],
  );

  // ── Bước 3: gửi (Local-First, Outbox) ─────────────────────────────────────────
  useEffect(() => {
    if (!submitted) return;
    const onEv = (e: Event): void => {
      const d = (e as CustomEvent<SyncEventDetail>).detail;
      if (d.type === 'report_result' && d.localId === submitted.id) {
        setRejectedMessage(null);
        setOutcome({ code: d.messageCode, report: d.report });
      } else if (d.type === 'item_failed' && d.item.targetId === submitted.id) {
        setRejectedMessage(d.message);
      }
    };
    syncBus.addEventListener('sync', onEv);
    return () => syncBus.removeEventListener('sync', onEv);
  }, [submitted]);

  const submit = async (): Promise<void> => {
    if (!photo || !pin || !category) return;
    if (!session && online) {
      if (!(await requireAuth())) return;
    }
    setSubmitting(true);
    setRejectedMessage(null);
    try {
      const finalWardCode = activeWardCode || nearestWard(pin.lat, pin.lng).wardCode;
      const finalWardName = WARD_BY_CODE[finalWardCode]?.name ?? nearestWard(pin.lat, pin.lng).name;
      const rep = await submitReport(
        {
          category,
          aiSuggestedLabel: category === 'khac' ? (otherLabel.trim() || vision?.aiSuggestedLabel || null) : null,
          title: title.trim(),
          description: description.trim(),
          lat: pin.lat,
          lng: pin.lng,
          wardCode: finalWardCode,
          address: address || `${finalWardName}, TP. Đồng Nai`,
          photo: {
            previewUrl: photo.previewUrl,
            displayBlob: photo.displayBlob,
            aiBlob: photo.aiBlob,
            dHash: photo.dHash,
            exif: photo.exif,
          },
          deviceLat: fix?.lat,
          deviceLng: fix?.lng,
          leftScene,
          seniorSubmitted: settings.senior || proxy,
          edge: photo.stats,
          vision,
          formLoadedAt: formLoadedAtRef.current,
          website: honeypot,
        },
        proxy,
      );
      setSubmitted(rep);
      if (!online) toast('info', t('report.savedOffline'), t('report.savedOfflineText'));
    } catch (err) {
      toast('error', t('report.submitFail'), err instanceof Error ? err.message : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  const reset = (): void => {
    setStep(1);
    replacePreviewUrl(null);
    setPhoto(null);
    setVision(null);
    setCategory(null);
    setOtherLabel('');
    setTitle('');
    setDescription('');
    setPin(null);
    setExifApplied(false);
    setAddress('');
    setGeo(null);
    setManualWardCode('');
    setLeftScene(false);
    setSubmitted(null);
    setOutcome(null);
    setRejectedMessage(null);
    setLocalDup(null);
    setHoneypot('');
    formLoadedAtRef.current = Date.now();
  };

  const currentRole = session?.user ? normalizeRole(session.user.role) : null;
  if (
    !proxy &&
    (currentRole === 'officer' ||
      currentRole === 'admin' ||
      currentRole === 'rescue')
  ) {
    return (
      <div className="card p-6 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-warn" aria-hidden />
        <p className="mt-2 font-bold">{t('report.staffBlocked')}</p>
        <Link to={currentRole === 'rescue' ? '/rescue' : currentRole === 'officer' ? '/ioc' : '/admin'} className="btn btn-primary mt-4">
          {currentRole === 'rescue' ? 'Vào Cổng Tác Chiến Đội Cứu Hộ' : t('nav.admin')}
        </Link>
      </div>
    );
  }

  // ── Màn hình kết quả ──────────────────────────────────────────────────────────
  if (submitted) {
    if (rejectedMessage) {
      return (
        <div className="card space-y-4 border-2 border-danger/40 bg-danger-soft/40 p-5 text-center" role="alert">
          <ShieldAlert className="mx-auto h-12 w-12 text-danger" aria-hidden />
          <h1 className="text-xl font-extrabold text-danger">Báo cáo bị từ chối bởi Cổng Kiểm định AI</h1>
          <p className="text-sm font-medium text-ink">{rejectedMessage}</p>
          <button type="button" onClick={reset} className="btn btn-primary w-full">
            Chụp lại ảnh hiện trường thật
          </button>
        </div>
      );
    }
    const code = outcome?.code;
    const quarantined = code?.startsWith('quarantine');
    return (
      <div className="card space-y-4 p-5 text-center" role="status">
        {!outcome ? (
          <Loader2 className="mx-auto h-12 w-12 animate-spin text-brand" aria-hidden />
        ) : quarantined ? (
          <ShieldAlert className="mx-auto h-12 w-12 text-warn" aria-hidden />
        ) : code === 'emergency' ? (
          <Flame className="mx-auto h-12 w-12 text-danger" aria-hidden />
        ) : (
          <CheckCircle2 className="mx-auto h-12 w-12 text-ok" aria-hidden />
        )}
        <h1 className="text-xl font-extrabold">
          {!outcome
            ? online
              ? session
                ? t('result.sending')
                : t('result.pendingAuth')
              : t('result.pendingOffline')
            : t(`result.${code as 'created'}` as I18nKey)}
        </h1>
        {outcome && <p className="mono text-lg font-bold text-brand">{outcome.report.code}</p>}
        {outcome?.code === 'merged' && (
          <p className="text-sm text-muted">{t('result.mergedDetail', { n: outcome.report.clusterCount })}</p>
        )}
        {outcome?.code === 'emergency' && <p className="text-sm font-semibold text-danger">{t('result.emergencyDetail')}</p>}
        {!outcome && (
          <p className="text-sm text-muted">
            {t('result.localSaved')} <span className="mono">{submitted.code}</span>
          </p>
        )}
        {!session && !outcome && (
          <Link to="/auth" className="btn btn-primary w-full">
            {t('offline.loginToSend')}
          </Link>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <Link to="/mine" className="btn btn-primary">
            {t('result.viewMine')}
          </Link>
          <button type="button" className="btn btn-ghost" onClick={reset}>
            {t('result.another')}
          </button>
        </div>
      </div>
    );
  }

  const step1Ok = !!photo && !!category && title.trim().length >= 3 && !processing;
  const step2Ok = !!pin && !!geo?.inBounds && !!activeWardCode;
  const authLow = Boolean(vision && (vision.authenticityScore < 45 || vision.decision === 'AUTO_REJECT'));

  return (
    <div className="space-y-4">
      <div
        aria-hidden="true"
        style={{ position: 'absolute', left: '-9999px', width: '1px', height: '1px', overflow: 'hidden' }}
      >
        <label htmlFor="report-website-trap">Website</label>
        <input
          id="report-website-trap"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
        />
      </div>
      <div>
        <h1 className="text-2xl font-extrabold">{proxy ? t('report.proxyTitle') : t('report.title')}</h1>
        {proxy && <p className="mt-1 rounded-xl bg-brand-soft p-2 text-sm font-semibold text-brand">{t('report.proxyNote')}</p>}
      </div>
      <StepDots step={step} />

      {step === 1 && (
        <section className="space-y-4" aria-labelledby="s1">
          <h2 id="s1" className="sr-only">
            {t('report.step1')}
          </h2>
          {!photo && !processing && <PhotoExamples />}
          <CameraCapture onFile={(f) => void onFile(f)} disabled={processing} autoStart={autoCapture && !photo} />

          {processing && (
            <div className="card flex items-center gap-3 p-4" role="status">
              <Spinner className="text-brand" />
              <p className="text-sm font-semibold">{t('report.processing')}</p>
            </div>
          )}

          {photo && (
            <div className="card space-y-3 p-3">
              <img src={photo.previewUrl} alt={t('report.photoAlt')} width={640} height={480} loading="lazy" decoding="async" className="aspect-[4/3] w-full rounded-xl object-cover" />
              <p className="text-xs text-muted">
                Ảnh WebP tối ưu ({photo.width}×{photo.height} · {(photo.bytes / 1024).toFixed(0)} KB / AI {(photo.aiBytes / 1024).toFixed(0)} KB,{' '}
                {t('report.saved', { p: Math.max(0, Math.round((1 - photo.bytes / photo.originalBytes) * 100)) })})
              </p>
              {exifApplied && (
                <p className="flex items-center gap-2 rounded-xl bg-brand-soft px-3 py-2 text-xs font-semibold text-brand">
                  <MapPin className="h-4 w-4 shrink-0" aria-hidden /> {t('report.exifFound')}
                </p>
              )}
              {vision?.status === 'DUPLICATE_FOUND' && vision.duplicateIncidentId && (
                <div role="alert" className="space-y-2 rounded-xl border border-warn/40 bg-warn-soft p-3 text-sm text-warn">
                  <p className="flex items-start gap-2 font-bold">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    {vision.citizenFeedback}
                  </p>
                  <button
                    type="button"
                    disabled={dupConfirming}
                    onClick={() => void confirmDuplicateById(vision.duplicateIncidentId!)}
                    className="btn btn-primary !min-h-10 !px-3 text-xs"
                  >
                    {dupConfirming ? <Spinner /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}
                    Cùng xác nhận (+1 Ưu tiên) · {vision.duplicateIncidentCode}
                  </button>
                </div>
              )}
              {localDup !== null && vision?.status !== 'DUPLICATE_FOUND' && (
                <p role="alert" className="flex gap-2 rounded-xl bg-warn-soft p-3 text-sm font-semibold text-warn">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  {t('report.localDup', { d: localDup })}
                </p>
              )}
              {photo.stats.blurScore < 25 && (
                <p role="alert" className="flex gap-2 rounded-xl bg-warn-soft p-3 text-sm font-semibold text-warn">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  {t('report.blurWarn')}
                </p>
              )}
              {photo.stats.likelyScreenshot && (
                <p role="alert" className="flex gap-2 rounded-xl bg-danger-soft p-3 text-sm font-semibold text-danger">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  Phát hiện dấu hiệu ảnh chụp màn hình hoặc thiếu thông số camera gốc (xác suất {Math.round((photo.stats.screenshotConfidence ?? 0.7) * 100)}%). Vui lòng chụp trực tiếp hiện trường.
                </p>
              )}
              {aiBusy && (
                <p className="flex items-center gap-2 text-sm font-semibold text-brand" role="status">
                  <Sparkles className="h-4 w-4 animate-pulse" aria-hidden />
                  {t('report.aiBusy')}
                </p>
              )}
              {vision && (
                <div className={`space-y-1 rounded-xl p-3 text-sm ${authLow ? 'bg-danger-soft text-danger' : 'bg-ok-soft text-ok'}`}>
                  <p className="flex items-center gap-2 font-bold">
                    {authLow ? <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden /> : <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />}
                    {authLow ? t('report.authLow') : t('report.authOk')} · <span className="mono">{vision.authenticityScore}/100</span>
                  </p>
                  {vision.citizenFeedback && vision.decision === 'AUTO_REJECT' && (
                    <p className="text-xs font-medium">{vision.citizenFeedback}</p>
                  )}
                </div>
              )}
            </div>
          )}

          {photo && (
            <div className="card space-y-3 p-3">
              <fieldset>
                <legend className="label">{t('report.category')}</legend>
                <div className="grid grid-cols-2 gap-2">
                  {CATS.map((c) => {
                    const Icon = CATEGORY_META[c].icon;
                    return (
                      <button
                        key={c}
                        type="button"
                        aria-pressed={category === c}
                        onClick={() => setCategory(c)}
                        className={`btn !min-h-12 !justify-start !px-2.5 sm:!px-3 ${category === c ? 'btn-primary' : 'btn-ghost'}`}
                      >
                        <span
                          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
                          style={category === c ? { background: 'rgba(255,255,255,0.2)' } : { background: `${CATEGORY_META[c].color}1a`, color: CATEGORY_META[c].color }}
                        >
                          <Icon className="h-4 w-4" aria-hidden />
                        </span>
                        <span className="min-w-0 break-words text-left text-xs font-semibold leading-tight sm:text-sm">{t(CATEGORY_META[c].labelKey)}</span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>
              {category === 'khac' && (
                <div>
                  <label htmlFor="oth" className="label">
                    {t('report.otherLabelField')}
                  </label>
                  <input
                    id="oth"
                    className="field"
                    value={otherLabel}
                    maxLength={80}
                    placeholder={t('report.otherLabelPlaceholder')}
                    onChange={(e) => setOtherLabel(e.target.value)}
                  />
                </div>
              )}
              <div>
                <label htmlFor="ttl" className="label">
                  {t('report.titleField')}
                </label>
                <input id="ttl" className="field" value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div>
                <label htmlFor="dsc" className="label">
                  {t('report.descField')}
                </label>
                <div className="relative">
                  <textarea
                    id="dsc"
                    className="field !pr-14"
                    rows={3}
                    value={description}
                    maxLength={800}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                  {speechRecognitionSupported() && (
                    <button
                      type="button"
                      onClick={toggleMic}
                      aria-pressed={listening}
                      aria-label={t('chat.micStart')}
                      className={`absolute right-1.5 top-1.5 grid h-11 w-11 place-items-center rounded-xl ${
                        listening ? 'animate-ring bg-danger text-white' : 'bg-surface-2 text-brand'
                      }`}
                    >
                      {listening ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                    </button>
                  )}
                </div>
              </div>
              {vision && (
                <p className="text-xs text-muted">
                  {t('report.severity')}: <span className="mono font-bold text-ink">{vision.severity}/5</span>{' '}
                  {vision.isEmergency && <span className="font-bold text-danger">· {t('report.emergencyAi')}</span>}
                </p>
              )}
            </div>
          )}
          <button type="button" className="btn btn-primary w-full !min-h-14" disabled={!step1Ok} onClick={() => setStep(2)}>
            {t('common.next')} <ArrowRight className="h-5 w-5" aria-hidden />
          </button>
        </section>
      )}

      {step === 2 && (
        <section className="space-y-4" aria-labelledby="s2">
          <h2 id="s2" className="sr-only">
            {t('report.step2')}
          </h2>

          <Suspense fallback={<div className="card flex h-72 items-center justify-center"><Spinner className="text-brand" /></div>}>
            <PrecisionLocationPicker
              category={category}
              pin={pin}
              onPinChange={setPin}
              address={address}
              onAddressChange={setAddress}
              geo={geo}
              onGeoChange={setGeo}
              manualWardCode={manualWardCode}
              onManualWardChange={setManualWardCode}
              fix={fix}
              gpsStatus={gpsStatus}
              gpsSamples={gpsSamples}
              isLowAccuracy={isLowAccuracy}
              onRequestGps={locatePrecise}
              exifApplied={exifApplied}
              leftScene={leftScene}
              onLeftSceneChange={setLeftScene}
              onUseNearby={useNearby}
            />
          </Suspense>

          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="btn btn-ghost !min-h-14" onClick={() => setStep(1)}>
              <ArrowLeft className="h-5 w-5" aria-hidden />
              {t('common.back')}
            </button>
            <button type="button" className="btn btn-primary !min-h-14" disabled={!step2Ok} onClick={() => setStep(3)}>
              {t('common.next')} <ArrowRight className="h-5 w-5" aria-hidden />
            </button>
          </div>
        </section>
      )}

      {step === 3 && photo && category && (
        <section className="space-y-4" aria-labelledby="s3">
          <h2 id="s3" className="sr-only">
            {t('report.step3')}
          </h2>
          <div className="card space-y-3 p-3">
            <div className="flex gap-3">
              <img src={photo.previewUrl} alt="" width={96} height={96} loading="lazy" decoding="async" className="h-24 w-24 shrink-0 rounded-xl object-cover" />
              <div className="min-w-0">
                <p className="break-words font-bold [overflow-wrap:anywhere]">{title}</p>
                <p className="text-sm font-semibold" style={{ color: CATEGORY_META[category].color }}>
                  {t(CATEGORY_META[category].labelKey)}
                </p>
                <p className="mt-1 break-words text-xs text-muted">{address}</p>
                {activeWard && <p className="text-xs font-semibold text-brand">{activeWard.name}</p>}
              </div>
            </div>
            {geo?.arterial && vision?.isEmergency && (
              <p className="flex items-start gap-2 rounded-xl bg-danger-soft p-3 text-sm font-bold text-danger">
                <Flame className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                {t('report.emergencyPreview', { name: geo.arterial.name })}
              </p>
            )}
            {authLow && <p className="rounded-xl bg-warn-soft p-3 text-sm font-semibold text-warn">{t('report.quarantinePreview')}</p>}
          </div>
          <p className="rounded-xl bg-surface-2 p-3 text-sm">
            {session ? t('report.sendAs', { name: session.user.name }) : online ? t('report.needOtp') : t('report.offlineNoAuth')}
          </p>
          {!online && <p className="rounded-xl bg-slate-900 p-3 text-sm font-semibold text-white">{t('report.offlineNote')}</p>}
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="btn btn-ghost !min-h-14" onClick={() => setStep(2)}>
              <ArrowLeft className="h-5 w-5" aria-hidden />
              {t('common.back')}
            </button>
            <button type="button" className="btn btn-primary !min-h-14" disabled={submitting} onClick={() => void submit()}>
              {submitting ? <Spinner /> : <CheckCircle2 className="h-5 w-5" aria-hidden />} {t('report.send')}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
