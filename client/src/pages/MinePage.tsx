import { Bell, Search } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ClientReport } from '@shared/types';
import { ReportCard } from '../components/ReportCard';
import { ReportDetail } from '../components/ReportDetail';
import { EmptyState, ErrorState, SkeletonList, Spinner } from '../components/ui';
import { useMyReports, useOnline } from '../db/hooks';
import { db } from '../db/localDb';
import { useI18n } from '../i18n';
import { api, ApiError, NetworkError } from '../lib/api';
import { authStore, useSession } from '../lib/authStore';
import { useToast } from '../state/toast';

export default function MinePage() {
  const { t, fmtDate } = useI18n();
  const toast = useToast();
  const online = useOnline();
  const session = useSession();
  const mine = useMyReports();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ClientReport[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const search = async (): Promise<void> => {
    const term = q.trim();
    if (term.length < 4) return;
    setBusy(true);
    setErr(null);
    try {
      const local = (await db.reports.toArray()).filter((r) => r.code.toLowerCase() === term.toLowerCase());
      if (local.length) {
        setResults(local);
        return;
      }
      if (!online) {
        setResults([]);
        setErr(t('mine.offlineSearch'));
        return;
      }
      const found = await api<ClientReport[]>(`/api/reports/lookup?q=${encodeURIComponent(term)}`);
      const isPhone = /^0|^\+?84/.test(term.replace(/\s/g, ''));
      const have = new Set((await db.reports.bulkGet(found.map((r) => r.id))).filter((r) => !!r).map((r) => r!.id));
      await db.reports.bulkPut(
        found.filter((r) => isPhone || !have.has(r.id)).map((r) => ({ ...r, syncState: 'synced' as const, mine: isPhone ? true : undefined })),
      );
      setResults(found);
    } catch (e) {
      setResults(null);
      setErr(e instanceof NetworkError ? t('state.offlineErr') : e instanceof ApiError ? e.message : t('state.genericError'));
    } finally {
      setBusy(false);
    }
  };

  const unread = session?.user.notifications.filter((n) => !n.read) ?? [];
  const markRead = async (): Promise<void> => {
    try {
      await api('/api/me/notifications/read', { method: 'POST', body: {} });
      const s = authStore.get();
      if (s) authStore.updateUser({ ...s.user, notifications: s.user.notifications.map((n) => ({ ...n, read: true })) });
    } catch (e) {
      toast('error', t('state.genericError'), e instanceof Error ? e.message : undefined);
    }
  };

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-extrabold">{t('mine.title')}</h1>

      <section className="card space-y-3 p-3" aria-label={t('mine.lookup')}>
        <form onSubmit={(e) => { e.preventDefault(); void search(); }} className="flex gap-2">
          <label htmlFor="lk" className="sr-only">{t('mine.lookup')}</label>
          <input id="lk" className="field mono min-w-0 flex-1" placeholder={t('mine.lookupPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="submit" className="btn btn-primary !min-w-12 !px-3" disabled={busy || q.trim().length < 4} aria-label={t('mine.search')}>{busy ? <Spinner /> : <Search className="h-5 w-5" aria-hidden />}</button>
        </form>
        <p className="text-xs text-muted">{t('mine.lookupHint')}</p>
        {err && <ErrorState title={err} onRetry={() => void search()} />}
        {results && results.length === 0 && !err && (
          <EmptyState kind="search" title={t('mine.noResult')} text={t('mine.noResultText')} action={<button type="button" className="btn btn-ghost" onClick={() => { setResults(null); setQ(''); }}>{t('empty.clearFilters')}</button>} />
        )}
        {results && results.length > 0 && <div className="space-y-3">{results.map((r) => <ReportCard key={r.id} r={r} onOpen={(x) => setOpenId(x.id)} />)}</div>}
      </section>

      {session && session.user.notifications.length > 0 && (
        <section className="card p-3" aria-label={t('mine.notifications')}>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-bold"><Bell className="h-4 w-4 text-brand" aria-hidden />{t('mine.notifications')}{unread.length > 0 && <span className="rounded-full bg-danger px-2 text-xs font-bold text-white">{unread.length}</span>}</h2>
            {unread.length > 0 && <button type="button" className="text-sm font-semibold text-brand underline" onClick={() => void markRead()}>{t('mine.markRead')}</button>}
          </div>
          <ul className="space-y-2">
            {session.user.notifications.slice(0, 5).map((n) => (
              <li key={n.id} className={`rounded-xl p-2 text-sm ${n.read ? 'bg-surface-2' : 'bg-brand-soft'}`}>
                <p className="break-words">{n.text}</p>
                <p className="mono text-[11px] text-muted">{fmtDate(n.at)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label={t('mine.list')}>
        <h2 className="mb-2 text-lg font-bold">{t('mine.list')}</h2>
        {!session && <p className="mb-3 rounded-xl bg-brand-soft p-3 text-sm"><Link to="/auth" className="font-bold text-brand underline">{t('nav.login')}</Link> {t('mine.loginHint')}</p>}
        {!mine ? (
          <SkeletonList rows={3} />
        ) : mine.length === 0 ? (
          <div className="card">
            <EmptyState title={t('empty.mine.title')} text={t('empty.mine.text')} action={<Link to="/report" className="btn btn-primary">{t('empty.reports.cta')}</Link>} />
          </div>
        ) : (
          <div className="space-y-3">{mine.map((r) => <ReportCard key={r.id} r={r} onOpen={(x) => setOpenId(x.id)} />)}</div>
        )}
      </section>
      <ReportDetail id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
