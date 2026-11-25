import { Award, BookOpen, CheckCheck, Copy, FileWarning, HandHeart, Navigation, UserCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AuditEntry, ClientReport } from '@shared/types';
import { CameraCapture } from '../components/CameraCapture';
import { CityIncidentMap } from '../components/map';
import { ReportCard } from '../components/ReportCard';
import { EmptyState, ErrorState, SkeletonList, Sheet, Spinner } from '../components/ui';
import { WARD_BY_CODE } from '../data/dongNaiWards';
import { useAllReports, useOnline } from '../db/hooks';
import { db } from '../db/localDb';
import { useI18n } from '../i18n';
import { api, ApiError, NetworkError } from '../lib/api';
import { authStore, useSession } from '../lib/authStore';
import { edge } from '../lib/edgeClient';
import { useToast } from '../state/toast';

type Tab = 'tasks' | 'proxy' | 'honor';

interface Board {
  volunteers: Array<{ name: string; wardCode: string | null; unitCode: string | null; hours: number; points: number }>;
  wards: Array<{ wardCode: string; name: string; hours: number; points: number; members: number }>;
}

export default function VolunteerPage() {
  const { t, fmtDate, fmtNum } = useI18n();
  const toast = useToast();
  const online = useOnline();
  const session = useSession();
  const all = useAllReports();
  const [tab, setTab] = useState<Tab>('tasks');
  const [active, setActive] = useState<ClientReport | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [log, setLog] = useState<AuditEntry[] | null>(null);
  const [boardErr, setBoardErr] = useState<string | null>(null);

  const tasks = useMemo(
    () => all?.filter((r) => r.needsFieldVerification && !r.verification && (r.status === 'verifying' || r.status === 'quarantined'))
      .sort((a, b) => Number(b.seniorSubmitted) - Number(a.seniorSubmitted) || b.createdAt.localeCompare(a.createdAt)),
    [all],
  );

  const loadBoard = useCallback(async () => {
    setBoardErr(null);
    try {
      const [b, l, me] = await Promise.all([
        api<Board>('/api/volunteer/leaderboard'),
        api<AuditEntry[]>('/api/volunteer/logbook'),
        api<{ user: NonNullable<ReturnType<typeof authStore.get>>['user'] }>('/api/me'),
      ]);
      setBoard(b);
      setLog(l);
      authStore.updateUser(me.user);
    } catch (e) {
      setBoardErr(e instanceof NetworkError ? t('state.offlineErr') : e instanceof ApiError ? e.message : t('state.genericError'));
    }
  }, [t]);

  useEffect(() => {
    if (tab === 'honor' && online && !board) void loadBoard();
  }, [tab, online, board, loadBoard]);

  if (!session || session.user.role !== 'volunteer') {
    return (
      <div className="card"><EmptyState kind="shield" title={t('vol.needRole')} text={t('vol.needRoleText')} action={<Link to="/auth" className="btn btn-primary">{t('nav.login')}</Link>} /></div>
    );
  }
  const u = session.user;

  const accept = async (r: ClientReport): Promise<void> => {
    try {
      const upd = await api<ClientReport>(`/api/volunteer/tasks/${r.id}/accept`, { method: 'POST', body: {} });
      await db.reports.put({ ...upd, syncState: 'synced' });
      setActive(upd);
      toast('success', t('vol.accepted'));
    } catch (e) {
      toast('error', t('vol.acceptFail'), e instanceof ApiError ? e.message : e instanceof NetworkError ? t('state.offlineErr') : undefined);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-3xl bg-brand p-4 text-brand-ink">
        <p className="text-sm font-semibold opacity-90">{t('vol.badge')} · {u.unitCode ?? '—'} · {u.wardCode ? WARD_BY_CODE[u.wardCode]?.name : ''}</p>
        <h1 className="text-2xl font-extrabold">{u.name}</h1>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-white/15 p-2"><p className="mono text-xl font-bold">{fmtNum(u.volunteerHours, 1)}</p><p className="text-[11px] font-semibold">{t('vol.hours')}</p></div>
          <div className="rounded-xl bg-white/15 p-2"><p className="mono text-xl font-bold">{fmtNum(u.points)}</p><p className="text-[11px] font-semibold">{t('vol.points')}</p></div>
          <div className="rounded-xl bg-white/15 p-2"><p className="mono text-xl font-bold">{u.trustScore}</p><p className="text-[11px] font-semibold">{t('auth.trust')}</p></div>
        </div>
      </div>

      <div role="tablist" aria-label={t('vol.title')} className="grid grid-cols-3 gap-1 rounded-xl bg-surface-2 p-1">
        {([['tasks', t('vol.tabTasks'), UserCheck], ['proxy', t('vol.tabProxy'), HandHeart], ['honor', t('vol.tabHonor'), Award]] as const).map(([k, label, Icon]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-xs font-bold leading-tight ${tab === k ? 'bg-surface text-brand shadow-card' : 'text-muted'}`}>
            <Icon className="h-4 w-4" aria-hidden /><span className="min-w-0 break-words text-center">{label}</span>
          </button>
        ))}
      </div>

      {tab === 'tasks' && (
        <section className="space-y-3" aria-label={t('vol.tabTasks')}>
          {!online && <p className="rounded-xl bg-slate-900 p-3 text-sm font-semibold text-white">{t('vol.offlineNote')}</p>}
          {!tasks ? <SkeletonList rows={3} /> : tasks.length === 0 ? (
            <div className="card"><EmptyState kind="shield" title={t('vol.emptyTitle')} text={t('vol.emptyText')} /></div>
          ) : (
            <>
              <CityIncidentMap
                embedded
                externalReports={tasks}
                fitPointsOnMount
                onSelectPoint={(r) => setActive(r)}
                className="h-[34dvh]"
                ariaLabel={t('vol.mapAria')}
              />
              <div className="space-y-3">
                {tasks.map((r) => (
                  <div key={r.id} className="space-y-1">
                    {r.seniorSubmitted && <p className="rounded-lg bg-accent/20 px-3 py-1 text-xs font-bold text-warn">{t('badge.senior')}</p>}
                    <ReportCard r={r} onOpen={(x) => setActive(x)} />
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {tab === 'proxy' && (
        <section className="card space-y-3 p-4">
          <h2 className="flex items-center gap-2 text-lg font-bold"><HandHeart className="h-5 w-5 text-brand" aria-hidden />{t('vol.proxyTitle')}</h2>
          <p className="text-sm text-muted">{t('vol.proxyText')}</p>
          <Link to="/report?proxy=1" className="btn btn-primary w-full !min-h-14">{t('vol.proxyCta')}</Link>
        </section>
      )}

      {tab === 'honor' && (
        <section className="space-y-4" aria-label={t('vol.tabHonor')}>
          {!online && !board && <ErrorState title={t('state.offlineErr')} text={t('vol.honorOffline')} />}
          {boardErr && <ErrorState title={boardErr} onRetry={() => void loadBoard()} />}
          {online && !board && !boardErr && <SkeletonList rows={3} />}
          {board && (
            <>
              <div className="card p-3">
                <h2 className="mb-2 flex items-center gap-2 font-bold"><Award className="h-4 w-4 text-accent" aria-hidden />{t('vol.wardRanking')}</h2>
                <ol className="space-y-1.5">
                  {board.wards.map((w, i) => (
                    <li key={w.wardCode} className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2 text-sm">
                      <span className="mono w-6 text-center font-bold text-brand">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate font-semibold">{w.name}</span>
                      <span className="mono text-xs text-muted">{fmtNum(w.hours, 1)}h</span>
                      <span className="mono font-bold">{fmtNum(w.points)}</span>
                    </li>
                  ))}
                </ol>
              </div>
              <div className="card p-3">
                <h2 className="mb-2 font-bold">{t('vol.honorBoard')}</h2>
                <ol className="space-y-1.5">
                  {board.volunteers.slice(0, 8).map((v, i) => (
                    <li key={`${v.name}-${i}`} className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2 text-sm">
                      <span className="mono w-6 text-center font-bold text-brand">{i + 1}</span>
                      <span className="min-w-0 flex-1"><span className="block truncate font-semibold">{v.name}</span><span className="mono block text-[11px] text-muted">{v.unitCode}</span></span>
                      <span className="mono font-bold">{fmtNum(v.points)}</span>
                    </li>
                  ))}
                </ol>
              </div>
              <div className="card p-3">
                <h2 className="mb-2 flex items-center gap-2 font-bold"><BookOpen className="h-4 w-4 text-brand" aria-hidden />{t('vol.logbook')}</h2>
                {log && log.length > 0 ? (
                  <ul className="space-y-1.5">
                    {log.map((e) => (
                      <li key={e.id} className="rounded-xl bg-surface-2 px-3 py-2 text-sm">
                        <span className="mono text-xs font-semibold text-brand">{e.action}</span> <span className="mono text-xs text-muted">{e.targetId}</span>
                        <span className="block text-[11px] text-muted">{fmtDate(e.timestamp)}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-sm text-muted">{t('vol.logEmpty')}</p>}
              </div>
            </>
          )}
        </section>
      )}

      <VerifySheet r={active} userId={u.id} onClose={() => setActive(null)} onAccept={accept} />
    </div>
  );
}

function VerifySheet({ r, userId, onClose, onAccept }: { r: ClientReport | null; userId: string; onClose: () => void; onAccept: (r: ClientReport) => Promise<void> }) {
  const { t } = useI18n();
  const toast = useToast();
  const [verdict, setVerdict] = useState<'true' | 'duplicate' | 'fake'>('true');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<{ dataUrl: string; dHash: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setVerdict('true');
    setNote('');
    setPhoto(null);
  }, [r?.id]);

  if (!r) return null;
  const mine = r.assignedVolunteerId !== null && r.assignedVolunteerId === userId;
  const taken = r.assignedVolunteerId !== null && !mine;

  const onFile = async (f: File): Promise<void> => {
    setBusy(true);
    try {
      const p = await edge.processImage(f);
      setPhoto({ dataUrl: p.dataUrl, dHash: p.dHash });
    } catch (e) {
      toast('error', t('report.photoFail'), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const upd = await api<ClientReport>(`/api/volunteer/tasks/${r.id}/verify`, { body: { verdict, note, ...(photo ? { photo } : {}) } });
      await db.reports.put({ ...upd, syncState: 'synced' });
      toast('success', t('vol.verified'), t(`vol.verdictDone.${verdict}`));
      onClose();
    } catch (e) {
      toast('error', t('vol.verifyFail'), e instanceof ApiError ? e.message : e instanceof NetworkError ? t('state.offlineErr') : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open onClose={onClose} title={t('vol.verifyTitle')} wide>
      <div className="space-y-4">
        {r.photos[0] && <img src={r.photos[0].url} alt={r.title} className="aspect-[16/10] w-full rounded-2xl border border-line object-cover" />}
        <div>
          {r.seniorSubmitted && <p className="mb-1 inline-block rounded-full bg-accent/20 px-2.5 py-0.5 text-xs font-bold text-warn">{t('badge.senior')}</p>}
          <h3 className="break-words text-lg font-bold [overflow-wrap:anywhere]">{r.title}</h3>
          <p className="mt-1 break-words text-sm text-muted">{r.address}</p>
          <p className="mono text-xs text-muted">{r.code} · {r.lat.toFixed(5)}, {r.lng.toFixed(5)}</p>
          {r.quarantine && <p className="mt-2 flex gap-2 rounded-xl bg-warn-soft p-3 text-sm text-warn"><FileWarning className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{r.quarantine.detail}</p>}
          {r.gpsMismatchWarning && <p className="mt-2 rounded-xl bg-warn-soft p-2 text-sm font-semibold text-warn">{t('badge.gpsWarn')}</p>}
        </div>
        <a className="btn btn-soft w-full" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lng}`}>
          <Navigation className="h-5 w-5" aria-hidden />{t('vol.directions')}
        </a>

        {!mine ? (
          <button type="button" className="btn btn-primary w-full !min-h-14" disabled={taken} onClick={() => void onAccept(r)}>
            {taken ? t('vol.taken') : t('vol.accept')}
          </button>
        ) : (
          <div className="space-y-4">
            <div>
              <p className="label">{t('vol.photoWide')}</p>
              {photo ? (
                <div className="space-y-2">
                  <img src={photo.dataUrl} alt={t('vol.photoWide')} className="aspect-[4/3] w-full rounded-xl object-cover" />
                  <button type="button" className="btn btn-ghost w-full" onClick={() => setPhoto(null)}>{t('vol.retake')}</button>
                </div>
              ) : <CameraCapture onFile={(f) => void onFile(f)} disabled={busy} />}
            </div>
            <fieldset>
              <legend className="label">{t('vol.verdict')}</legend>
              <div className="grid gap-2">
                {([['true', CheckCheck, 'vol.verdict.true'], ['duplicate', Copy, 'vol.verdict.duplicate'], ['fake', FileWarning, 'vol.verdict.fake']] as const).map(([v, Icon, key]) => (
                  <button key={v} type="button" aria-pressed={verdict === v} onClick={() => setVerdict(v)} className={`btn !justify-start ${verdict === v ? (v === 'fake' ? 'btn-danger' : 'btn-primary') : 'btn-ghost'}`}>
                    <Icon className="h-5 w-5 shrink-0" aria-hidden /><span className="min-w-0 break-words text-left leading-tight">{t(key)}</span>
                  </button>
                ))}
              </div>
              {verdict === 'fake' && <p className="mt-2 text-xs font-semibold text-danger">{t('vol.fakeWarn')}</p>}
            </fieldset>
            <div>
              <label htmlFor="vn" className="label">{t('vol.note')}</label>
              <textarea id="vn" className="field" rows={2} maxLength={400} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <button type="button" className="btn btn-primary w-full !min-h-14" disabled={busy} onClick={() => void submit()}>{busy ? <Spinner /> : null}{t('vol.submit')}</button>
          </div>
        )}
      </div>
    </Sheet>
  );
}
