import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Crosshair, Flame, Loader2, MapPin, Mic, MicOff, ShieldAlert, Sparkles, ThumbsUp } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { DUPLICATE_SCAN_RADIUS_M, GPS_WARN_M } from '@shared/constants';
import { haversineMeters, inDongNaiBBox, matchArterial, nearestWard } from '@shared/geo';
import type { Category, ClientReport, ReverseGeocodeResult, VisionResult } from '@shared/types';
import { CameraCapture } from '../components/CameraCapture';
import { MapView } from '../components/MapView';
import { PhotoExamples } from '../components/PhotoExamples';
import { Spinner } from '../components/ui';
import { DONG_NAI_WARDS, WARD_BY_CODE } from '../data/dongNaiWards';
import { db } from '../db/localDb';
import { useOnline } from '../db/hooks';
import { syncBus, type SyncEventDetail } from '../db/sync';
import { usePreciseLocation } from '../hooks/usePreciseLocation';
import { useI18n, type I18nKey } from '../i18n';
import { api, ApiError, NetworkError } from '../lib/api';
import { useSession } from '../lib/authStore';
import { edge } from '../lib/edgeClient';
import { QUICK_PLACES, reverseGeocode } from '../lib/geoClient';
import { localVision } from '../lib/localVision';
import { CATEGORY_META } from '../lib/meta';
import { speechRecognitionSupported, startListening } from '../lib/speech';
import { confirmReport, attachAngle, submitReport } from '../lib/submitReport';
import { useAuthGate } from '../state/authGate';
import { useSettings } from '../state/settings';
import { useToast } from '../state/toast';
import type { EdgeStatsMsg, ExifGpsCoords } from '../workers/edgeProcessor.worker';

interface PhotoState {
  dataUrl: string;
  dHash: string;
  bytes: number;
  originalBytes: number;
  width: number;
  height: number;
  totalMs: number;
  hashMs: number;
  stats: EdgeStatsMsg;
  exifGps: ExifGpsCoords | null;
}

interface GeoInfo {
  inBounds: boolean;
  ward: { wardCode: string; name: string };
  arterial: { name: string; distanceM: number } | null;
  nearby: Array<{ id: string; distanceM: number; clusterCount: number }>;
  needsConfirmation: boolean;
  source: ReverseGeocodeResult['source'];
  matchedAlias: string | null;
}

const CATS: Category[] = ['rac_thai', 'den_duong', 'ngap_nuoc', 'mat_duong'];
const WARDS_PHUONG = DONG_NAI_WARDS.filter((w) => w.kind === 'Phường');
const WARDS_XA = DONG_NAI_WARDS.filter((w) => w.kind === 'Xã');

function StepDots({ step }: { step: number }) {
  const { t } = useI18n();
  const labels: I18nKey[] = ['report.step1', 'report.step2', 'report.step3'];
  return (
    <ol className="grid grid-cols-3 gap-2" aria-label={t('report.steps')}>
      {labels.map((k, i) => (
        <li key={k} className="min-w-0" aria-current={step === i + 1 ? 'step' : undefined}>
          <div className={`h-1.5 rounded-full ${i + 1 <= step ? 'bg-brand' : 'bg-line'}`} />
          <p className={`mt-1 truncate text-xs font-semibold ${i + 1 === step ? 'text-brand' : 'text-muted'}`}>{i + 1}. {t(k)}</p>
        </li>
      ))}
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
  const proxy = params.get('proxy') === '1' && session?.user.role === 'volunteer';
  const autoCapture = params.get('capture') === '1';

  const [step, setStep] = useState(1);
  // Bước 1
  const [photo, setPhoto] = useState<PhotoState | null>(null);
  const [processing, setProcessing] = useState(false);
  const [vision, setVision] = useState<VisionResult | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [category, setCategory] = useState<Category | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [localDup, setLocalDup] = useState<number | null>(null);
  const [listening, setListening] = useState(false);
  const stopListen = useRef<(() => void) | null>(null);

  // Bước 2: GPS chính xác cao (watchPosition) + Center Crosshair Pin + 3-tier Reverse Geocoding
  const { fix, status: gpsStatus, samples: gpsSamples, isLowAccuracy, locate: locatePrecise } = usePreciseLocation();
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [mapFocus, setMapFocus] = useState<{ center: [number, number]; zoom: number } | null>(null);
  const [exifApplied, setExifApplied] = useState(false);
  const [address, setAddress] = useState('');
  const [geo, setGeo] = useState<GeoInfo | null>(null);
  const [manualWardCode, setManualWardCode] = useState<string>('');
  const [leftScene, setLeftScene] = useState(false);

  // Bước 3
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<ClientReport | null>(null);
  const [outcome, setOutcome] = useState<{ code: string; report: ClientReport } | null>(null);

  useEffect(() => () => stopListen.current?.(), []);

  // ── Bước 1: Web Worker nén ảnh + trích xuất EXIF GPS + dHash → Gemini Zero-Typing ──
  const onFile = useCallback(async (file: File) => {
    setProcessing(true);
    setVision(null);
    setLocalDup(null);
    setExifApplied(false);
    try {
      const p = await edge.processImage(file);
      setPhoto({
        dataUrl: p.dataUrl,
        dHash: p.dHash,
        bytes: p.bytes,
        originalBytes: p.originalBytes,
        width: p.width,
        height: p.height,
        totalMs: p.timings.totalMs,
        hashMs: p.timings.hashMs,
        stats: p.stats,
        exifGps: p.exifGps,
      });

      // Tự động đặt ghim nếu ảnh gốc có EXIF GPS hợp lệ thuộc Thành phố Đồng Nai
      if (p.exifGps?.inBounds) {
        setPin({ lat: p.exifGps.lat, lng: p.exifGps.lng });
        setMapFocus({ center: [p.exifGps.lat, p.exifGps.lng], zoom: 17 });
        setExifApplied(true);
      }

      // Tầng Edge chống spam: so với ảnh đang có trên thiết bị
      const known = (await db.reports.toArray()).flatMap((r) => r.photos.map((x) => ({ id: r.id, hash: x.dHash })));
      const m = await edge.hammingMatch(p.dHash, known);
      setLocalDup(m.matches[0] && m.matches[0].distance <= 5 ? m.matches[0].distance : null);

      setAiBusy(true);
      let v: VisionResult | null = null;
      const cached = await db.aiVisionCache.get(p.dHash);
      if (cached) v = { ...cached.result, cached: true };
      if (!v && navigator.onLine) {
        try {
          v = await api<VisionResult>('/api/ai/analyze-image', {
            body: {
              image: { dataUrl: p.dataUrl, dHash: p.dHash },
              ...(category ? { category } : {}),
              hintText: `${title} ${description}`.trim() || undefined,
              edge: p.stats,
            },
            timeoutMs: 40000,
          });
          if (v.mode === 'gemini') await db.aiVisionCache.put({ dHash: p.dHash, result: v, at: Date.now() });
        } catch (err) {
          if (err instanceof ApiError && err.status === 429) toast('info', t('report.aiLimit'), err.message);
          else if (!(err instanceof NetworkError)) console.warn('AI Vision lỗi, dùng bộ phân loại cục bộ:', err);
        }
      }
      if (!v) v = localVision(category, `${title} ${description}`, p.stats);
      setVision(v);
      setCategory((c) => c ?? v!.category);
      setTitle((x) => x || v!.title);
      setDescription((x) => x || v!.description);
    } catch (err) {
      toast('error', t('report.photoFail'), err instanceof Error ? err.message : undefined);
      setPhoto(null);
    } finally {
      setProcessing(false);
      setAiBusy(false);
    }
  }, [category, title, description, toast, t]);

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

  // ── Bước 2: Định vị GPS đa mẫu (watchPosition) + Center Crosshair + quét trùng 100m ──
  const locate = useCallback(async () => {
    const f = await locatePrecise();
    if (f) {
      setPin({ lat: f.lat, lng: f.lng });
      setMapFocus({ center: [f.lat, f.lng], zoom: 17 });
      setManualWardCode('');
    }
  }, [locatePrecise]);

  useEffect(() => {
    if (step === 2 && gpsStatus === 'idle' && !exifApplied) {
      void locate();
    }
  }, [step, gpsStatus, exifApplied, locate]);

  const handleCrosshairMove = useCallback((lat: number, lng: number) => {
    setPin({ lat, lng });
  }, []);

  useEffect(() => {
    if (!pin) return;
    let cancelled = false;
    const ctrl = new AbortController();
    const id = window.setTimeout(async () => {
      const fallbackWard = nearestWard(pin.lat, pin.lng);
      const [g, rows] = await Promise.all([
        reverseGeocode(pin.lat, pin.lng, ctrl.signal),
        db.reports.toArray(),
      ]);
      if (cancelled) return;
      setAddress(g.address);
      const resolvedWard = {
        wardCode: g.wardCode ?? fallbackWard.wardCode,
        name: g.wardName ?? fallbackWard.name,
      };
      try {
        const scan = await edge.geoScan({
          lat: pin.lat,
          lng: pin.lng,
          category,
          radiusM: DUPLICATE_SCAN_RADIUS_M,
          candidates: rows.map((r) => ({
            id: r.id,
            lat: r.lat,
            lng: r.lng,
            category: r.category,
            status: r.status,
            clusterCount: r.clusterCount,
          })),
        });
        if (!cancelled) {
          setGeo({
            inBounds: g.inBounds && scan.inBounds,
            ward: resolvedWard,
            arterial: g.arterial ?? scan.arterial,
            nearby: scan.nearby,
            needsConfirmation: g.needsConfirmation,
            source: g.source,
            matchedAlias: g.matchedAlias,
          });
        }
      } catch (err) {
        console.warn('Worker quét trùng lỗi, dùng tính toán trực tiếp:', err);
        if (!cancelled) {
          setGeo({
            inBounds: g.inBounds && inDongNaiBBox(pin.lat, pin.lng),
            ward: resolvedWard,
            arterial: g.arterial ?? matchArterial(pin.lat, pin.lng),
            nearby: [],
            needsConfirmation: g.needsConfirmation,
            source: g.source,
            matchedAlias: g.matchedAlias,
          });
        }
      }
    }, 350);
    return () => {
      cancelled = true;
      ctrl.abort();
      window.clearTimeout(id);
    };
  }, [pin, category]);

  const activeWardCode = manualWardCode || geo?.ward.wardCode || (pin ? nearestWard(pin.lat, pin.lng).wardCode : '');
  const activeWard = activeWardCode ? WARD_BY_CODE[activeWardCode] : undefined;
  const mismatchM = fix && pin ? haversineMeters(pin.lat, pin.lng, fix.lat, fix.lng) : null;
  const mismatch = mismatchM !== null && mismatchM > GPS_WARN_M;
  const nearest = geo?.nearby[0];

  const useNearby = async (mode: 'confirm' | 'attach'): Promise<void> => {
    if (!nearest || !photo) return;
    if (!(await requireAuth())) return;
    const target = await db.reports.get(nearest.id);
    if (!target) return;
    if (mode === 'confirm') await confirmReport(target);
    else await attachAngle(target, { dataUrl: photo.dataUrl, dHash: photo.dHash });
    toast('success', mode === 'confirm' ? t('detail.confirmed') : t('detail.attachOk'), t('report.nearbyDone'));
    nav('/mine');
  };

  // ── Bước 3: gửi (Local-First, Outbox) ─────────────────────────────────────────
  useEffect(() => {
    if (!submitted) return;
    const onEv = (e: Event): void => {
      const d = (e as CustomEvent<SyncEventDetail>).detail;
      if (d.type === 'report_result' && d.localId === submitted.id) setOutcome({ code: d.messageCode, report: d.report });
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
    try {
      const finalWardCode = activeWardCode || nearestWard(pin.lat, pin.lng).wardCode;
      const finalWardName = WARD_BY_CODE[finalWardCode]?.name ?? nearestWard(pin.lat, pin.lng).name;
      const rep = await submitReport({
        category,
        title: title.trim(),
        description: description.trim(),
        lat: pin.lat,
        lng: pin.lng,
        wardCode: finalWardCode,
        address: address || `${finalWardName}, TP. Đồng Nai`,
        photo: { dataUrl: photo.dataUrl, dHash: photo.dHash },
        deviceLat: fix?.lat,
        deviceLng: fix?.lng,
        leftScene,
        seniorSubmitted: settings.senior || proxy,
        edge: photo.stats,
        vision,
      }, proxy);
      setSubmitted(rep);
      if (!online) toast('info', t('report.savedOffline'), t('report.savedOfflineText'));
    } catch (err) {
      toast('error', t('report.submitFail'), err instanceof Error ? err.message : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  const reset = (): void => {
    setStep(1); setPhoto(null); setVision(null); setCategory(null); setTitle(''); setDescription('');
    setPin(null); setMapFocus(null); setExifApplied(false); setGeo(null); setManualWardCode('');
    setLeftScene(false); setSubmitted(null); setOutcome(null); setLocalDup(null);
  };

  if (session && (session.user.role === 'ward_officer' || session.user.role === 'city_admin')) {
    return (
      <div className="card p-6 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-warn" aria-hidden />
        <p className="mt-2 font-bold">{t('report.staffBlocked')}</p>
        <Link to="/admin" className="btn btn-primary mt-4">{t('nav.admin')}</Link>
      </div>
    );
  }

  // ── Màn hình kết quả ──────────────────────────────────────────────────────────
  if (submitted) {
    const code = outcome?.code;
    const quarantined = code?.startsWith('quarantine');
    return (
      <div className="card space-y-4 p-5 text-center" role="status">
        {!outcome ? <Loader2 className="mx-auto h-12 w-12 animate-spin text-brand" aria-hidden /> : quarantined ? <ShieldAlert className="mx-auto h-12 w-12 text-warn" aria-hidden /> : code === 'emergency' ? <Flame className="mx-auto h-12 w-12 text-danger" aria-hidden /> : <CheckCircle2 className="mx-auto h-12 w-12 text-ok" aria-hidden />}
        <h1 className="text-xl font-extrabold">
          {!outcome ? (online ? (session ? t('result.sending') : t('result.pendingAuth')) : t('result.pendingOffline')) : t(`result.${code as 'created'}` as I18nKey)}
        </h1>
        {outcome && <p className="mono text-lg font-bold text-brand">{outcome.report.code}</p>}
        {outcome?.code === 'merged' && <p className="text-sm text-muted">{t('result.mergedDetail', { n: outcome.report.clusterCount })}</p>}
        {outcome?.code === 'emergency' && <p className="text-sm font-semibold text-danger">{t('result.emergencyDetail')}</p>}
        {!outcome && <p className="text-sm text-muted">{t('result.localSaved')} <span className="mono">{submitted.code}</span></p>}
        {!session && !outcome && <Link to="/auth" className="btn btn-primary w-full">{t('offline.loginToSend')}</Link>}
        <div className="grid gap-2 sm:grid-cols-2">
          <Link to="/mine" className="btn btn-primary">{t('result.viewMine')}</Link>
          <button type="button" className="btn btn-ghost" onClick={reset}>{t('result.another')}</button>
        </div>
      </div>
    );
  }

  const step1Ok = !!photo && !!category && title.trim().length >= 3 && !processing;
  const step2Ok = !!pin && !!geo?.inBounds && !!activeWardCode;
  const authLow = vision && vision.authenticityScore < 45;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-extrabold">{proxy ? t('report.proxyTitle') : t('report.title')}</h1>
        {proxy && <p className="mt-1 rounded-xl bg-brand-soft p-2 text-sm font-semibold text-brand">{t('report.proxyNote')}</p>}
      </div>
      <StepDots step={step} />

      {step === 1 && (
        <section className="space-y-4" aria-labelledby="s1">
          <h2 id="s1" className="sr-only">{t('report.step1')}</h2>
          {!photo && !processing && <PhotoExamples />}
          <CameraCapture onFile={(f) => void onFile(f)} disabled={processing} autoStart={autoCapture && !photo} />

          {processing && (
            <div className="card flex items-center gap-3 p-4" role="status"><Spinner className="text-brand" /><p className="text-sm font-semibold">{t('report.processing')}</p></div>
          )}

          {photo && (
            <div className="card space-y-3 p-3">
              <img src={photo.dataUrl} alt={t('report.photoAlt')} className="aspect-[4/3] w-full rounded-xl object-cover" />
              <p className="mono text-[11px] leading-relaxed text-muted">
                {photo.width}×{photo.height} · {(photo.bytes / 1024).toFixed(0)} KB ({t('report.saved', { p: Math.max(0, Math.round((1 - photo.bytes / photo.originalBytes) * 100)) })}) · dHash {photo.dHash} · Worker {photo.totalMs.toFixed(0)}ms (hash {photo.hashMs.toFixed(1)}ms)
              </p>
              {exifApplied && (
                <p className="flex items-center gap-2 rounded-xl bg-brand-soft px-3 py-2 text-xs font-semibold text-brand">
                  <MapPin className="h-4 w-4 shrink-0" aria-hidden /> {t('report.exifFound')}
                </p>
              )}
              {localDup !== null && (
                <p role="alert" className="flex gap-2 rounded-xl bg-warn-soft p-3 text-sm font-semibold text-warn"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{t('report.localDup', { d: localDup })}</p>
              )}
              {photo.stats.blurScore < 25 && (
                <p role="alert" className="flex gap-2 rounded-xl bg-warn-soft p-3 text-sm font-semibold text-warn"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{t('report.blurWarn')}</p>
              )}
              {aiBusy && <p className="flex items-center gap-2 text-sm font-semibold text-brand" role="status"><Sparkles className="h-4 w-4 animate-pulse" aria-hidden />{t('report.aiBusy')}</p>}
              {vision && (
                <div className={`rounded-xl p-3 text-sm ${authLow ? 'bg-danger-soft text-danger' : 'bg-ok-soft text-ok'}`}>
                  <p className="flex items-center gap-2 font-bold">
                    {authLow ? <ShieldAlert className="h-4 w-4" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}
                    {authLow ? t('report.authLow') : t('report.authOk')} · <span className="mono">{vision.authenticityScore}/100</span>
                  </p>
                  {vision.fraudFlags.length > 0 && <p className="mt-1 break-words text-xs font-semibold">{vision.fraudFlags.join(' · ')}</p>}
                  <p className="mt-1 text-[11px] font-semibold text-ink/70">
                    {vision.mode === 'fallback' ? t('ai.fallbackLabel') : vision.cached ? t('ai.cachedLabel') : t('ai.geminiLabel')}
                  </p>
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
                      <button key={c} type="button" aria-pressed={category === c} onClick={() => setCategory(c)} className={`btn !justify-start ${category === c ? 'btn-primary' : 'btn-ghost'}`}>
                        <Icon className="h-5 w-5 shrink-0" aria-hidden /> <span className="min-w-0 break-words text-left leading-tight">{t(CATEGORY_META[c].labelKey)}</span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>
              <div>
                <label htmlFor="ttl" className="label">{t('report.titleField')}</label>
                <input id="ttl" className="field" value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div>
                <label htmlFor="dsc" className="label">{t('report.descField')}</label>
                <div className="relative">
                  <textarea id="dsc" className="field !pr-14" rows={3} value={description} maxLength={800} onChange={(e) => setDescription(e.target.value)} />
                  {speechRecognitionSupported() && (
                    <button type="button" onClick={toggleMic} aria-pressed={listening} aria-label={t('chat.micStart')} className={`absolute right-1.5 top-1.5 grid h-11 w-11 place-items-center rounded-xl ${listening ? 'animate-ring bg-danger text-white' : 'bg-surface-2 text-brand'}`}>
                      {listening ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                    </button>
                  )}
                </div>
              </div>
              {vision && <p className="text-xs text-muted">{t('report.severity')}: <span className="mono font-bold text-ink">{vision.severity}/5</span> {vision.isEmergency && <span className="font-bold text-danger">· {t('report.emergencyAi')}</span>}</p>}
            </div>
          )}
          <button type="button" className="btn btn-primary w-full !min-h-14" disabled={!step1Ok} onClick={() => setStep(2)}>
            {t('common.next')} <ArrowRight className="h-5 w-5" aria-hidden />
          </button>
        </section>
      )}

      {step === 2 && (
        <section className="space-y-4" aria-labelledby="s2">
          <h2 id="s2" className="sr-only">{t('report.step2')}</h2>

          {gpsStatus === 'locating' && (
            <div className="card flex items-center gap-3 p-3.5" role="status">
              <Spinner className="text-brand" />
              <p className="text-sm font-semibold">
                {t('report.locating')} {gpsSamples > 0 && fix ? `(±${Math.round(fix.accuracy)}m)` : ''}
              </p>
            </div>
          )}

          {isLowAccuracy && fix && (
            <div role="status" className="flex items-start gap-2 rounded-xl border border-warn/40 bg-warn-soft p-3 text-xs font-semibold text-warn">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{t('map.lowAccuracy', { m: Math.round(fix.accuracy) })}</span>
            </div>
          )}

          {(gpsStatus === 'denied' || gpsStatus === 'error') && (
            <div className="card space-y-3 border-warn/50 p-4" role="alert">
              <p className="flex items-start gap-2 font-bold text-warn">
                <MapPin className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
                {gpsStatus === 'denied' ? t('report.gpsDenied') : t('report.gpsError')}
              </p>
              <p className="text-sm text-muted">{t('report.gpsFallback')}</p>
              <div className="flex flex-wrap gap-1.5">
                {QUICK_PLACES.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    className="chip"
                    onClick={() => {
                      setPin({ lat: p.lat, lng: p.lng });
                      setMapFocus({ center: [p.lat, p.lng], zoom: 16 });
                      setManualWardCode('');
                    }}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
              <button type="button" className="btn btn-soft" onClick={() => void locate()}>
                <Crosshair className="h-5 w-5" aria-hidden />{t('report.retryGps')}
              </button>
            </div>
          )}

          <MapView
            reports={[]}
            center={mapFocus?.center}
            zoom={mapFocus?.zoom ?? (pin ? 16 : 9)}
            fitCityBounds={!pin && !mapFocus}
            userPos={fix ? { lat: fix.lat, lng: fix.lng } : null}
            accuracyM={fix?.accuracy ?? null}
            crosshairPin={{ onChange: handleCrosshairMove }}
            showArterials
            className="h-[44dvh]"
            onLocate={() => void locate()}
            ariaLabel={t('report.mapAria')}
          />
          <p className="text-xs text-muted">{t('report.dragHint')}</p>

          <div className="card space-y-2.5 p-3 text-sm">
            <p className="flex items-start gap-2 font-semibold">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
              <span className="break-words">{address || t('report.addressLoading')}</span>
            </p>
            {pin && (
              <p className="mono text-xs text-muted">
                {pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}
                {fix ? ` · GPS ±${Math.round(fix.accuracy)}m` : ''}
                {exifApplied ? ' · EXIF' : ''}
              </p>
            )}

            {geo?.needsConfirmation && !manualWardCode && (
              <p className="rounded-xl bg-warn-soft px-3 py-2 text-xs font-semibold text-warn">
                {t('report.wardAutoSuggest')}
              </p>
            )}

            {geo?.matchedAlias && (
              <p className="rounded-xl bg-brand-soft px-3 py-1.5 text-xs text-brand">
                {t('report.aliasNormalized', { old: geo.matchedAlias, unit: geo.ward.name })}
              </p>
            )}

            <div>
              <label htmlFor="rp-ward" className="label text-xs">{t('report.wardSelect')}</label>
              <select
                id="rp-ward"
                className="field !min-h-10 text-sm"
                value={activeWardCode}
                onChange={(e) => setManualWardCode(e.target.value)}
              >
                <optgroup label={t('scope.groupPhuong')}>
                  {WARDS_PHUONG.map((w) => (
                    <option key={w.wardCode} value={w.wardCode}>{w.name}</option>
                  ))}
                </optgroup>
                <optgroup label={t('scope.groupXa')}>
                  {WARDS_XA.map((w) => (
                    <option key={w.wardCode} value={w.wardCode}>{w.name}</option>
                  ))}
                </optgroup>
              </select>
              {activeWard && <p className="mt-1 text-xs text-muted">{activeWard.zone}</p>}
            </div>

            {geo?.arterial && <p className="text-xs font-semibold text-danger">{t('report.arterial', { name: geo.arterial.name })}</p>}
            {geo && !geo.inBounds && <p role="alert" className="font-semibold text-danger">{t('report.outOfBounds')}</p>}
          </div>

          {mismatch && (
            <div role="alert" className="space-y-2 rounded-2xl border border-warn/50 bg-warn-soft p-3 text-sm text-warn">
              <p className="flex items-start gap-2 font-bold">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                {t('report.gpsMismatch', { km: ((mismatchM ?? 0) / 1000).toFixed(1) })}
              </p>
              <label className="flex min-h-11 items-center gap-2 font-semibold">
                <input type="checkbox" className="h-5 w-5" checked={leftScene} onChange={(e) => setLeftScene(e.target.checked)} /> {t('report.leftScene')}
              </label>
            </div>
          )}

          {nearest && (
            <div className="card space-y-3 border-brand/50 p-3" role="status">
              <p className="font-bold">{t('report.nearbyTitle', { n: nearest.clusterCount })}</p>
              <p className="text-sm text-muted">{t('report.nearbyText', { m: Math.round(nearest.distanceM) })}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <button type="button" className="btn btn-primary" onClick={() => void useNearby('confirm')}>
                  <ThumbsUp className="h-5 w-5" aria-hidden />{t('detail.confirm')}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => void useNearby('attach')}>{t('detail.attach')}</button>
              </div>
              <p className="text-xs text-muted">{t('report.nearbyIgnore')}</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="btn btn-ghost !min-h-14" onClick={() => setStep(1)}>
              <ArrowLeft className="h-5 w-5" aria-hidden />{t('common.back')}
            </button>
            <button type="button" className="btn btn-primary !min-h-14" disabled={!step2Ok} onClick={() => setStep(3)}>
              {t('common.next')} <ArrowRight className="h-5 w-5" aria-hidden />
            </button>
          </div>
        </section>
      )}

      {step === 3 && photo && category && (
        <section className="space-y-4" aria-labelledby="s3">
          <h2 id="s3" className="sr-only">{t('report.step3')}</h2>
          <div className="card space-y-3 p-3">
            <div className="flex gap-3">
              <img src={photo.dataUrl} alt="" className="h-24 w-24 shrink-0 rounded-xl object-cover" />
              <div className="min-w-0">
                <p className="break-words font-bold [overflow-wrap:anywhere]">{title}</p>
                <p className="text-sm font-semibold" style={{ color: CATEGORY_META[category].color }}>{t(CATEGORY_META[category].labelKey)}</p>
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
              <ArrowLeft className="h-5 w-5" aria-hidden />{t('common.back')}
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
