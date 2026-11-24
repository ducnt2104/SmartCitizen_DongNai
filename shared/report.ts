import type { Category, ClientReport, Report, ScopeStats } from './types';
import { CATEGORIES } from './types';

export function toClientReport(r: Report): ClientReport {
  const { reporterId: _rid, contributors, confirmations, ...rest } = r;
  void _rid;
  return { ...rest, confirmCount: confirmations.length, contributorCount: contributors.length };
}

type StatsInput = Pick<ClientReport, 'category' | 'status' | 'createdAt' | 'resolvedAt' | 'isEmergency' | 'slaDueAt' | 'wardCode'>;

/** Thống kê dùng chung cho server và bản local-first để hai nơi luôn cho cùng số liệu. */
export function computeStats(list: readonly StatsInput[], scope: string, nowMs: number = Date.now()): ScopeStats {
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  let resolved = 0;
  let sumMs = 0;
  let emergency = 0;
  let quarantined = 0;
  let slaOverdue = 0;
  for (const r of list) {
    byCategory[r.category] += 1;
    if (r.status === 'resolved' && r.resolvedAt) {
      resolved += 1;
      sumMs += Date.parse(r.resolvedAt) - Date.parse(r.createdAt);
    } else if (r.status !== 'quarantined' && r.status !== 'rejected') {
      if (r.isEmergency) emergency += 1;
      if (r.slaDueAt && Date.parse(r.slaDueAt) < nowMs) slaOverdue += 1;
    }
    if (r.status === 'quarantined') quarantined += 1;
  }
  const total = list.length;
  return {
    scope,
    total,
    resolved,
    open: total - resolved,
    resolvedPct: total === 0 ? 0 : Math.round((resolved / total) * 1000) / 10,
    avgDays: resolved === 0 ? 0 : Math.round((sumMs / resolved / 86400000) * 10) / 10,
    byCategory,
    emergency,
    quarantined,
    slaOverdue,
  };
}
