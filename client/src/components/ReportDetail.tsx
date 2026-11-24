import { useLiveQuery } from 'dexie-react-hooks';
import { Camera, Clock, Radio, ShieldCheck, Star, ThumbsUp } from 'lucide-react';
import { useRef, useState } from 'react';
import { hammingDistance } from '@shared/dhash';
import type { ClientReport } from '@shared/types';
import { WARD_BY_CODE } from '../data/dongNaiWards';
import { db } from '../db/localDb';
import { useI18n } from '../i18n';
import { edge } from '../lib/edgeClient';
import { useSession } from '../lib/authStore';
import { CATEGORY_META, DEPT_KEY } from '../lib/meta';
import { attachAngle, confirmedIds, confirmReport, rateReport } from '../lib/submitReport';
import { useAuthGate } from '../state/authGate';
import { useToast } from '../state/toast';
import { BeforeAfterSlider, SlaClock, Timeline } from './Timeline';
import { PriorityBadges, Sheet, Spinner, StatusBadge } from './ui';

function Stars({ value, onChange, readOnly = false, label }: { value: number; onChange?: (n: number) => void; readOnly?: boolean; label: string }) {
  return (
    <div className="flex gap-1" role={readOnly ? 'img' : 'radiogroup'} aria-label={`${label}: ${value}/5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={readOnly}
          role={readOnly ? undefined : 'radio'}
          aria-checked={readOnly ? undefined : value === n}
          aria-label={`${n}`}
          onClick={() => onChange?.(n)}
          className="grid h-11 w-11 place-items-center rounded-lg disabled:cursor-default"
        >
          <Star className={`h-7 w-7 ${n <= value ? 'fill-accent text-accent' : 'text-line'}`} />
        </button>
      ))}
    </div>
  );
}

export function ReportDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t, fmtDate } = useI18n();
  const toast = useToast();
  const { requireAuth } = useAuthGate();
  const session = useSession();
  const r = useLiveQuery(() => (id ? db.reports.get(id) : undefined), [id]);
  const [photoIdx, setPhotoIdx] = useState(0);
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!id) return null;
  if (!r) {
    return (
      <Sheet open onClose={onClose} title={t('detail.title')}>
        <div className="flex justify-center py-10"><Spinner className="text-brand" /></div>
      </Sheet>
    );
  }

  const open = r.status !== 'resolved' && r.status !== 'quarantined' && r.status !== 'rejected';
  const already = confirmedIds().has(r.id);
  const canConfirm = open && !r.mine && !already && r.syncState !== 'pending';
  const meta = CATEGORY_META[r.category];
  const photos = r.photos;
  const ward = WARD_BY_CODE[r.wardCode];

  const doConfirm = async (): Promise<void> => {
    if (!(await requireAuth())) return;
    await confirmReport(r);
    toast('success', t('detail.confirmed'), t('detail.confirmedText'));
  };

  const doAttach = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    if (!(await requireAuth())) return;
    setBusy(true);
    try {
      const p = await edge.processImage(file);
      const m = await edge.hammingMatch(p.dHash, r.photos.map((x) => ({ id: x.id, hash: x.dHash })));
      if (m.matches[0] && m.matches[0].distance <= 5) {
        toast('error', t('detail.attachDup'), t('detail.attachDupText', { d: m.matches[0].distance }));
        return;
      }
      await attachAngle(r, { dataUrl: p.dataUrl, dHash: p.dHash });
      toast('success', t('detail.attachOk'), t('detail.attachOkText'));
    } catch (err) {
      toast('error', t('detail.attachFail'), err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const doRate = async (): Promise<void> => {
    if (!stars) return;
    await rateReport(r, stars, comment);
    toast('success', t('detail.rated'));
  };

  const authScore = r.ai.authenticityScore;
  return (
    <Sheet open onClose={onClose} title={t('detail.title')} wide>
      <div className="space-y-4">
        {photos.length > 0 && (
          <div>
            <img src={photos[Math.min(photoIdx, photos.length - 1)].url} alt={r.title} className="aspect-[16/10] w-full rounded-2xl border border-line object-cover" />
            {photos.length > 1 && (
              <div className="mt-2 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label={t('detail.gallery')}>
                {photos.map((p, i) => (
                  <button key={p.id} type="button" role="tab" aria-selected={i === photoIdx} onClick={() => setPhotoIdx(i)} className={`h-14 w-20 shrink-0 overflow-hidden rounded-lg border-2 ${i === photoIdx ? 'border-brand' : 'border-line'}`}>
                    <img src={p.url} alt={`${t('detail.angle')} ${i + 1}`} className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={r.status} />
          <PriorityBadges r={r} />
          {r.gpsMismatchWarning && <span className="rounded-full bg-warn-soft px-2.5 py-0.5 text-xs font-bold text-warn">{t('badge.gpsWarn')}</span>}
        </div>
        <div>
          <h3 className="break-words text-xl font-bold [overflow-wrap:anywhere]">{r.title}</h3>
          <p className="mt-1 break-words text-sm text-muted [overflow-wrap:anywhere]">{r.description}</p>
        </div>

        <dl className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-xl bg-surface-2 p-3"><dt className="text-xs text-muted">{t('detail.code')}</dt><dd className="mono break-all font-semibold">{r.code}</dd></div>
          <div className="rounded-xl bg-surface-2 p-3"><dt className="text-xs text-muted">{t('detail.category')}</dt><dd className="font-semibold" style={{ color: meta.color }}>{t(meta.labelKey)}</dd></div>
          <div className="col-span-2 rounded-xl bg-surface-2 p-3"><dt className="text-xs text-muted">{t('detail.location')}</dt><dd className="break-words font-semibold">{r.address}</dd><dd className="mono text-xs text-muted">{r.lat.toFixed(5)}, {r.lng.toFixed(5)} · {ward?.name}</dd></div>
          {r.slaDueAt && r.status !== 'resolved' && (
            <div className="col-span-2 flex items-center justify-between rounded-xl bg-surface-2 p-3"><dt className="flex items-center gap-1 text-xs text-muted"><Clock className="h-3.5 w-3.5" aria-hidden />{t('detail.sla')}</dt><dd><SlaClock iso={r.slaDueAt} /></dd></div>
          )}
          {r.department && <div className="col-span-2 rounded-xl bg-surface-2 p-3"><dt className="text-xs text-muted">{t('detail.department')}</dt><dd className="font-semibold">{t(DEPT_KEY[r.department])}</dd></div>}
        </dl>

        {r.dispatches.length > 0 && (
          <div className="rounded-2xl border border-danger/40 bg-danger-soft p-3">
            <p className="flex items-center gap-2 text-sm font-bold text-danger"><Radio className="h-4 w-4" aria-hidden />{t('detail.dispatch')}</p>
            {r.dispatches.map((d) => (
              <p key={d.id} className="mt-1 break-words text-sm text-ink">
                {d.toWardCodes.map((c) => WARD_BY_CODE[c]?.name ?? c).join(', ')} · {d.units.map((u) => t(DEPT_KEY[u])).join(' + ')} {d.auto ? `· ${t('detail.auto')}` : ''}
              </p>
            ))}
          </div>
        )}

        <div className="rounded-2xl border border-line p-3">
          <p className="flex items-center gap-2 text-sm font-bold"><ShieldCheck className="h-4 w-4 text-brand" aria-hidden />{t('detail.aiCheck')}</p>
          <div className="mt-2 flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              <div className={`h-full ${authScore < 45 ? 'bg-danger' : authScore < 70 ? 'bg-warn' : 'bg-ok'}`} style={{ width: `${authScore}%` }} />
            </div>
            <span className="mono text-sm font-semibold">{authScore}/100</span>
          </div>
          {r.ai.fraudFlags.length > 0 && <p className="mt-1 break-words text-xs font-semibold text-danger">{r.ai.fraudFlags.join(' · ')}</p>}
          {r.ai.safetyHazards.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-muted">{r.ai.safetyHazards.map((h) => <li key={h}>{h}</li>)}</ul>}
          <p className="mt-1 text-[11px] font-semibold text-warn">
            {r.ai.mode === 'fallback' ? t('ai.fallbackLabel') : r.ai.mode === 'seed' ? t('ai.seedLabel') : t('ai.geminiLabel')}
          </p>
          {r.quarantine && <p className="mt-2 break-words rounded-lg bg-surface-2 p-2 text-xs">{r.quarantine.detail}</p>}
        </div>

        {r.afterPhoto && photos[0] && (
          <div>
            <p className="mb-2 text-sm font-bold">{t('detail.beforeAfter')}</p>
            <BeforeAfterSlider before={photos[0].url} after={r.afterPhoto.url} labelBefore={t('detail.before')} labelAfter={t('detail.after')} />
            {r.resolution && (
              <p className={`mt-2 rounded-xl p-3 text-sm ${r.resolution.resolutionVerified ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>
                <span className="font-bold">{t('detail.aiVerify')}: {r.resolution.matchConfidence}/100</span> — {r.resolution.summary}
              </p>
            )}
          </div>
        )}

        <div>
          <p className="mb-2 text-sm font-bold">{t('timeline.title')}</p>
          <Timeline r={r} />
        </div>

        {r.status === 'resolved' && (r.rating || (r.mine && session)) && (
          <div className="rounded-2xl border border-line p-3">
            <p className="mb-1 text-sm font-bold">{t('detail.rating')}</p>
            {r.rating ? (
              <>
                <Stars value={r.rating.stars} readOnly label={t('detail.rating')} />
                {r.rating.comment && <p className="mt-1 break-words text-sm italic text-muted">“{r.rating.comment}”</p>}
              </>
            ) : (
              <>
                <Stars value={stars} onChange={setStars} label={t('detail.rating')} />
                <textarea className="field mt-2" rows={2} maxLength={400} placeholder={t('detail.ratingPlaceholder')} value={comment} onChange={(e) => setComment(e.target.value)} />
                <button type="button" className="btn btn-primary mt-2 w-full" disabled={!stars} onClick={() => void doRate()}>{t('detail.ratingSend')}</button>
              </>
            )}
          </div>
        )}

        {open && (
          <div className="grid gap-2 sm:grid-cols-2">
            {canConfirm && (
              <button type="button" className="btn btn-primary" onClick={() => void doConfirm()}>
                <ThumbsUp className="h-5 w-5" aria-hidden /> {t('detail.confirm')} ({r.confirmCount})
              </button>
            )}
            {!canConfirm && !r.mine && already && <p className="rounded-xl bg-ok-soft p-3 text-center text-sm font-semibold text-ok">{t('detail.alreadyConfirmed')}</p>}
            <button type="button" className="btn btn-ghost" disabled={busy || r.syncState === 'pending'} onClick={() => fileRef.current?.click()}>
              {busy ? <Spinner /> : <Camera className="h-5 w-5" aria-hidden />} {t('detail.attach')}
            </button>
            <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void doAttach(e.target.files?.[0])} />
          </div>
        )}
        <p className="text-xs text-muted">{t('detail.created', { d: fmtDate(r.createdAt) })} · {t('detail.contributors', { n: r.clusterCount })} · {hammingNote(r)}</p>
      </div>
    </Sheet>
  );
}

function hammingNote(r: ClientReport): string {
  if (r.photos.length < 2) return `${r.photos.length} dHash`;
  let min = 64;
  for (let i = 0; i < r.photos.length; i++) for (let j = i + 1; j < r.photos.length; j++) min = Math.min(min, hammingDistance(r.photos[i].dHash, r.photos[j].dHash));
  return `${r.photos.length} · dHash min ${min}`;
}
