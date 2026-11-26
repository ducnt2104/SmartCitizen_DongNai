import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Flame,
  Loader2,
  MapPin,
  Mic,
  MicOff,
  Pencil,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
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
import { DONG_NAI_WARDS, WARD_BY_CODE } from '../data/dongNaiWards';
import { useOnline } from '../db/hooks';
import { db } from '../db/localDb';
import { discardOutboxItem, retryFailed, syncBus, type SyncEventDetail } from '../db/sync';
import { usePreciseLocation } from '../hooks/usePreciseLocation';
import { useI18n, type I18nKey } from '../i18n';
import { api, apiMultipart, ApiError, NetworkError } from '../lib/api';
import { useSession } from '../lib/authStore';
import { edge } from '../lib/edgeClient';
import { reverseGeocode } from '../lib/geoClient';
import type { EdgeStatsMsg, ExifGpsCoords, ExtractedExifMetadata } from '../lib/imageProcessor';
import { localVision } from '../lib/localVision';
import { CATEGORY_META } from '../lib/meta';
import {
  computeSmartAutofill,
  resolveInstantWardFromCoords,
  type AutofillField,
  type PendingAiSuggestions,
  type ReportFormValues,
} from '../lib/reportAutofill';
import { speechRecognitionSupported, startListening } from '../lib/speech';
import { attachAngle, confirmReport, submitReport } from '../lib/submitReport';
import { useAuthGate } from '../state/authGate';
import { useSettings } from '../state/settings';
import { useToast } from '../state/toast';

interface PhotoState {
  previewUrl: string;
  aiBlob: Blob;
  aiMimeType: string;
  aiSha256: string;
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
const WARDS_PHUONG = DONG_NAI_WARDS.filter((w) => w.kind === 'Phường');
const WARDS_XA = DONG_NAI_WARDS.filter((w) => w.kind === 'Xã');
const CLIENT_VISION_CACHE_TTL_MS = 20 * 60 * 1000;

const SEVERITY_OPTIONS: ReadonlyArray<{ value: 1 | 2 | 3 | 4 | 5; label: string }> = [
  { value: 1, label: '1 · Nhẹ' },
  { value: 2, label: '2 · Thấp' },
  { value: 3, label: '3 · Trung bình' },
  { value: 4, label: '4 · Cao' },
  { value: 5, label: '5 · Khẩn cấp' },
];

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
  // Bước 1: Ảnh hiện trường + AI phân tích + Smart Auto-Fill
  const [photo, setPhoto] = useState<PhotoState | null>(null);
  const [processing, setProcessing] = useState(false);
  const [vision, setVision] = useState<VisionResult | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiElapsedMs, setAiElapsedMs] = useState<number | null>(null);
  const [aiStageLabel, setAiStageLabel] = useState<string | null>(null);
  const [aiWarning, setAiWarning] = useState<string | null>(null);
  const [category, setCategory] = useState<Category | null>(null);
  const [otherLabel, setOtherLabel] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<1 | 2 | 3 | 4 | 5>(3);
  const [isEmergency, setIsEmergency] = useState(false);
  const [pendingSuggestions, setPendingSuggestions] = useState<PendingAiSuggestions | null>(null);
  const [localDup, setLocalDup] = useState<number | null>(null);
  const [listening, setListening] = useState(false);
  const [honeypot, setHoneypot] = useState('');
  const formLoadedAtRef = useRef(Date.now());
  const stopListen = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const activePhotoSeqRef = useRef(0);
  const visionAbortRef = useRef<AbortController | null>(null);
  const geocodeAbortRef = useRef<AbortController | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const dirtyFieldsRef = useRef<Set<AutofillField>>(new Set());
  const [dupConfirming, setDupConfirming] = useState(false);

  const replacePreviewUrl = useCallback((nextUrl: string | null) => {
    const prev = previewUrlRef.current;
    if (prev && prev.startsWith('blob:') && prev !== nextUrl) {
      URL.revokeObjectURL(prev);
    }
    previewUrlRef.current = nextUrl;
  }, []);

  // Bước 2: PrecisionLocationPicker + 95 Xã/Phường Đồng Nai
  const { fix, status: gpsStatus, samples: gpsSamples, isLowAccuracy, locate: locatePrecise } = usePreciseLocation();
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [exifApplied, setExifApplied] = useState(false);
  const [address, setAddress] = useState('');
  const [geo, setGeo] = useState<ResolvedGeoState | null>(null);
  const [manualWardCode, setManualWardCode] = useState<string>('');
  const [leftScene, setLeftScene] = useState(false);
  // Bước 3: Trạng thái gửi báo cáo Local-First
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<ClientReport | null>(null);
  const [outcome, setOutcome] = useState<{ code: string; report: ClientReport } | null>(null);
  const [rejectedMessage, setRejectedMessage] = useState<string | null>(null);
  const [retryNotice, setRetryNotice] = useState<{ outboxId: string; message: string; attempts: number } | null>(null);
  const [failedOutboxId, setFailedOutboxId] = useState<string | null>(null);
  const [editingOutboxId, setEditingOutboxId] = useState<string | null>(null);
  const [editOutboxNotice, setEditOutboxNotice] = useState<string | null>(null);

  const activeWardCode =
    manualWardCode || geo?.ward?.wardCode || (pin ? nearestWard(pin.lat, pin.lng).wardCode : '');
  const activeWard = activeWardCode ? WARD_BY_CODE[activeWardCode] : undefined;

  // Luôn đồng bộ snapshot mới nhất vào ref để tránh stale closure khi async AI hoàn tất
  const formValuesRef = useRef<ReportFormValues>({
    category,
    otherLabel,
    title,
    description,
    severity,
    isEmergency,
    wardCode: activeWardCode,
    address,
  });
  formValuesRef.current = {
    category,
    otherLabel,
    title,
    description,
    severity,
    isEmergency,
    wardCode: activeWardCode,
    address,
  };

  const markDirty = useCallback((field: AutofillField) => {
    dirtyFieldsRef.current.add(field);
  }, []);

  const applyInstantCoordsToLocation = useCallback(
    (lat: number, lng: number, fromExif: boolean, seq: number) => {
      if (!mountedRef.current || seq !== activePhotoSeqRef.current) return;
      const instant = resolveInstantWardFromCoords(lat, lng);
      if (instant.inBounds) {
        setPin({ lat, lng });
        setExifApplied(fromExif);
        setGeo(instant.geo);
        if (!dirtyFieldsRef.current.has('wardCode')) {
          setManualWardCode('');
        }
        if (!dirtyFieldsRef.current.has('address')) {
          setAddress(instant.address);
        }
      }

      // Chạy Reverse Geocode chi tiết số nhà/tên đường trên nền (không chặn UI hay AI)
      geocodeAbortRef.current?.abort();
      const gCtrl = new AbortController();
      geocodeAbortRef.current = gCtrl;
      if (navigator.onLine) {
        void reverseGeocode(lat, lng, gCtrl.signal)
          .then((g) => {
            if (gCtrl.signal.aborted || !mountedRef.current || seq !== activePhotoSeqRef.current) return;
            if (g.inBounds && g.wardCode && g.wardName) {
              setGeo((prev) => ({
                inBounds: true,
                ward: { wardCode: g.wardCode!, name: g.wardName! },
                arterial: g.arterial ?? prev?.arterial ?? null,
                nearby: prev?.nearby ?? [],
                needsConfirmation: g.needsConfirmation,
                source: g.source,
                matchedAlias: g.matchedAlias,
              }));
              if (!dirtyFieldsRef.current.has('address') && g.address) {
                setAddress(g.address);
              }
            }
          })
          .catch(() => undefined);
      }
      return instant;
    },
    [],
  );

  const applyVisionToForm = useCallback(
    (v: VisionResult) => {
      const { nextValues, pendingSuggestions: pending } = computeSmartAutofill({
        vision: v,
        current: formValuesRef.current,
        dirtyFields: dirtyFieldsRef.current,
      });

      setCategory(nextValues.category);
      setOtherLabel(nextValues.otherLabel);
      setTitle(nextValues.title);
      setDescription(nextValues.description);
      setSeverity(nextValues.severity);
      setIsEmergency(nextValues.isEmergency);
      setAddress(nextValues.address);
      setPendingSuggestions(pending);
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopListen.current?.();
      visionAbortRef.current?.abort();
      geocodeAbortRef.current?.abort();
      replacePreviewUrl(null);
    };
  }, [replacePreviewUrl]);

  const runVisionAnalysis = useCallback(
    async (
      p: PhotoState,
      opts: { seq: number; skipCache?: boolean; wardHint?: string; coordsHint?: { lat: number; lng: number } | null },
    ) => {
      visionAbortRef.current?.abort();
      const ctrl = new AbortController();
      visionAbortRef.current = ctrl;

      setAiBusy(true);
      setAiWarning(null);
      setAiElapsedMs(null);
      setAiStageLabel(opts.skipCache ? 'Đang phân tích lại bằng AI…' : t('report.aiBusy'));

      const tStart = performance.now();
      let v: VisionResult | null = null;

      try {
        // 1. Kiểm tra Cache Client (IndexedDB theo SHA-256 -> dHash, TTL 20 phút, bỏ qua kết quả lỗi/degraded)
        if (!opts.skipCache) {
          const bySha = p.aiSha256
            ? await db.aiVisionCache.where('sha256').equals(p.aiSha256).first().catch(() => undefined)
            : undefined;
          const byHash = bySha ?? (await db.aiVisionCache.get(p.dHash).catch(() => undefined));
          if (
            byHash &&
            Date.now() - byHash.at <= CLIENT_VISION_CACHE_TTL_MS &&
            byHash.result.mode === 'gemini' &&
            !byHash.result.degraded &&
            !byHash.result.errorCode
          ) {
            v = { ...byHash.result, cached: true };
          }
        }

        if (ctrl.signal.aborted || !mountedRef.current || opts.seq !== activePhotoSeqRef.current) return;

        // 2. Gọi API Backend Vision (ảnh <= 1024px 120-220KB + SHA-256 + Gemini 3.8 Flash + KeyPool failover)
        if (!v && navigator.onLine) {
          try {
            const fd = new FormData();
            const ext = p.aiMimeType === 'image/jpeg' ? 'jpg' : p.aiMimeType === 'image/png' ? 'png' : 'webp';
            fd.append('aiImage', p.aiBlob, `ai.${ext}`);
            const coords = opts.coordsHint ?? (p.exifGps ? { lat: p.exifGps.lat, lng: p.exifGps.lng } : null);
            const wardForAi = opts.wardHint || formValuesRef.current.wardCode || undefined;

            fd.append(
              'metadata',
              JSON.stringify({
                dHash: p.dHash,
                pHash: p.pHash,
                subGridHashes: p.subGridHashes,
                colorHistogram: p.colorHistogram,
                ...(p.aiSha256 ? { imageSha256: p.aiSha256 } : {}),
                forceCloud: true,
                ...(opts.skipCache ? { skipCache: true } : {}),
                ...(wardForAi ? { wardCode: wardForAi } : {}),
                ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
                edge: p.stats,
                exif: p.exif,
              }),
            );
            v = await apiMultipart<VisionResult>('/api/ai/analyze-image', {
              body: fd,
              timeoutMs: 14_000,
              signal: ctrl.signal,
            });

            if (
              !ctrl.signal.aborted &&
              v.mode === 'gemini' &&
              !v.degraded &&
              !v.errorCode &&
              v.status !== 'DUPLICATE_FOUND' &&
              v.decision !== 'AUTO_REJECT'
            ) {
              await db.aiVisionCache
                .put({ dHash: p.dHash, sha256: p.aiSha256, result: v, at: Date.now() })
                .catch(() => undefined);
            }
          } catch (err) {
            if (ctrl.signal.aborted || !mountedRef.current || opts.seq !== activePhotoSeqRef.current) return;
            if (err instanceof ApiError && err.status === 429) {
              setAiWarning(err.message);
              toast('info', t('report.aiLimit'), err.message);
            } else if (err instanceof ApiError && err.status === 400) {
              setAiWarning(err.message);
              toast('error', t('report.photoFail'), err.message);
            } else if (err instanceof NetworkError) {
              setAiWarning(err.message || t('report.aiDegraded'));
            } else {
              console.warn('AI Vision lỗi, dùng bộ phân loại cục bộ:', err);
              setAiWarning(t('report.aiDegraded'));
            }
          }
        }

        if (ctrl.signal.aborted || !mountedRef.current || opts.seq !== activePhotoSeqRef.current) return;

        if (!v) {
          const cur = formValuesRef.current;
          v = localVision(cur.category, `${cur.title} ${cur.description}`, p.stats);
        }

        if (v.degraded || v.errorCode) {
          setAiWarning(v.errorMessage || t('report.aiDegraded'));
        }

        const elapsed = Math.max(1, Math.round(performance.now() - tStart));
        setAiElapsedMs(v.cached ? Math.min(elapsed, Math.max(1, Math.round(v.latencyMs ?? elapsed))) : elapsed);
        setVision(v);
        applyVisionToForm(v);
      } finally {
        if (mountedRef.current && opts.seq === activePhotoSeqRef.current) {
          setAiBusy(false);
          setAiStageLabel(null);
        }
      }
    },
    [applyVisionToForm, t, toast],
  );

  // ── Bước 1: Web Worker nén snapshot <=1024px (120-220KB) + EXIF GPS -> 95 Xã/Phường (<100ms) -> AI Vision ──
  const onFile = useCallback(
    async (file: File) => {
      visionAbortRef.current?.abort();
      geocodeAbortRef.current?.abort();
      const seq = ++activePhotoSeqRef.current;

      setProcessing(true);
      setAiBusy(false);
      setAiWarning(null);
      setAiElapsedMs(null);
      setAiStageLabel('Đang nén ảnh & đọc EXIF GPS…');
      setVision(null);
      setPendingSuggestions(null);
      setLocalDup(null);
      setExifApplied(false);

      try {
        const p = await edge.processImage(file);
        if (!mountedRef.current || seq !== activePhotoSeqRef.current) {
          if (p.previewUrl.startsWith('blob:')) URL.revokeObjectURL(p.previewUrl);
          return;
        }
        replacePreviewUrl(p.previewUrl);
        const nextPhoto: PhotoState = {
          previewUrl: p.previewUrl,
          aiBlob: p.aiBlob,
          aiMimeType: p.aiMimeType,
          aiSha256: p.aiSha256,
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
        };
        setPhoto(nextPhoto);
        // Mở khóa form ngay sau bước nén ảnh Worker (<120ms) — không chặn người dùng gõ tay
        setProcessing(false);

        // 1. Trích xuất EXIF GPS & chuẩn hóa ngay 95 Xã/Phường Đồng Nai (<10ms)
        let resolvedWardHint = formValuesRef.current.wardCode || '';
        let coordsHint: { lat: number; lng: number } | null = null;
        if (p.exifGps?.inBounds) {
          coordsHint = { lat: p.exifGps.lat, lng: p.exifGps.lng };
          const instant = applyInstantCoordsToLocation(p.exifGps.lat, p.exifGps.lng, true, seq);
          if (instant?.inBounds) resolvedWardHint = instant.wardCode;
        } else {
          // Ảnh từ Zalo/Messenger bị xóa EXIF: fallback sang GPS trình duyệt bất đồng bộ (không block AI)
          if (fix) {
            coordsHint = { lat: fix.lat, lng: fix.lng };
            const instant = applyInstantCoordsToLocation(fix.lat, fix.lng, false, seq);
            if (instant?.inBounds) resolvedWardHint = instant.wardCode;
          } else {
            void locatePrecise().then((f) => {
              if (f && mountedRef.current && seq === activePhotoSeqRef.current && !p.exifGps?.inBounds) {
                applyInstantCoordsToLocation(f.lat, f.lng, false, seq);
              }
            });
          }
        }

        // 2. Chạy song song: kiểm tra trùng ảnh cục bộ trên IndexedDB (không chặn API AI)
        void (async () => {
          try {
            const known = (await db.reports.toArray()).flatMap((r) =>
              (r.photos ?? []).map((x) => ({
                id: r.id,
                dHash: x.dHash,
                ...(x.pHash ? { pHash: x.pHash } : {}),
                ...(x.subGridHashes ? { subGridHashes: x.subGridHashes } : {}),
                ...(x.colorHistogram ? { colorHistogram: x.colorHistogram } : {}),
              })),
            );
            if (!mountedRef.current || seq !== activePhotoSeqRef.current) return;
            const dupRes = await edge.duplicateMatch(
              {
                dHash: p.dHash,
                pHash: p.pHash,
                subGridHashes: p.subGridHashes,
                colorHistogram: p.colorHistogram,
              },
              known,
            );
            if (!mountedRef.current || seq !== activePhotoSeqRef.current) return;
            const firstDup = dupRes.matches.find((item) => item.isDuplicate);
            setLocalDup(firstDup ? firstDup.dHashDist : null);
          } catch {
            /* ignore local dup scan errors */
          }
        })();

        // 3. Kích hoạt ngay AI Vision phân tích ảnh (AbortController tự hủy nếu đổi ảnh)
        await runVisionAnalysis(nextPhoto, {
          seq,
          wardHint: resolvedWardHint || undefined,
          coordsHint,
        });
      } catch (err) {
        if (!mountedRef.current || seq !== activePhotoSeqRef.current) return;
        toast('error', t('report.photoFail'), err instanceof Error ? err.message : undefined);
        replacePreviewUrl(null);
        setPhoto(null);
        setProcessing(false);
        setAiBusy(false);
        setAiStageLabel(null);
      }
    },
    [applyInstantCoordsToLocation, fix, locatePrecise, replacePreviewUrl, runVisionAnalysis, t, toast],
  );

  const handleReanalyze = useCallback(() => {
    if (!photo || processing || aiBusy) return;
    const seq = activePhotoSeqRef.current;
    const coordsHint = pin ?? (photo.exifGps?.inBounds ? { lat: photo.exifGps.lat, lng: photo.exifGps.lng } : null);
    void runVisionAnalysis(photo, {
      seq,
      skipCache: true,
      wardHint: activeWardCode || undefined,
      coordsHint,
    });
  }, [activeWardCode, aiBusy, photo, pin, processing, runVisionAnalysis]);

  const applySingleSuggestion = useCallback((field: keyof PendingAiSuggestions) => {
    setPendingSuggestions((prev) => {
      if (!prev || prev[field] === undefined) return prev;
      const val = prev[field];
      if (field === 'category' && val) setCategory(val as Category);
      if (field === 'otherLabel' && typeof val === 'string') setOtherLabel(val);
      if (field === 'title' && typeof val === 'string') setTitle(val);
      if (field === 'description' && typeof val === 'string') setDescription(val);
      if (field === 'severity' && typeof val === 'number') setSeverity(val as 1 | 2 | 3 | 4 | 5);
      if (field === 'isEmergency' && typeof val === 'boolean') setIsEmergency(val);
      if (field === 'address' && typeof val === 'string') setAddress(val);
      const next = { ...prev };
      delete next[field];
      return Object.keys(next).length > 0 ? next : null;
    });
  }, []);

  const applyAllSuggestions = useCallback(() => {
    if (!pendingSuggestions) return;
    if (pendingSuggestions.category) setCategory(pendingSuggestions.category);
    if (pendingSuggestions.otherLabel !== undefined) setOtherLabel(pendingSuggestions.otherLabel);
    if (pendingSuggestions.title !== undefined) setTitle(pendingSuggestions.title);
    if (pendingSuggestions.description !== undefined) setDescription(pendingSuggestions.description);
    if (pendingSuggestions.severity !== undefined) setSeverity(pendingSuggestions.severity);
    if (pendingSuggestions.isEmergency !== undefined) setIsEmergency(pendingSuggestions.isEmergency);
    if (pendingSuggestions.address !== undefined) setAddress(pendingSuggestions.address);
    setPendingSuggestions(null);
  }, [pendingSuggestions]);

  const toggleMic = (): void => {
    if (listening) {
      stopListen.current?.();
      return;
    }
    setListening(true);
    stopListen.current = startListening(lang, {
      onText: (text) => {
        markDirty('description');
        setDescription(text);
      },
      onEnd: () => setListening(false),
      onError: (c) => toast('error', c === 'not-allowed' ? t('chat.micDenied') : t('chat.micError')),
    });
  };

  const handleManualWardStep1 = (wardCode: string): void => {
    markDirty('wardCode');
    setManualWardCode(wardCode);
    const w = WARD_BY_CODE[wardCode];
    if (w) {
      setPin({ lat: w.centerLat, lng: w.centerLng });
      setGeo({
        inBounds: true,
        ward: { wardCode: w.wardCode, name: w.name },
        arterial: null,
        nearby: [],
        needsConfirmation: false,
        source: 'local_fallback',
        matchedAlias: null,
      });
      if (!dirtyFieldsRef.current.has('address') && !address.trim()) {
        setAddress(`${w.name}, Thành phố Đồng Nai`);
      }
    }
  };

  const handleUserAddressChange = useCallback(
    (nextAddress: string) => {
      markDirty('address');
      setAddress(nextAddress);
    },
    [markDirty],
  );

  const handleUserWardChange = useCallback(
    (nextWardCode: string) => {
      if (nextWardCode) markDirty('wardCode');
      setManualWardCode(nextWardCode);
    },
    [markDirty],
  );

  const handlePickerAddressUpdate = useCallback((nextAddress: string) => {
    if (!dirtyFieldsRef.current.has('address')) {
      setAddress(nextAddress);
    }
  }, []);

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
    const editId = params.get('editOutbox');
    if (!editId) return;
    let alive = true;
    void (async () => {
      const item = await db.outboxQueue.get(editId);
      if (!alive || !item || (item.kind !== 'create_report' && item.kind !== 'proxy_report')) return;
      const p = (item.payload ?? {}) as Record<string, unknown>;
      dirtyFieldsRef.current.clear();
      if (typeof p.category === 'string') {
        setCategory(p.category as Category);
        dirtyFieldsRef.current.add('category');
      }
      if (typeof p.aiSuggestedLabel === 'string') {
        setOtherLabel(p.aiSuggestedLabel);
        dirtyFieldsRef.current.add('otherLabel');
      }
      if (typeof p.title === 'string') {
        setTitle(p.title);
        dirtyFieldsRef.current.add('title');
      }
      if (typeof p.description === 'string') {
        setDescription(p.description);
        dirtyFieldsRef.current.add('description');
      }
      if (typeof p.severity === 'number') setSeverity(p.severity as 1 | 2 | 3 | 4 | 5);
      if (typeof p.isEmergency === 'boolean') setIsEmergency(p.isEmergency);
      if (typeof p.lat === 'number' && typeof p.lng === 'number') {
        const instant = resolveInstantWardFromCoords(p.lat, p.lng);
        setPin({ lat: p.lat, lng: p.lng });
        if (instant.inBounds) setGeo(instant.geo);
      }
      if (typeof p.wardCode === 'string') {
        setManualWardCode(p.wardCode);
        dirtyFieldsRef.current.add('wardCode');
      }
      if (typeof p.address === 'string') {
        setAddress(p.address);
        dirtyFieldsRef.current.add('address');
      }
      setLeftScene(Boolean(p.leftScene));

      const displayBlob = p.displayBlob instanceof Blob ? p.displayBlob : null;
      const aiBlob = p.aiBlob instanceof Blob ? p.aiBlob : displayBlob;
      const legacyUrl =
        p.photo && typeof p.photo === 'object' && typeof (p.photo as { dataUrl?: unknown }).dataUrl === 'string'
          ? String((p.photo as { dataUrl: string }).dataUrl)
          : null;
      const previewUrl = displayBlob ? URL.createObjectURL(displayBlob) : legacyUrl;
      if (previewUrl && displayBlob && aiBlob) {
        replacePreviewUrl(previewUrl);
        const edgeStats = (p.edge as EdgeStatsMsg | undefined) ?? {
          blurScore: 80,
          brightness: 128,
          flatRatio: 0.15,
          aspect: 4 / 3,
          sharpEdgeDensity: 0.12,
          likelyScreenshot: false,
          screenshotConfidence: 0.1,
        };
        const exifMeta = (p.exif as ExtractedExifMetadata | undefined) ?? {
          capturedAt: null,
          cameraMake: null,
          cameraModel: null,
          software: null,
          gps: null,
        };
        setPhoto({
          previewUrl,
          aiBlob,
          aiMimeType: aiBlob.type || 'image/webp',
          aiSha256: '',
          displayBlob,
          dHash: typeof p.dHash === 'string' ? p.dHash : '0000000000000000',
          pHash: '',
          subGridHashes: [],
          colorHistogram: [],
          bytes: displayBlob.size,
          aiBytes: aiBlob.size,
          originalBytes: displayBlob.size,
          width: 800,
          height: 600,
          totalMs: 0,
          hashMs: 0,
          stats: edgeStats,
          exif: exifMeta,
          exifGps: exifMeta.gps ?? null,
        });
      }
      setEditingOutboxId(editId);
      setEditOutboxNotice(item.lastError || t('outbox.failedToast'));
      setSubmitted(null);
      setOutcome(null);
      setRejectedMessage(null);
      setStep(1);
    })();
    return () => {
      alive = false;
    };
  }, [params, replacePreviewUrl, t]);

  useEffect(() => {
    if (!submitted) return;
    let alive = true;
    void db.outboxQueue.toArray().then((list) => {
      if (!alive) return;
      const hit = list.find((o) => o.targetId === submitted.id);
      if (!hit) return;
      if (hit.state === 'failed') {
        setFailedOutboxId(hit.id);
        setRejectedMessage(hit.lastError || t('outbox.failedToast'));
        setRetryNotice(null);
      } else if (hit.attempts > 0 && hit.lastError) {
        setFailedOutboxId(hit.id);
        setRetryNotice({ outboxId: hit.id, message: hit.lastError, attempts: hit.attempts });
      }
    });
    const onEv = (e: Event): void => {
      const d = (e as CustomEvent<SyncEventDetail>).detail;
      if (d.type === 'report_result' && d.localId === submitted.id) {
        setRejectedMessage(null);
        setRetryNotice(null);
        setFailedOutboxId(null);
        setOutcome({ code: d.messageCode, report: d.report });
      } else if (d.type === 'item_retrying' && d.item.targetId === submitted.id) {
        setFailedOutboxId(d.item.id);
        setRetryNotice({ outboxId: d.item.id, message: d.message, attempts: d.item.attempts });
      } else if (d.type === 'item_failed' && d.item.targetId === submitted.id) {
        setRetryNotice(null);
        setFailedOutboxId(d.item.id);
        setRejectedMessage(d.message);
      }
    };
    syncBus.addEventListener('sync', onEv);
    return () => {
      alive = false;
      syncBus.removeEventListener('sync', onEv);
    };
  }, [submitted, t]);

  const submit = async (): Promise<void> => {
    if (submitting || !photo || !pin || !category) return;
    if (!session && online) {
      if (!(await requireAuth())) return;
    }
    setSubmitting(true);
    setRejectedMessage(null);
    setRetryNotice(null);
    setFailedOutboxId(null);
    try {
      const finalWardCode = activeWardCode || nearestWard(pin.lat, pin.lng).wardCode;
      const finalWardName = WARD_BY_CODE[finalWardCode]?.name ?? nearestWard(pin.lat, pin.lng).name;
      const prevEditId = editingOutboxId;
      const rep = await submitReport(
        {
          category,
          aiSuggestedLabel: category === 'khac' ? (otherLabel.trim() || vision?.aiSuggestedLabel || null) : null,
          title: title.trim(),
          description: description.trim(),
          severity,
          isEmergency,
          lat: pin.lat,
          lng: pin.lng,
          wardCode: finalWardCode,
          address: address.trim() || `${finalWardName}, TP. Đồng Nai`,
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
      if (prevEditId) {
        await discardOutboxItem(prevEditId);
        setEditingOutboxId(null);
        setEditOutboxNotice(null);
      }
      setSubmitted(rep);
      if (!online) toast('info', t('report.savedOffline'), t('report.savedOfflineText'));
    } catch (err) {
      toast('error', t('report.submitFail'), err instanceof Error ? err.message : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  const reset = (): void => {
    visionAbortRef.current?.abort();
    geocodeAbortRef.current?.abort();
    activePhotoSeqRef.current += 1;
    dirtyFieldsRef.current.clear();
    setStep(1);
    replacePreviewUrl(null);
    setPhoto(null);
    setVision(null);
    setAiBusy(false);
    setAiElapsedMs(null);
    setAiStageLabel(null);
    setAiWarning(null);
    setPendingSuggestions(null);
    setCategory(null);
    setOtherLabel('');
    setTitle('');
    setDescription('');
    setSeverity(3);
    setIsEmergency(false);
    setPin(null);
    setExifApplied(false);
    setAddress('');
    setGeo(null);
    setManualWardCode('');
    setLeftScene(false);
    setSubmitted(null);
    setOutcome(null);
    setRejectedMessage(null);
    setRetryNotice(null);
    setFailedOutboxId(null);
    setEditingOutboxId(null);
    setEditOutboxNotice(null);
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
      const targetOutboxId = failedOutboxId ?? submitted.id;
      return (
        <div className="card space-y-4 border border-warn/40 bg-warn-soft/30 p-5 text-center" role="alert">
          <ShieldAlert className="mx-auto h-12 w-12 text-warn" aria-hidden />
          <h1 className="text-xl font-extrabold text-ink">{t('report.sendFailedTitle')}</h1>
          <p className="rounded-xl bg-surface p-3 text-sm font-medium text-ink">{rejectedMessage}</p>
          <div className="grid gap-2 sm:grid-cols-3">
            <button
              type="button"
              onClick={() => {
                if (failedOutboxId) setEditingOutboxId(failedOutboxId);
                setEditOutboxNotice(rejectedMessage);
                setSubmitted(null);
                setOutcome(null);
                setRejectedMessage(null);
                setStep(1);
              }}
              className="btn btn-primary"
            >
              <Pencil className="h-4 w-4" aria-hidden /> {t('report.sendFailedEdit')}
            </button>
            <button
              type="button"
              onClick={() => {
                setRejectedMessage(null);
                void retryFailed(targetOutboxId);
              }}
              className="btn btn-ghost"
            >
              <RefreshCw className="h-4 w-4" aria-hidden /> {t('report.sendFailedRetry')}
            </button>
            <button
              type="button"
              onClick={() => {
                void discardOutboxItem(targetOutboxId);
                reset();
              }}
              className="btn btn-ghost text-danger"
            >
              <Trash2 className="h-4 w-4" aria-hidden /> {t('report.sendFailedRemove')}
            </button>
          </div>
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
        {!outcome && retryNotice && (
          <div className="space-y-2 rounded-xl border border-warn/40 bg-warn-soft/40 p-3 text-left text-sm" role="status">
            <p className="font-bold text-warn">{t('report.retryingTitle', { n: retryNotice.attempts })}</p>
            <p className="text-ink">{retryNotice.message}</p>
            <div className="grid gap-2 pt-1 sm:grid-cols-3">
              <button
                type="button"
                onClick={() => {
                  setEditingOutboxId(retryNotice.outboxId);
                  setEditOutboxNotice(retryNotice.message);
                  setSubmitted(null);
                  setOutcome(null);
                  setRetryNotice(null);
                  setStep(1);
                }}
                className="btn btn-primary"
              >
                <Pencil className="h-4 w-4" aria-hidden /> {t('report.sendFailedEdit')}
              </button>
              <button
                type="button"
                onClick={() => void retryFailed(retryNotice.outboxId)}
                className="btn btn-ghost"
              >
                <RefreshCw className="h-4 w-4" aria-hidden /> {t('report.sendFailedRetry')}
              </button>
              <button
                type="button"
                onClick={() => {
                  void discardOutboxItem(retryNotice.outboxId);
                  reset();
                }}
                className="btn btn-ghost text-danger"
              >
                <Trash2 className="h-4 w-4" aria-hidden /> {t('report.sendFailedRemove')}
              </button>
            </div>
          </div>
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
  const authLow = Boolean(
    vision &&
      (vision.authenticityScore < 60 ||
        vision.decision === 'HUMAN_REVIEW' ||
        vision.needsManualReview ||
        vision.degraded ||
        (vision.forensicFlags?.length ?? 0) > 0),
  );

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
          {editOutboxNotice && (
            <p role="status" className="flex gap-2 rounded-xl bg-warn-soft p-3 text-sm font-semibold text-warn">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {t('report.editOutboxBanner', { reason: editOutboxNotice })}
            </p>
          )}
          {!photo && !processing && <PhotoExamples />}
          <CameraCapture onFile={(f) => void onFile(f)} disabled={processing} autoStart={autoCapture && !photo} />

          {processing && (
            <div className="card space-y-2 p-4" role="status">
              <div className="flex items-center gap-3">
                <Spinner className="text-brand" />
                <p className="text-sm font-semibold">{aiStageLabel ?? t('report.processing')}</p>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                <div className="h-full w-1/2 animate-pulse rounded-full bg-brand" />
              </div>
            </div>
          )}

          {photo && (
            <div className="card space-y-3 p-3">
              <img
                src={photo.previewUrl}
                alt={t('report.photoAlt')}
                width={640}
                height={480}
                loading="lazy"
                decoding="async"
                className="aspect-[4/3] w-full rounded-xl object-cover"
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted">
                  Ảnh tối ưu ({photo.width}×{photo.height} · {(photo.bytes / 1024).toFixed(0)} KB / AI{' '}
                  {(photo.aiBytes / 1024).toFixed(0)} KB,{' '}
                  {t('report.saved', { p: Math.max(0, Math.round((1 - photo.bytes / photo.originalBytes) * 100)) })})
                </p>
                <button
                  type="button"
                  onClick={handleReanalyze}
                  disabled={aiBusy || processing}
                  className="btn btn-soft !min-h-8 !px-2.5 !text-xs font-semibold"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${aiBusy ? 'animate-spin' : ''}`} aria-hidden />
                  {t('report.reanalyze')}
                </button>
              </div>

              {exifApplied && activeWard && (
                <p className="flex items-center gap-2 rounded-xl bg-brand-soft px-3 py-2 text-xs font-semibold text-brand">
                  <MapPin className="h-4 w-4 shrink-0" aria-hidden />
                  <span>
                    EXIF GPS → <strong className="font-bold">{activeWard.name}</strong>
                    {address ? ` (${address})` : ''}
                  </span>
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

              {photo.stats.blurScore < 12 && (
                <p role="alert" className="flex gap-2 rounded-xl bg-warn-soft p-3 text-sm font-semibold text-warn">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  {t('report.blurWarn')}
                </p>
              )}

              {photo.stats.likelyScreenshot && (
                <p role="status" className="flex gap-2 rounded-xl bg-warn-soft p-3 text-sm font-semibold text-warn">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  {t('report.screenshotSoftWarn', {
                    pct: Math.round((photo.stats.screenshotConfidence ?? 0.7) * 100),
                  })}
                </p>
              )}

              {aiBusy && (
                <div className="space-y-1.5 rounded-xl bg-brand-soft/60 p-2.5" role="status">
                  <p className="flex items-center gap-2 text-xs font-semibold text-brand">
                    <Sparkles className="h-4 w-4 animate-pulse shrink-0" aria-hidden />
                    {aiStageLabel ?? t('report.aiBusy')}
                  </p>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface">
                    <div className="h-full w-2/3 animate-pulse rounded-full bg-brand" />
                  </div>
                </div>
              )}

              {aiWarning && !aiBusy && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-warn/40 bg-warn-soft px-3 py-2 text-xs font-semibold text-warn" role="status">
                  <span>{aiWarning}</span>
                  <button
                    type="button"
                    onClick={handleReanalyze}
                    className="btn btn-ghost !min-h-7 !px-2 !text-xs font-bold"
                  >
                    <RefreshCw className="h-3 w-3" aria-hidden /> {t('report.reanalyze')}
                  </button>
                </div>
              )}

              {vision && (
                <div
                  className={`space-y-1 rounded-xl p-3 text-sm ${
                    vision.abuseRisk === 'HIGH'
                      ? 'bg-danger-soft text-danger'
                      : authLow
                        ? 'bg-warn-soft text-warn'
                        : 'bg-ok-soft text-ok'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="flex items-center gap-2 font-bold">
                      {vision.abuseRisk === 'HIGH' ? (
                        <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
                      ) : authLow ? (
                        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                      ) : (
                        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
                      )}
                      {authLow ? t('report.authLow') : t('report.authOk')} ·{' '}
                      <span className="mono">{vision.authenticityScore}/100</span>
                    </p>
                    {aiElapsedMs !== null && (
                      <span className="mono text-[11px] font-semibold opacity-90">
                        {vision.cached
                          ? t('report.aiCacheHit', { ms: aiElapsedMs })
                          : t('report.aiCompletedMs', { s: (aiElapsedMs / 1000).toFixed(2) })}
                      </span>
                    )}
                  </div>
                  {vision.abuseRisk === 'HIGH' && vision.citizenFeedback ? (
                    <p className="text-xs font-medium">{vision.citizenFeedback}</p>
                  ) : authLow ? (
                    <p className="text-xs font-medium">{t('report.softFlagCitizenNote')}</p>
                  ) : null}
                </div>
              )}
            </div>
          )}

          {photo && (
            <div className="card space-y-3 p-3">
              {pendingSuggestions && (
                <div className="space-y-2 rounded-xl border border-brand/40 bg-brand-soft/60 p-2.5 text-xs" role="status">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="flex items-center gap-1.5 font-bold text-brand">
                      <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      {t('report.aiSuggestionReady')}
                    </p>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={applyAllSuggestions}
                        className="btn btn-primary !min-h-7 !px-2.5 !text-[11px]"
                      >
                        <Check className="h-3 w-3" aria-hidden />
                        {t('report.applyAllSuggestions')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingSuggestions(null)}
                        className="btn btn-ghost !min-h-7 !px-2 !text-[11px]"
                        aria-label={t('report.dismissSuggestion')}
                      >
                        <X className="h-3 w-3" aria-hidden />
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <fieldset>
                <div className="flex items-center justify-between gap-2">
                  <legend className="label">{t('report.category')}</legend>
                  {pendingSuggestions?.category && (
                    <button
                      type="button"
                      onClick={() => applySingleSuggestion('category')}
                      className="text-[11px] font-bold text-brand underline"
                    >
                      {t('report.applySuggestion')}: {t(CATEGORY_META[pendingSuggestions.category].labelKey)}
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {CATS.map((c) => {
                    const Icon = CATEGORY_META[c].icon;
                    return (
                      <button
                        key={c}
                        type="button"
                        aria-pressed={category === c}
                        onClick={() => {
                          markDirty('category');
                          setCategory(c);
                        }}
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
                    onChange={(e) => {
                      markDirty('otherLabel');
                      setOtherLabel(e.target.value);
                    }}
                  />
                  {pendingSuggestions?.otherLabel && (
                    <button
                      type="button"
                      onClick={() => applySingleSuggestion('otherLabel')}
                      className="mt-1 text-left text-[11px] font-semibold text-brand underline"
                    >
                      {t('report.applySuggestion')}: “{pendingSuggestions.otherLabel}”
                    </button>
                  )}
                </div>
              )}

              <div>
                <label htmlFor="ttl" className="label">
                  {t('report.titleField')}
                </label>
                <input
                  id="ttl"
                  className="field"
                  value={title}
                  maxLength={140}
                  onChange={(e) => {
                    markDirty('title');
                    setTitle(e.target.value);
                  }}
                />
                {pendingSuggestions?.title && (
                  <button
                    type="button"
                    onClick={() => applySingleSuggestion('title')}
                    className="mt-1 text-left text-[11px] font-semibold text-brand underline"
                  >
                    {t('report.applySuggestion')}: “{pendingSuggestions.title}”
                  </button>
                )}
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
                    onChange={(e) => {
                      markDirty('description');
                      setDescription(e.target.value);
                    }}
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
                {pendingSuggestions?.description && (
                  <button
                    type="button"
                    onClick={() => applySingleSuggestion('description')}
                    className="mt-1 text-left text-[11px] font-semibold text-brand underline"
                  >
                    {t('report.applySuggestion')}: “{pendingSuggestions.description.slice(0, 90)}…”
                  </button>
                )}
              </div>

              {/* Mức độ khẩn cấp (auto-fill bởi AI, cho phép người dân chỉnh mà không bị ghi đè) */}
              <div className="space-y-2 rounded-xl border border-line bg-surface-2/60 p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-bold text-ink">{t('report.urgencyLevel')}</span>
                  {pendingSuggestions?.severity !== undefined && (
                    <button
                      type="button"
                      onClick={() => applySingleSuggestion('severity')}
                      className="text-[11px] font-bold text-brand underline"
                    >
                      {t('report.applySuggestion')}: {pendingSuggestions.severity}/5
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-5 gap-1">
                  {SEVERITY_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      aria-pressed={severity === opt.value}
                      onClick={() => {
                        markDirty('severity');
                        setSeverity(opt.value);
                        if (opt.value === 5 && !dirtyFieldsRef.current.has('isEmergency')) {
                          setIsEmergency(true);
                        }
                      }}
                      className={`rounded-lg px-1.5 py-1.5 text-[11px] font-bold transition-colors ${
                        severity === opt.value
                          ? opt.value >= 5
                            ? 'bg-danger text-white'
                            : 'bg-brand text-brand-ink'
                          : 'bg-surface text-muted hover:text-ink'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <label className="flex items-center gap-2 pt-0.5 text-xs font-semibold text-ink">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-danger"
                    checked={isEmergency}
                    onChange={(e) => {
                      markDirty('isEmergency');
                      setIsEmergency(e.target.checked);
                    }}
                  />
                  <span className={isEmergency ? 'text-danger' : ''}>{t('report.emergencyToggle')}</span>
                </label>
              </div>

              {/* Địa bàn 95 Phường/Xã Đồng Nai & Gợi ý địa chỉ tự điền tức thì từ EXIF/GPS/AI */}
              <div className="grid gap-2.5 sm:grid-cols-2">
                <div>
                  <label htmlFor="rp-ward-step1" className="label text-xs">
                    {t('report.wardSelect')}
                  </label>
                  <select
                    id="rp-ward-step1"
                    className="field !min-h-11 text-sm"
                    value={activeWardCode}
                    onChange={(e) => handleManualWardStep1(e.target.value)}
                  >
                    <option value="">{t('scope.other')}</option>
                    <optgroup label={t('scope.groupPhuong')}>
                      {WARDS_PHUONG.map((w) => (
                        <option key={w.wardCode} value={w.wardCode}>
                          {w.name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label={t('scope.groupXa')}>
                      {WARDS_XA.map((w) => (
                        <option key={w.wardCode} value={w.wardCode}>
                          {w.name}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </div>
                <div>
                  <label htmlFor="rp-addr-step1" className="label text-xs">
                    {t('report.addressHintField')}
                  </label>
                  <input
                    id="rp-addr-step1"
                    className="field !min-h-11 text-sm"
                    value={address}
                    maxLength={240}
                    placeholder={t('report.addressHintPlaceholder')}
                    onChange={(e) => handleUserAddressChange(e.target.value)}
                  />
                  {pendingSuggestions?.address && (
                    <button
                      type="button"
                      onClick={() => applySingleSuggestion('address')}
                      className="mt-1 text-left text-[11px] font-semibold text-brand underline"
                    >
                      {t('report.applySuggestion')}: “{pendingSuggestions.address}”
                    </button>
                  )}
                </div>
              </div>

              {vision && (
                <p className="text-xs text-muted">
                  {t('report.severity')}: <span className="mono font-bold text-ink">{severity}/5</span>{' '}
                  {isEmergency && <span className="font-bold text-danger">· {t('report.emergencyAi')}</span>}
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
              onAddressChange={handlePickerAddressUpdate}
              geo={geo}
              onGeoChange={setGeo}
              manualWardCode={manualWardCode}
              onManualWardChange={handleUserWardChange}
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
            {geo?.arterial && isEmergency && (
              <p className="flex items-start gap-2 rounded-xl bg-danger-soft p-3 text-sm font-bold text-danger">
                <Flame className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                {t('report.emergencyPreview', { name: geo.arterial.name })}
              </p>
            )}
            {(authLow || photo.stats.likelyScreenshot) && (
              <p className="rounded-xl bg-warn-soft p-3 text-sm font-semibold text-warn">{t('report.softReviewPreview')}</p>
            )}
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
