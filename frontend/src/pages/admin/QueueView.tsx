import { AlertTriangle, CheckCircle2, Flame, Layers, Search, ShieldAlert, ShieldCheck, ListChecks, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Category, ClientReport } from '@shared/types';
import { SlaClock } from '../../components/Timeline';
import { useTableVirtualWindow } from '../../components/VirtualList';
import { EmptyState, ErrorState, Spinner } from '../../components/ui';
import { DONG_NAI_WARDS, WARD_BY_CODE } from '../../data/dongNaiWards';
import { useI18n, type I18nKey } from '../../i18n';
import { api } from '../../lib/api';
import { CATEGORY_META, STATUS_KEY } from '../../lib/meta';
import { invalidateSwrPrefix } from '../../lib/swrCache';
import { useToast } from '../../state/toast';
import { ReportPanel } from './ReportPanel';
import { useQueue, useQueueCounts, type QueueTab } from './useAdminData';
import { db } from '../../db/localDb';

type ExtendedTab = QueueTab | 'moderation';

interface ModerationQueueItem {
  report: ClientReport;
  kind: 'report_intake' | 'resolution_proof';
  authenticityScore: number;
  forensicFlags: string[];
  evidenceSummary: string;
}

const TABS: Array<{ k: ExtendedTab; label: I18nKey; icon: typeof Flame; tone: string }> = [
  { k: 'emergency', label: 'ioc.tab.emergency', icon: Flame, tone: 'text-ioc-red' },
  { k: 'high', label: 'ioc.tab.high', icon: Layers, tone: 'text-ioc-amber' },
  { k: 'open', label: 'ioc.tab.open', icon: ListChecks, tone: 'text-ioc-cyan' },
  { k: 'quarantine', label: 'ioc.tab.quarantine', icon: ShieldAlert, tone: 'text-ioc-amber' },
  { k: 'moderation', label: 'ioc.tab.moderation', icon: ShieldCheck, tone: 'text-ioc-cyan' },
];
const CATS: Category[] = ['rac_thai', 'den_duong', 'ngap_nuoc', 'mat_duong', 'khac'];

function weight(r: ClientReport): number {
  return (r.emergencyLevel === 1 ? 0 : r.priority === 'emergency' ? 1 : r.priority === 'high' ? 2 : 3);
}

/** Trạm Duyệt đơn AI — 5 tab thông minh (gồm Hàng đợi Kiểm duyệt ảnh), bảng mật độ cao, phím tắt. */
export function QueueView({ scope, isCity, online }: { scope: string; isCity: boolean; online: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const [tab, setTab] = useState<ExtendedTab>('emergency');
  const queueTab: QueueTab = tab === 'moderation' ? 'open' : tab;
  const q = useQueue(scope, queueTab);
  const counts = useQueueCounts(scope);
  const [modItems, setModItems] = useState<ModerationQueueItem[]>([]);
  const [modLoading, setModLoading] = useState(false);
  const [modBusyId, setModBusyId] = useState<string | null>(null);
  const [modNote, setModNote] = useState<Record<string, string>>({});
  const [cat, setCat] = useState<Category | ''>('');
  const [ward, setWard] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [text, setText] = useState('');
  const [slaOnly, setSlaOnly] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  const loadModeration = useCallback(async () => {
    if (!online) return;
    setModLoading(true);
    try {
      const items = await api<ModerationQueueItem[]>(`/api/admin/moderation-queue?scope=${encodeURIComponent(scope)}`);
      setModItems(items);
    } catch {
      /* giữ danh sách hiện tại */
    } finally {
      setModLoading(false);
    }
  }, [online, scope]);

  useEffect(() => {
    void loadModeration();
  }, [loadModeration, tab]);

  useEffect(() => {
    const timer = window.setTimeout(() => setText(searchInput), 120);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const modMap = useMemo(() => {
    const m = new Map<string, ModerationQueueItem>();
    for (const it of modItems) m.set(it.report.id, it);
    return m;
  }, [modItems]);

  const rows = useMemo(() => {
    const source = tab === 'moderation' ? modItems.map((m) => m.report) : (q.data ?? []);
    const list = source.filter((r) => {
      if (cat && r.category !== cat) return false;
      if (ward && r.wardCode !== ward) return false;
      if (slaOnly && !(r.slaDueAt && Date.parse(r.slaDueAt) < Date.now() && r.status !== 'resolved')) return false;
      if (text) {
        const s = text.toLowerCase();
        if (!`${r.code} ${r.title} ${r.address}`.toLowerCase().includes(s)) return false;
      }
      return true;
    });
    return [...list].sort((a, b) =>
      tab === 'quarantine' || tab === 'moderation'
        ? b.createdAt.localeCompare(a.createdAt)
        : weight(a) - weight(b) || (a.slaDueAt ?? '9').localeCompare(b.slaDueAt ?? '9'),
    );
  }, [q.data, modItems, cat, ward, text, slaOnly, tab]);

  const selected = rows.find((r) => r.id === sel) ?? null;
  const canAct = online && !q.stale;
  const vWin = useTableVirtualWindow(rows, { rowHeightPx: 46, virtualizeAbove: 30 });
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  const decideModeration = useCallback(
    async (reportId: string, decision: 'APPROVE' | 'REJECT') => {
      setModBusyId(reportId);
      try {
        const updated = await api<ClientReport>(`/api/admin/moderation-queue/${reportId}/decide`, {
          method: 'POST',
          body: { decision, note: modNote[reportId]?.trim() || undefined },
        });
        await db.reports.put({ ...updated, syncState: 'synced' });
        invalidateSwrPrefix('q:');
        invalidateSwrPrefix('ov:');
        toast('success', decision === 'APPROVE' ? 'Đã phê duyệt kiểm định thủ công' : 'Đã từ chối bằng chứng / ảnh đáng ngờ');
        setSel((cur) => (cur === reportId ? null : cur));
        await loadModeration();
        q.reload();
      } catch (e) {
        toast('error', t('ioc.actionFail'), e instanceof Error ? e.message : undefined);
      } finally {
        setModBusyId(null);
      }
    },
    [loadModeration, modNote, q, t, toast],
  );

  const quickRestore = useCallback(async (r: ClientReport) => {
    const snapshot = q.data;
    q.mutate((prev) => (prev ? prev.filter((item) => item.id !== r.id) : prev));
    try {
      const upd = await api<ClientReport>(`/api/admin/reports/${r.id}/restore`, { method: 'POST', body: {} });
      await db.reports.put({ ...upd, syncState: 'synced' });
      invalidateSwrPrefix('q:');
      invalidateSwrPrefix('ov:');
      toast('success', t('ioc.restored'));
      q.reload();
    } catch (e) {
      q.mutate(() => snapshot);
      toast('error', t('ioc.actionFail'), e instanceof Error ? e.message : undefined);
    }
  }, [q, t, toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
      const idx = ['1', '2', '3', '4', '5'].indexOf(e.key);
      if (idx >= 0) { setTab(TABS[idx].k); setSel(null); setCursor(0); return; }
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(rows.length - 1, c + 1)); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
      else if (e.key === 'Enter' && rows[cursor]) setSel(rows[cursor].id);
      else if (e.key === 'Escape') setSel(null);
      else if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === 'r' && tab === 'quarantine' && rows[cursor] && canAct) void quickRestore(rows[cursor]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, cursor, tab, canAct, quickRestore]);

  const wardOptions = isCity ? DONG_NAI_WARDS : DONG_NAI_WARDS.filter((w) => `ward:${w.wardCode}` === scope);

  return (
    <div className="space-y-3">
      <div role="tablist" aria-label={t('ioc.queue')} className="grid grid-cols-2 gap-2 xl:grid-cols-5">
        {TABS.map((tb, i) => {
          const Icon = tb.icon;
          const active = tab === tb.k;
          const count = tb.k === 'moderation' ? modItems.length : counts?.[tb.k];
          return (
            <button key={tb.k} type="button" role="tab" aria-selected={active} onClick={() => { setTab(tb.k); setSel(null); setCursor(0); }}
              className={`ioc-panel flex min-h-14 items-center gap-2 px-3 py-2 text-left ${active ? '!border-cyan-400/70 bg-ioc-raised' : ''}`}>
              <Icon className={`h-5 w-5 shrink-0 ${tb.tone}`} aria-hidden />
              <span className="min-w-0 flex-1 text-xs font-semibold leading-tight">{t(tb.label)}</span>
              <span className="mono text-xl font-bold">{count ?? '·'}</span>
              <kbd className="mono hidden rounded border border-ioc-line px-1 text-[10px] text-ioc-dim sm:block">{i + 1}</kbd>
            </button>
          );
        })}
      </div>

      <div className="ioc-panel flex flex-wrap items-center gap-2 p-2">
        <div className="relative min-w-[10rem] flex-1">
          <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-ioc-dim" aria-hidden />
          <input ref={searchRef} className="ioc-field w-full !pl-8" placeholder={t('ioc.searchPlaceholder')} value={searchInput} onChange={(e) => setSearchInput(e.target.value)} aria-label={t('ioc.searchPlaceholder')} />
        </div>
        <select className="ioc-field" value={cat} onChange={(e) => setCat(e.target.value as Category | '')} aria-label={t('detail.category')}>
          <option value="">{t('ioc.allCategories')}</option>
          {CATS.map((c) => <option key={c} value={c}>{t(CATEGORY_META[c].labelKey)}</option>)}
        </select>
        {wardOptions.length > 1 && (
          <select className="ioc-field max-w-[11rem]" value={ward} onChange={(e) => setWard(e.target.value)} aria-label={t('ioc.colWard')}>
            <option value="">{t('ioc.allWards')}</option>
            {wardOptions.map((w) => <option key={w.wardCode} value={w.wardCode}>{w.name}</option>)}
          </select>
        )}
        <button type="button" aria-pressed={slaOnly} className={`ioc-btn ${slaOnly ? 'ioc-btn-red' : ''}`} onClick={() => setSlaOnly((v) => !v)}><AlertTriangle className="h-4 w-4" aria-hidden />{t('ioc.slaOverdue')}</button>
        <p className="mono hidden text-[10px] text-ioc-dim xl:block">{t('ioc.shortcuts')}</p>
      </div>
      {q.stale && <p className="rounded border border-ioc-amber/40 bg-ioc-amber/10 px-3 py-2 text-xs font-semibold text-ioc-amber">{t('ioc.staleData')}</p>}

      {tab === 'moderation' ? (
        <div className={`grid gap-3 ${selected ? 'lg:grid-cols-[minmax(0,1fr)_25rem]' : ''}`}>
          <div className="ioc-panel min-w-0 space-y-2 p-3">
            {modLoading && modItems.length === 0 ? (
              <div className="flex justify-center p-6"><Spinner /></div>
            ) : rows.length === 0 ? (
              <EmptyState dark kind="shield" title={t('ioc.empty.moderation')} text={t('ioc.emptyText')} />
            ) : (
              rows.map((r) => {
                const mod = modMap.get(r.id);
                if (!mod) return null;
                return (
                  <div
                    key={r.id}
                    onClick={() => setSel(r.id)}
                    className={`cursor-pointer rounded-lg border p-3 transition-colors ${sel === r.id ? 'border-cyan-400/70 bg-ioc-raised' : 'border-ioc-line/80 bg-ioc-panel hover:bg-ioc-raised/60'}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="mono text-xs font-bold text-ioc-cyan">{r.code}</span>
                        <span className={`mono rounded border px-1.5 py-0.5 text-[10px] font-bold ${mod.kind === 'resolution_proof' ? 'border-amber-400/50 bg-amber-500/15 text-ioc-amber' : 'border-cyan-400/50 bg-cyan-500/15 text-ioc-cyan'}`}>
                          {mod.kind === 'resolution_proof' ? 'ẢNH HOÀN THÀNH (BEFORE/AFTER)' : 'BÁO CÁO NGHI VẤN'}
                        </span>
                        <span className="text-xs text-ioc-dim">{WARD_BY_CODE[r.wardCode]?.name}</span>
                      </div>
                      <span className="mono text-xs font-bold text-ioc-amber">
                        Điểm tin cậy AI: {Math.round(mod.authenticityScore)}/100
                      </span>
                    </div>
                    <p className="mt-1.5 text-sm font-semibold text-ioc-text">{r.title}</p>
                    <p className="mt-1 text-xs text-ioc-dim">{mod.evidenceSummary}</p>
                    {mod.forensicFlags.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {mod.forensicFlags.map((flag) => (
                          <span key={flag} className="mono rounded border border-ioc-amber/40 bg-ioc-amber/10 px-1.5 py-0.5 text-[10px] text-ioc-amber">
                            {flag}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="mt-2.5 flex flex-wrap items-center gap-2" onClick={(ev) => ev.stopPropagation()}>
                      <input
                        className="ioc-field flex-1 !py-1 text-xs"
                        placeholder="Ghi chú kiểm duyệt viên (tùy chọn)…"
                        value={modNote[r.id] ?? ''}
                        onChange={(ev) => setModNote((prev) => ({ ...prev, [r.id]: ev.target.value }))}
                      />
                      <button
                        type="button"
                        className="ioc-btn ioc-btn-green !min-h-7 !px-2.5 !text-xs"
                        disabled={!online || modBusyId !== null}
                        onClick={() => void decideModeration(r.id, 'APPROVE')}
                      >
                        {modBusyId === r.id ? <Spinner /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />} Duyệt
                      </button>
                      <button
                        type="button"
                        className="ioc-btn ioc-btn-red !min-h-7 !px-2.5 !text-xs"
                        disabled={!online || modBusyId !== null}
                        onClick={() => void decideModeration(r.id, 'REJECT')}
                      >
                        <XCircle className="h-3.5 w-3.5" aria-hidden /> Từ chối
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          {selected && (
            <ReportPanel key={selected.id} report={selected} canAct={canAct} onClose={() => setSel(null)} onChanged={() => { q.reload(); void loadModeration(); }} />
          )}
        </div>
      ) : (
        <div className={`grid gap-3 ${selected ? 'lg:grid-cols-[minmax(0,1fr)_25rem]' : ''}`}>
          <div className="ioc-panel min-w-0 overflow-hidden">
            {q.loading && !q.data ? (
              <div className="space-y-1 p-2">{Array.from({ length: 6 }, (_, i) => <div key={i} className="ioc-skeleton h-9" />)}</div>
            ) : q.error ? (
              <div className="text-ioc-text"><ErrorState title={q.error} onRetry={q.reload} /></div>
            ) : rows.length === 0 ? (
              <EmptyState dark kind={tab === 'quarantine' ? 'shield' : 'empty'} title={t(`ioc.empty.${tab}` as I18nKey)} text={t('ioc.emptyText')}
                action={(cat || ward || text || slaOnly) ? <button type="button" className="ioc-btn ioc-btn-cyan" onClick={() => { setCat(''); setWard(''); setSearchInput(''); setText(''); setSlaOnly(false); }}>{t('empty.clearFilters')}</button> : undefined} />
            ) : (
              <div ref={vWin.scrollRef} onScroll={(e) => vWin.onScroll(e.currentTarget.scrollTop)} className="max-h-[68dvh] overflow-auto">
                <table className="w-full min-w-[44rem] text-sm">
                  <thead className="sticky top-0 z-10 bg-ioc-panel">
                    <tr className="border-b border-ioc-line">
                      <th className="ioc-th">{t('detail.code')}</th><th className="ioc-th">{t('ioc.colTitle')}</th><th className="ioc-th">{t('ioc.colWard')}</th>
                      <th className="ioc-th">{t('ioc.colStatus')}</th><th className="ioc-th text-right">{t('ioc.colCluster')}</th><th className="ioc-th text-right">SLA</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vWin.topSpacerPx > 0 && (
                      <tr aria-hidden><td colSpan={6} style={{ height: vWin.topSpacerPx }} /></tr>
                    )}
                    {vWin.visibleRows.map((r, offset) => {
                      const i = vWin.startIndex + offset;
                      const Icon = CATEGORY_META[r.category].icon;
                      return (
                        <tr key={r.id} onClick={() => { setSel(r.id); setCursor(i); }} aria-selected={sel === r.id}
                          className={`cursor-pointer border-b border-ioc-line/60 hover:bg-ioc-raised ${sel === r.id ? 'bg-ioc-raised' : ''} ${cursor === i ? 'outline outline-1 -outline-offset-1 outline-cyan-400/60' : ''}`}>
                          <td className="mono whitespace-nowrap px-3 py-1.5 text-xs text-ioc-cyan">
                            {r.emergencyLevel === 1 && <Flame className="mr-1 inline h-3.5 w-3.5 text-ioc-red" aria-label={t('badge.emergency1')} />}{r.code}
                          </td>
                          <td className="max-w-[16rem] px-3 py-1.5"><span className="flex items-center gap-1.5"><Icon className="h-3.5 w-3.5 shrink-0" style={{ color: CAT_COLOR(r.category) }} aria-hidden /><span className="truncate">{r.title}</span></span>
                            {r.seniorSubmitted && <span className="text-[10px] font-bold text-ioc-amber">{t('badge.senior')}</span>}
                          </td>
                          <td className="whitespace-nowrap px-3 py-1.5 text-xs text-ioc-dim">{WARD_BY_CODE[r.wardCode]?.name}</td>
                          <td className="whitespace-nowrap px-3 py-1.5 text-xs">
                            {t(STATUS_KEY[r.status])}
                            {r.quarantine && <span className="ml-1 text-ioc-amber">· {t(`quarantine.${r.quarantine.reason}` as I18nKey)}</span>}
                            {!r.quarantine && (r.needsManualReview || r.aiFlag || r.ai?.moderationDecision === 'HUMAN_REVIEW') && (
                              <span className="ml-1 rounded bg-ioc-amber/20 px-1.5 py-0.5 text-[10px] font-semibold text-ioc-amber">
                                {t('ioc.softFlagBadge')}
                              </span>
                            )}
                          </td>
                          <td className="mono px-3 py-1.5 text-right text-xs">{r.clusterCount}<span className="text-ioc-dim"> · {r.confirmCount}✓</span></td>
                          <td className="px-3 py-1.5 text-right">{r.status === 'resolved' || r.status === 'quarantined' ? <span className="mono text-xs text-ioc-dim">—</span> : <SlaClock iso={r.slaDueAt} dark />}</td>
                        </tr>
                      );
                    })}
                    {vWin.bottomSpacerPx > 0 && (
                      <tr aria-hidden><td colSpan={6} style={{ height: vWin.bottomSpacerPx }} /></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          {selected && (
            <ReportPanel key={selected.id} report={selected} canAct={canAct} onClose={() => setSel(null)} onChanged={() => q.reload()} />
          )}
        </div>
      )}
    </div>
  );
}

function CAT_COLOR(c: Category): string {
  return { rac_thai: '#FBBF24', den_duong: '#22D3EE', ngap_nuoc: '#60A5FA', mat_duong: '#A3A3A3', khac: '#C084FC' }[c];
}
