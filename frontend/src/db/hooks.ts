import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import { computeStats } from '@shared/report';
import type { ClientReport, Role, ScopeStats } from '@shared/types';
import { useSession } from '../lib/authStore';
import { db, type OutboxItem } from './localDb';

export function useOnline(): boolean {
  const [on, setOn] = useState(navigator.onLine);
  useEffect(() => {
    const a = (): void => setOn(true);
    const b = (): void => setOn(false);
    window.addEventListener('online', a);
    window.addEventListener('offline', b);
    return () => {
      window.removeEventListener('online', a);
      window.removeEventListener('offline', b);
    };
  }, []);
  return on;
}

export function isStaffRole(role: Role | undefined): boolean {
  return role === 'ward_officer' || role === 'city_admin';
}

/** Quy tắc hiển thị: hồ sơ cách ly/từ chối chỉ chủ đơn, cán bộ, hoặc tình nguyện viên (nhiệm vụ) mới thấy. */
export function visibleTo(r: ClientReport, role: Role | undefined): boolean {
  if (r.status !== 'quarantined' && r.status !== 'rejected') return true;
  if (r.mine) return true;
  if (isStaffRole(role)) return true;
  return role === 'volunteer' && r.needsFieldVerification;
}

export function inScope(r: ClientReport, scope: string): boolean {
  return scope === 'city' || r.wardCode === scope.replace(/^ward:/, '');
}

/** undefined = đang đọc IndexedDB (hiển thị Skeleton). */
export function useAllReports(): ClientReport[] | undefined {
  const session = useSession();
  const role = session?.user.role;
  const rows = useLiveQuery(() => db.reports.toArray(), []);
  return useMemo(() => rows?.filter((r) => visibleTo(r, role)), [rows, role]);
}

export function useScopedReports(scope: string): ClientReport[] | undefined {
  const all = useAllReports();
  return useMemo(() => all?.filter((r) => inScope(r, scope)), [all, scope]);
}

/** Số liệu KPI: ưu tiên bản chụp từ máy chủ/seed (đủ 64 hồ sơ), dự phòng tính từ dữ liệu cục bộ. */
export function useStats(scope: string): ScopeStats | undefined {
  const snap = useLiveQuery(() => db.settings.get(`stats:${scope}`), [scope]);
  const local = useLiveQuery(async () => {
    const rows = await db.reports.toArray();
    return computeStats(rows.filter((r) => inScope(r, scope)), scope);
  }, [scope]);
  if (snap === undefined || local === undefined) return undefined;
  return (snap?.value as ScopeStats | undefined) ?? local;
}

export function useOutbox(): OutboxItem[] {
  return useLiveQuery(() => db.outboxQueue.orderBy('createdAt').toArray(), []) ?? [];
}

export function useMyReports(): ClientReport[] | undefined {
  const rows = useLiveQuery(() => db.reports.toArray(), []);
  return useMemo(() => rows?.filter((r) => r.mine).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [rows]);
}
