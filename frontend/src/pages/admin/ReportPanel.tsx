import { ArrowRightLeft, Ban, CheckCircle2, ExternalLink, Navigation, Radio, RotateCcw, ShieldAlert, Truck, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { DEPARTMENTS } from '@shared/constants';
import { haversineMeters } from '@shared/geo';
import type { ClientReport, Department } from '@shared/types';
import { TacticalNavigationWorkspace } from '../../components/navigation/TacticalNavigationWorkspace';
import { TacticalBriefingCard } from '../../components/TacticalBriefingCard';
import { BeforeAfterSlider, SlaClock, Timeline } from '../../components/Timeline';
import { Spinner } from '../../components/ui';
import { DONG_NAI_WARDS, WARD_BY_CODE } from '../../data/dongNaiWards';
import { db } from '../../db/localDb';
import { useLiveNavigationGps } from '../../hooks/useLiveNavigationGps';
import { useI18n } from '../../i18n';
import { api, apiMultipart, ApiError, NetworkError } from '../../lib/api';
import { useSession } from '../../lib/authStore';
import { edge } from '../../lib/edgeClient';
import { googleMapsDirectionsUrl } from '../../lib/mapConfig';
import { CATEGORY_META, DEPT_KEY } from '../../lib/meta';
import { invalidateSwrPrefix } from '../../lib/swrCache';
import { useToast } from '../../state/toast';

const WARDS_PHUONG = DONG_NAI_WARDS.filter((w) => w.kind === 'Phường');
const WARDS_XA = DONG_NAI_WARDS.filter((w) => w.kind === 'Xã');

interface Props {
  report: ClientReport;
  canAct: boolean;
  onChanged: (r: ClientReport) => void;
  onClose: () => void;
}

export function ReportPanel({ report: r, canAct, onChanged, onClose }: Props) {
  const { t, fmtDate } = useI18n();
  const toast = useToast();
  const session = useSession();
  const { pos: livePos, refreshNow } = useLiveNavigationGps(
    session?.user.wardCode ?? r.wardCode,
  );
  const [navModalOpen, setNavModalOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [dept, setDept] = useState<Department>(r.department ?? r.ai.suggestedDepartment ?? 'ubnd_khu_pho');
  const [sla, setSla] = useState(r.priority === 'emergency' ? 2 : r.priority === 'high' ? 24 : 72);
  const [transferWard, setTransferWard] = useState(r.wardCode);
  const [transferNote, setTransferNote] = useState('');
  const [after, setAfter] = useState<{
    previewUrl: string;
    displayBlob: Blob;
    aiBlob: Blob;
    dHash: string;
    exif?: unknown;
    edge?: unknown;
    gps?: { lat: number; lng: number } | null;
  } | null>(null);
  const [override, setOverride] = useState(false);
  const [aiMsg, setAiMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const ward = WARD_BY_CODE[r.wardCode];
  const meta = CATEGORY_META[r.category];
  const closed = r.status === 'resolved' || r.status === 'rejected';

  useEffect(() => {
    return () => {
      if (after?.previewUrl.startsWith('blob:')) URL.revokeObjectURL(after.previewUrl);
    };
  }, [after]);

  const run = async (key: string, fn: () => Promise<ClientReport | null>, okMsg: string): Promise<void> => {
    setBusy(key);
    try {
      const upd = await fn();
      if (upd) {
        await db.reports.put({ ...upd, syncState: 'synced' });
        invalidateSwrPrefix('q:');
        invalidateSwrPrefix('ov:');
        onChanged(upd);
        toast('success', okMsg);
      }
    } catch (e) {
      toast('error', t('ioc.actionFail'), e instanceof ApiError ? e.message : e instanceof NetworkError ? t('state.offlineErr') : undefined);
    } finally {
      setBusy(null);
    }
  };

  const post = <T,>(path: string, body: unknown = {}): Promise<T> => api<T>(path, { method: 'POST', body });

  const pickAfter = async (f: File | undefined): Promise<void> => {
    if (!f) return;
    setBusy('photo');
    try {
      const p = await edge.processImage(f);
      setAfter({
        previewUrl: p.previewUrl,
        displayBlob: p.displayBlob,
        aiBlob: p.aiBlob,
        dHash: p.dHash,
        exif: p.exif,
        edge: p.stats,
        gps: p.exifGps ? { lat: p.exifGps.lat, lng: p.exifGps.lng } : null,
      });
      setAiMsg(null);
    } catch (e) {
      toast('error', t('report.photoFail'), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const resolve = async (): Promise<void> => {
    if (!after) return;
    setBusy('resolve');
    try {
      const fd = new FormData();
      fd.append('displayImage', after.displayBlob, 'display.webp');
      fd.append('aiImage', after.aiBlob, 'ai.webp');
      fd.append(
        'metadata',
        JSON.stringify({
          dHash: after.dHash,
          note: '',
          override,
          exif: after.exif,
          edge: after.edge,
          lat: after.gps?.lat ?? livePos?.lat,
          lng: after.gps?.lng ?? livePos?.lng,
        }),
      );
      const res = await apiMultipart<{
        report: ClientReport;
        accepted: boolean;
        resolutionStatus?: 'AUTO_VERIFIED' | 'PENDING_MODERATION' | 'REJECTED';
      }>(`/api/admin/reports/${r.id}/resolve`, { body: fd });
      await db.reports.put({ ...res.report, syncState: 'synced' });
      invalidateSwrPrefix('q:');
      invalidateSwrPrefix('ov:');
      onChanged(res.report);
      if (res.accepted) {
        toast('success', t('ioc.resolved'), t('ioc.resolvedText', { n: res.report.clusterCount }));
        setAfter(null);
      } else if (res.resolutionStatus === 'PENDING_MODERATION') {
        toast('info', 'Đã đưa vào Hàng đợi Kiểm duyệt', res.report.resolution?.summary);
        setAiMsg({ ok: true, text: res.report.resolution?.summary ?? 'Chờ Admin duyệt ảnh hoàn thành.' });
      } else {
        setAiMsg({ ok: false, text: res.report.resolution?.summary ?? '' });
      }
    } catch (e) {
      toast('error', t('ioc.actionFail'), e instanceof ApiError ? e.message : e instanceof NetworkError ? t('state.offlineErr') : undefined);
    } finally {
      setBusy(null);
    }
  };

  const adj = ward?.adjacentWardCodes.map((c) => WARD_BY_CODE[c]?.name ?? c) ?? [];

  return (
    <aside className="ioc-panel flex max-h-[calc(100dvh-7rem)] flex-col overflow-hidden" aria-label={t('ioc.detail')}>
      <div className="flex items-start gap-2 border-b border-ioc-line p-3">
        <div className="min-w-0 flex-1">
          <p className="mono text-xs text-ioc-cyan">{r.code}</p>
          <h3 className="break-words text-sm font-bold leading-snug [overflow-wrap:anywhere]">{r.title}</h3>
          <p className="mt-0.5 text-xs text-ioc-dim">{t(meta.labelKey)} · {ward?.name} · {fmtDate(r.createdAt)}</p>
        </div>
        <button type="button" className="ioc-btn !min-h-8 !px-2" onClick={onClose} aria-label={t('common.close')}><X className="h-4 w-4" /></button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3 text-sm">
        {r.photos[0] && (
          <div className="grid grid-cols-4 gap-1.5">
            {r.photos.slice(0, 8).map((p, i) => (
              <img
                key={p.id}
                src={i === 0 ? p.url : (p.thumbnailUrl ?? p.url)}
                alt={`${t('detail.angle')} ${i + 1}`}
                width={i === 0 ? 320 : 160}
                height={i === 0 ? 240 : 160}
                loading="lazy"
                decoding="async"
                className={`aspect-square rounded border border-ioc-line object-cover ${i === 0 ? 'col-span-2 row-span-2 aspect-auto h-full w-full' : ''}`}
              />
            ))}
          </div>
        )}
        <p className="break-words text-ioc-dim">{r.description}</p>

        {/* SmartCitizen AI Brain: Gợi ý tác chiến 3 dòng + Chỉ đường Turn-by-Turn tới hiện trường */}
        <TacticalBriefingCard
          report={r}
          compact
          onBriefingUpdated={(b) => {
            onChanged({ ...r, ai: { ...r.ai, tacticalBriefing: b } });
          }}
        />
        <div className="grid gap-1.5 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setNavModalOpen(true)}
            className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded bg-[#1A73E8] px-3 text-xs font-extrabold text-white shadow hover:bg-[#1557B0]"
          >
            <Navigation className="h-3.5 w-3.5 fill-current" aria-hidden />
            Chỉ đường tới hiện trường
          </button>
          <a
            href={googleMapsDirectionsUrl(r.lat, r.lng, { lat: livePos.lat, lng: livePos.lng })}
            target="_blank"
            rel="noreferrer"
            className="ioc-btn ioc-btn-cyan justify-center !min-h-10 !text-xs"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Mở Google Maps gốc
          </a>
        </div>

        {navModalOpen && (
          <div
            className="fixed inset-0 z-[90] bg-slate-950"
            role="dialog"
            aria-modal="true"
            aria-label={`Dẫn đường tác chiến tới hiện trường ${r.code}`}
          >
            <TacticalNavigationWorkspace
              mission={r}
              livePos={livePos}
              onRefreshGps={() => void refreshNow()}
              onMissionUpdated={(upd) => onChanged(upd)}
              onCloseModal={() => setNavModalOpen(false)}
            />
          </div>
        )}

        {r.status !== 'resolved' && (r.assignedRescueName || r.rescueMission?.assignedTeamName) && (
          <div className="rounded border border-cyan-500/40 bg-cyan-500/10 p-2.5 text-xs">
            <p className="flex items-center gap-1.5 font-bold text-ioc-cyan">
              <Truck className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {r.assignedRescueName ?? r.rescueMission?.assignedTeamName}
            </p>
            <p className="mt-1 text-ioc-text">
              Trạng thái:{' '}
              <strong>
                {r.rescueStatus === 'IN_PROGRESS'
                  ? 'Đang xử lý sự cố'
                  : r.rescueStatus === 'ARRIVED'
                    ? 'Đã tới hiện trường'
                    : 'Đang di chuyển tới hiện trường'}
              </strong>
              {r.rescueLiveLocation && (() => {
                const dKm = Math.round((haversineMeters(r.rescueLiveLocation.lat, r.rescueLiveLocation.lng, r.lat, r.lng) / 1000) * 100) / 100;
                const eta = Math.max(1, Math.round(((dKm * 1.24) / 36) * 60));
                return ` · Cách hiện trường ${dKm} km (~${eta} phút)`;
              })()}
            </p>
          </div>
        )}

        <dl className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded border border-ioc-line p-2"><dt className="text-ioc-dim">{t('detail.sla')}</dt><dd><SlaClock iso={r.slaDueAt} dark /></dd></div>
          <div className="rounded border border-ioc-line p-2"><dt className="text-ioc-dim">{t('detail.department')}</dt><dd className="font-semibold">{r.department ? t(DEPT_KEY[r.department]) : '—'}</dd></div>
          <div className="rounded border border-ioc-line p-2"><dt className="text-ioc-dim">{t('ioc.cluster')}</dt><dd className="mono font-semibold">{r.clusterCount} · {r.confirmCount}✓</dd></div>
          <div className="rounded border border-ioc-line p-2"><dt className="text-ioc-dim">{t('ioc.authenticity')}</dt><dd className={`mono font-semibold ${r.ai.authenticityScore < 45 ? 'text-ioc-red' : 'text-ioc-green'}`}>{r.ai.authenticityScore}/100</dd></div>
        </dl>

        {(r.quarantine || r.gpsMismatchWarning) && (
          <div className="rounded border border-ioc-amber/50 bg-ioc-amber/10 p-2 text-xs text-ioc-amber">
            <p className="flex items-center gap-1.5 font-bold"><ShieldAlert className="h-3.5 w-3.5" aria-hidden />{r.quarantine ? t(`quarantine.${r.quarantine.reason}` as 'quarantine.manual') : t('badge.gpsWarn')}</p>
            {r.quarantine && <p className="mt-1 break-words">{r.quarantine.detail}</p>}
            {r.ai.fraudFlags.length > 0 && <p className="mono mt-1 break-words">{r.ai.fraudFlags.join(' · ')}</p>}
            {r.gpsDistanceKm !== null && <p className="mono mt-1">GPS Δ {r.gpsDistanceKm} km</p>}
          </div>
        )}

        {r.dispatches.length > 0 && (
          <div className="rounded border border-red-500/40 bg-red-500/10 p-2 text-xs">
            <p className="flex items-center gap-1.5 font-bold text-ioc-red"><Radio className="h-3.5 w-3.5" aria-hidden />{t('detail.dispatch')}</p>
            {r.dispatches.map((d) => <p key={d.id} className="mt-1 break-words text-ioc-text">{d.toWardCodes.map((c) => WARD_BY_CODE[c]?.name ?? c).join(', ')} · {d.units.map((u) => t(DEPT_KEY[u])).join(' + ')}{d.auto ? ` · ${t('detail.auto')}` : ''}</p>)}
          </div>
        )}

        {r.afterPhoto && r.photos[0] && (
          <div>
            <BeforeAfterSlider before={r.photos[0].url} after={r.afterPhoto.url} labelBefore={t('detail.before')} labelAfter={t('detail.after')} />
            {r.resolution && (
              <div className={`mt-1.5 rounded border p-2 text-xs ${r.resolution.resolutionVerified ? 'border-emerald-500/40 bg-emerald-500/10 text-ioc-green' : 'border-red-500/40 bg-red-500/10 text-ioc-red'}`}>
                <p>{t('detail.aiVerify')}: <span className="mono font-bold">{r.resolution.matchConfidence}%</span> — {r.resolution.summary}</p>
                {(r.resolution.sceneMatchScore !== undefined || r.resolution.resolutionScore !== undefined) && (
                  <p className="mono mt-1 text-[11px] text-ioc-text">
                    {r.resolution.sceneMatchScore !== undefined ? `${t('detail.sceneScore')}: ${r.resolution.sceneMatchScore}%` : ''}
                    {r.resolution.resolutionScore !== undefined ? ` · ${t('detail.resScore')}: ${r.resolution.resolutionScore}%` : ''}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {canAct && !closed && r.status !== 'quarantined' && (
          <>
            <fieldset className="space-y-2 rounded border border-ioc-line p-2" disabled={busy !== null}>
              <legend className="px-1 text-[11px] font-bold uppercase tracking-wider text-ioc-dim">{t('ioc.assign')}</legend>
              <div className="flex flex-wrap gap-2">
                <select className="ioc-field min-w-0 flex-1" value={dept} onChange={(e) => setDept(e.target.value as Department)} aria-label={t('detail.department')}>
                  {DEPARTMENTS.map((d) => <option key={d} value={d}>{t(DEPT_KEY[d])}</option>)}
                </select>
                <div className="flex items-center gap-1">
                  <input type="number" min={1} max={720} className="ioc-field mono w-20" value={sla} onChange={(e) => setSla(Math.max(1, Math.min(720, Number(e.target.value) || 1)))} aria-label={t('ioc.slaHours')} />
                  <span className="text-xs text-ioc-dim">{t('ioc.hours')}</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {[2, 24, 48, 72].map((h) => <button key={h} type="button" className="ioc-btn !min-h-7 !px-2 !text-xs" onClick={() => setSla(h)}>{h}h</button>)}
              </div>
              <button type="button" className="ioc-btn ioc-btn-cyan w-full" onClick={() => void run('assign', () => post<ClientReport>(`/api/admin/reports/${r.id}/assign`, { department: dept, slaHours: sla }), t('ioc.assigned'))}>
                {busy === 'assign' ? <Spinner /> : null}{t('ioc.assignBtn')}
              </button>
            </fieldset>

            {/* Chuyển tuyến Phường/Xã trong 95 ĐVHC nếu phản ánh bị định tuyến nhầm */}
            <fieldset className="space-y-2 rounded border border-ioc-line p-2" disabled={busy !== null}>
              <legend className="px-1 text-[11px] font-bold uppercase tracking-wider text-ioc-dim">{t('ioc.transferTitle')}</legend>
              <select className="ioc-field w-full" value={transferWard} onChange={(e) => setTransferWard(e.target.value)} aria-label={t('ioc.transferTitle')}>
                <optgroup label={t('scope.groupPhuong')}>
                  {WARDS_PHUONG.map((w) => <option key={w.wardCode} value={w.wardCode}>{w.name}</option>)}
                </optgroup>
                <optgroup label={t('scope.groupXa')}>
                  {WARDS_XA.map((w) => <option key={w.wardCode} value={w.wardCode}>{w.name}</option>)}
                </optgroup>
              </select>
              <input
                className="ioc-field w-full"
                placeholder={t('ioc.transferNote')}
                value={transferNote}
                onChange={(e) => setTransferNote(e.target.value)}
                maxLength={300}
              />
              <button
                type="button"
                className="ioc-btn w-full"
                disabled={transferWard === r.wardCode}
                onClick={() => void run('transfer', () => post<ClientReport>(`/api/admin/reports/${r.id}/transfer`, { wardCode: transferWard, note: transferNote }), t('ioc.transferred'))}
              >
                {busy === 'transfer' ? <Spinner /> : <ArrowRightLeft className="h-4 w-4" aria-hidden />} {t('ioc.transferBtn')}
              </button>
            </fieldset>

            <div className="rounded border border-ioc-line p-2">
              <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-ioc-dim">{t('ioc.crossWard')}</p>
              <p className="mb-2 break-words text-xs text-ioc-dim">{t('ioc.adjacent')}: {adj.join(', ')}</p>
              <button type="button" className="ioc-btn ioc-btn-red w-full" disabled={busy !== null} onClick={() => void run('dispatch', () => post<ClientReport>(`/api/admin/reports/${r.id}/dispatch`, { note: '' }), t('ioc.dispatched'))}>
                {busy === 'dispatch' ? <Spinner /> : <Radio className="h-4 w-4" aria-hidden />}📡 {t('ioc.dispatchBtn')}
              </button>
            </div>

            <fieldset className="space-y-2 rounded border border-ioc-line p-2" disabled={busy === 'resolve'}>
              <legend className="px-1 text-[11px] font-bold uppercase tracking-wider text-ioc-dim">{t('ioc.acceptance')}</legend>
              {after ? <img src={after.previewUrl} alt={t('detail.after')} width={480} height={270} loading="lazy" decoding="async" className="aspect-video w-full rounded border border-ioc-line object-cover" /> : <p className="text-xs text-ioc-dim">{t('ioc.acceptanceHint')}</p>}
              <div className="grid grid-cols-2 gap-2">
                <button type="button" className="ioc-btn" onClick={() => fileRef.current?.click()}>{busy === 'photo' ? <Spinner /> : <Upload className="h-4 w-4" aria-hidden />}{t('ioc.uploadAfter')}</button>
                <button type="button" className="ioc-btn ioc-btn-green" disabled={!after} onClick={() => void resolve()}>{busy === 'resolve' ? <Spinner /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}{t('ioc.verifyClose')}</button>
              </div>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => void pickAfter(e.target.files?.[0])} />
              {aiMsg && !aiMsg.ok && (
                <div role="alert" className="rounded border border-red-500/50 bg-red-500/10 p-2 text-xs text-ioc-red">
                  <p className="font-bold">{t('ioc.verifyRejected')}</p>
                  <p className="mt-1 break-words">{aiMsg.text}</p>
                  <label className="mt-2 flex min-h-8 items-center gap-2 text-ioc-text"><input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />{t('ioc.override')}</label>
                </div>
              )}
            </fieldset>
          </>
        )}

        {canAct && r.status === 'quarantined' && (
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="ioc-btn ioc-btn-green" disabled={busy !== null} onClick={() => void run('restore', () => post<ClientReport>(`/api/admin/reports/${r.id}/restore`), t('ioc.restored'))}>{busy === 'restore' ? <Spinner /> : <RotateCcw className="h-4 w-4" aria-hidden />}{t('ioc.restore')}</button>
            <button type="button" className="ioc-btn ioc-btn-red" disabled={busy !== null} onClick={() => void run('spam', () => post<ClientReport>(`/api/admin/reports/${r.id}/spam`, { reason: r.quarantine?.reason ?? '' }), t('ioc.markedSpam'))}>{busy === 'spam' ? <Spinner /> : <Ban className="h-4 w-4" aria-hidden />}{t('ioc.markSpam')}</button>
          </div>
        )}
        {!canAct && <p className="rounded border border-ioc-amber/40 bg-ioc-amber/10 p-2 text-xs text-ioc-amber">{t('ioc.readOnly')}</p>}

        <div className="[&_*]:!text-ioc-text">
          <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-ioc-dim">{t('timeline.title')}</p>
          <Timeline r={r} />
        </div>
      </div>
    </aside>
  );
}
