import { useCallback, useEffect, useRef, useState } from 'react';
import { computeStats } from '@shared/report';
import type { AuditEntry, ClientReport, ScopeStats } from '@shared/types';
import { inScope, isStaffRole } from '../../db/hooks';
import { db } from '../../db/localDb';
import { api, ApiError, NetworkError } from '../../lib/api';

export type QueueTab = 'emergency' | 'high' | 'open' | 'quarantine';

export interface Overview {
  stats: ScopeStats;
  trend: Array<{ date: string; avgDays: number; resolved: number }>;
  targetDays: number;
  ranking: Array<{ wardCode: string; name: string; total: number; resolved: number; avgDays: number }>;
}

export interface LoadState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** true khi đang hiển thị dữ liệu IndexedDB do không gọi được máy chủ */
  stale: boolean;
  reload: () => void;
}

const open = (r: ClientReport): boolean => !['resolved', 'quarantined', 'rejected'].includes(r.status);

/** Bộ lọc hàng đợi cục bộ (phản chiếu logic server) dùng khi ngoại tuyến. */
export function localQueue(rows: ClientReport[], scope: string, tab: QueueTab): ClientReport[] {
  const s = rows.filter((r) => inScope(r, scope));
  switch (tab) {
    case 'emergency': return s.filter((r) => open(r) && (r.emergencyLevel === 1 || r.priority === 'emergency'));
    case 'high': return s.filter((r) => open(r) && r.priority === 'high' && (r.clusterCount >= 2 || r.confirmCount >= 3));
    case 'open': return s.filter(open);
    case 'quarantine': return s.filter((r) => r.status === 'quarantined');
  }
}

function useLoader<T>(key: string, fetcher: () => Promise<T>, local: () => Promise<T>, refreshMs = 0): LoadState<T> {
  const [state, setState] = useState<Omit<LoadState<T>, 'reload'>>({ data: null, loading: true, error: null, stale: false });
  const seq = useRef(0);
  const fetchRef = useRef(fetcher);
  const localRef = useRef(local);
  fetchRef.current = fetcher;
  localRef.current = local;

  const run = useCallback(async () => {
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: s.data === null }));
    try {
      const data = await fetchRef.current();
      if (id === seq.current) setState({ data, loading: false, error: null, stale: false });
    } catch (e) {
      if (id !== seq.current) return;
      if (e instanceof NetworkError) {
        try {
          const data = await localRef.current();
          setState({ data, loading: false, error: null, stale: true });
        } catch (le) {
          setState({ data: null, loading: false, error: le instanceof Error ? le.message : 'Local error', stale: false });
        }
      } else {
        setState((s) => ({ ...s, loading: false, error: e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Error' }));
      }
    }
  }, []);

  useEffect(() => {
    void run();
    if (!refreshMs) return;
    const t = window.setInterval(() => void run(), refreshMs);
    return () => window.clearInterval(t);
  }, [key, run, refreshMs]);

  return { ...state, reload: () => void run() };
}

export function useOverview(scope: string): LoadState<Overview> {
  return useLoader<Overview>(
    `ov:${scope}`,
    () => api<Overview>(`/api/admin/overview?scope=${encodeURIComponent(scope)}`),
    async () => {
      const rows = (await db.reports.toArray()).filter((r) => inScope(r, scope));
      return { stats: computeStats(rows, scope), trend: [], targetDays: 1.5, ranking: [] };
    },
    30_000,
  );
}

export function useQueue(scope: string, tab: QueueTab): LoadState<ClientReport[]> {
  return useLoader<ClientReport[]>(
    `q:${scope}:${tab}`,
    async () => {
      const rows = await api<ClientReport[]>(`/api/admin/queue?scope=${encodeURIComponent(scope)}&tab=${tab}`);
      await db.reports.bulkPut(rows.map((r) => ({ ...r, syncState: 'synced' as const })));
      return rows;
    },
    async () => localQueue(await db.reports.toArray(), scope, tab),
    20_000,
  );
}

export function useQueueCounts(scope: string): Record<QueueTab, number> | null {
  const [counts, setCounts] = useState<Record<QueueTab, number> | null>(null);
  useEffect(() => {
    let alive = true;
    const calc = async (): Promise<void> => {
      const rows = (await db.reports.toArray()).filter((r) => inScope(r, scope));
      const c = (tab: QueueTab): number => localQueue(rows, scope, tab).length;
      if (alive) setCounts({ emergency: c('emergency'), high: c('high'), open: c('open'), quarantine: c('quarantine') });
    };
    void calc();
    const id = window.setInterval(() => void calc(), 4000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [scope]);
  return counts;
}

export function useAudit(): LoadState<AuditEntry[]> {
  return useLoader<AuditEntry[]>('audit', () => api<AuditEntry[]>('/api/admin/audit?limit=200'), async () => [], 0);
}

export { isStaffRole };
