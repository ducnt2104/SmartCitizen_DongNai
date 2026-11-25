import type { ClientReport, ScopeStats, UserProfile } from '@shared/types';
import { api, apiMultipart, ApiError, NetworkError } from '../lib/api';
import { authStore } from '../lib/authStore';
import { db, putSetting, type OutboxItem, type OutboxKind } from './localDb';

export type SyncEventDetail =
  | { type: 'report_result'; localId: string; outcome: string; messageCode: string; report: ClientReport }
  | { type: 'item_failed'; item: OutboxItem; message: string }
  | { type: 'synced'; at: number };

export const syncBus = new EventTarget();
const emit = (d: SyncEventDetail): void => {
  syncBus.dispatchEvent(new CustomEvent('sync', { detail: d }));
};

export function backoffMs(attempts: number): number {
  return Math.min(300_000, 2000 * 2 ** attempts) + Math.floor(Math.random() * 800);
}

// ── Kéo dữ liệu công khai về IndexedDB (nền, không chặn UI) ─────────────────────
let refreshing: Promise<boolean> | null = null;

export function refreshFromServer(): Promise<boolean> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    if (!navigator.onLine) return false;
    try {
      const list = await api<ClientReport[]>('/api/reports?scope=city');
      let mineIds = new Set<string>();
      if (authStore.token()) {
        try {
          const mine = await api<ClientReport[]>('/api/reports/mine');
          mineIds = new Set(mine.map((r) => r.id));
          const me = await api<{ user: UserProfile }>('/api/me');
          authStore.updateUser(me.user);
          for (const m of mine) if (!list.some((r) => r.id === m.id)) list.push(m);
        } catch (err) {
          if (!(err instanceof NetworkError)) console.warn('Không đồng bộ được hồ sơ của tôi:', err);
        }
      }
      const existing = await db.reports.toArray();
      const prevMine = new Set(existing.filter((r) => r.mine).map((r) => r.id));
      const serverIds = new Set(list.map((r) => r.id));
      await db.transaction('rw', db.reports, async () => {
        const stale = existing.filter((r) => r.syncState !== 'pending' && !serverIds.has(r.id)).map((r) => r.id);
        if (stale.length) await db.reports.bulkDelete(stale);
        await db.reports.bulkPut(list.map((r) => ({ ...r, syncState: 'synced' as const, mine: mineIds.has(r.id) || prevMine.has(r.id) })));
      });
      const scopes = new Set(['city']);
      try {
        const cur = JSON.parse(localStorage.getItem('sc.settings.v2') ?? '{}') as { scope?: string };
        if (cur.scope) scopes.add(cur.scope);
      } catch (err) {
        console.warn('Không đọc được phạm vi hiện tại:', err);
      }
      await Promise.all([...scopes].map(async (s) => {
        const st = await api<ScopeStats>(`/api/stats?scope=${encodeURIComponent(s)}`);
        await putSetting(`stats:${s}`, st);
      }));
      emit({ type: 'synced', at: Date.now() });
      return true;
    } catch (err) {
      if (!(err instanceof NetworkError)) console.warn('Làm mới dữ liệu từ máy chủ thất bại:', err);
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// ── Outbox Queue ───────────────────────────────────────────────────────────────
export async function enqueue(item: Omit<OutboxItem, 'state' | 'attempts' | 'nextAttemptAt' | 'lastError' | 'createdAt'>): Promise<void> {
  await db.outboxQueue.put({ ...item, state: 'pending', attempts: 0, nextAttemptAt: 0, lastError: null, createdAt: Date.now() });
  void processOutbox();
}

function endpointFor(item: OutboxItem): { path: string } {
  switch (item.kind as OutboxKind) {
    case 'create_report': return { path: '/api/reports' };
    case 'proxy_report': return { path: '/api/volunteer/proxy-report' };
    case 'confirm': return { path: `/api/reports/${item.targetId}/confirm` };
    case 'attach_photo': return { path: `/api/reports/${item.targetId}/attach-photo` };
    case 'rate': return { path: `/api/reports/${item.targetId}/rate` };
  }
}

async function sendOne(item: OutboxItem): Promise<void> {
  const { path } = endpointFor(item);
  const pObj =
    item.payload && typeof item.payload === 'object'
      ? (item.payload as { displayBlob?: unknown; aiBlob?: unknown; [k: string]: unknown })
      : null;

  const res =
    pObj && pObj.displayBlob instanceof Blob
      ? await (() => {
          const fd = new FormData();
          fd.append('displayImage', pObj.displayBlob, 'display.webp');
          if (pObj.aiBlob instanceof Blob) fd.append('aiImage', pObj.aiBlob, 'ai.webp');
          const { displayBlob: _db, aiBlob: _ab, ...meta } = pObj;
          void _db;
          void _ab;
          fd.append('metadata', JSON.stringify(meta));
          return apiMultipart<{ outcome?: string; messageCode?: string; report?: ClientReport } | ClientReport>(path, {
            method: 'POST',
            body: fd,
            timeoutMs: 45_000,
          });
        })()
      : await api<{ outcome?: string; messageCode?: string; report?: ClientReport } | ClientReport>(path, {
          method: 'POST',
          body: item.kind === 'confirm' ? undefined : item.payload,
          timeoutMs: 45_000,
        });
  const isCreate = item.kind === 'create_report' || item.kind === 'proxy_report';
  const report = (isCreate ? (res as { report: ClientReport }).report : (res as ClientReport));
  await db.transaction('rw', db.reports, db.outboxQueue, async () => {
    if (isCreate) await db.reports.delete(item.targetId);
    await db.reports.put({ ...report, syncState: 'synced', mine: true });
    await db.outboxQueue.delete(item.id);
  });
  if (isCreate) {
    const r = res as { outcome: string; messageCode: string; report: ClientReport };
    emit({ type: 'report_result', localId: item.targetId, outcome: r.outcome, messageCode: r.messageCode, report: r.report });
  }
}

let running = false;

export async function processOutbox(): Promise<void> {
  if (running || !navigator.onLine) return;
  running = true;
  try {
    const items = (await db.outboxQueue.toArray()).filter((i) => i.state !== 'failed').sort((a, b) => a.createdAt - b.createdAt);
    for (const item of items) {
      if (item.nextAttemptAt > Date.now()) continue;
      if (!authStore.token()) {
        if (item.state !== 'waiting_auth') await db.outboxQueue.update(item.id, { state: 'waiting_auth' });
        continue;
      }
      await db.outboxQueue.update(item.id, { state: 'sending' });
      try {
        await sendOne(item);
      } catch (err) {
        const attempts = item.attempts + 1;
        if (err instanceof NetworkError || (err instanceof ApiError && err.status >= 500)) {
          await db.outboxQueue.update(item.id, { state: 'pending', attempts, nextAttemptAt: Date.now() + backoffMs(attempts), lastError: err.message });
        } else if (err instanceof ApiError && err.status === 401) {
          await db.outboxQueue.update(item.id, { state: 'waiting_auth', lastError: err.message });
        } else if (err instanceof ApiError && err.status === 429) {
          await db.outboxQueue.update(item.id, { state: 'pending', attempts, nextAttemptAt: Date.now() + 600_000, lastError: err.message });
          emit({ type: 'item_failed', item, message: err.message });
        } else {
          const message = err instanceof Error ? err.message : String(err);
          // Rollback Optimistic UI nếu lượt "Cùng xác nhận (+1)" bị máy chủ từ chối (4xx)
          if (item.kind === 'confirm') {
            const cur = await db.reports.get(item.targetId);
            if (cur && cur.confirmCount > 0) {
              await db.reports.update(item.targetId, { confirmCount: cur.confirmCount - 1 });
            }
            try {
              const raw = localStorage.getItem('sc.confirmed.v1');
              if (raw) {
                const next = (JSON.parse(raw) as string[]).filter((x) => x !== item.targetId);
                localStorage.setItem('sc.confirmed.v1', JSON.stringify(next));
              }
            } catch { /* bỏ qua nếu storage không khả dụng */ }
          }
          if (item.kind === 'create_report' || item.kind === 'proxy_report') {
            await db.reports.delete(item.targetId);
            await db.outboxQueue.delete(item.id);
          } else {
            await db.outboxQueue.update(item.id, { state: 'failed', attempts, lastError: message });
          }
          emit({ type: 'item_failed', item, message });
        }
      }
    }
  } finally {
    running = false;
  }
}

export async function retryFailed(id: string): Promise<void> {
  await db.outboxQueue.update(id, { state: 'pending', nextAttemptAt: 0, lastError: null });
  void processOutbox();
}

export async function discardOutboxItem(id: string): Promise<void> {
  const item = await db.outboxQueue.get(id);
  await db.transaction('rw', db.reports, db.outboxQueue, async () => {
    if (item && (item.kind === 'create_report' || item.kind === 'proxy_report')) await db.reports.delete(item.targetId);
    await db.outboxQueue.delete(id);
  });
}

export function startSyncEngine(): () => void {
  const onOnline = (): void => {
    void processOutbox().then(() => refreshFromServer());
  };
  window.addEventListener('online', onOnline);
  const unsubAuth = authStore.subscribe(() => {
    void processOutbox().then(() => refreshFromServer());
  });
  const tick = window.setInterval(() => void processOutbox(), 15_000);
  const pull = window.setInterval(() => void refreshFromServer(), 90_000);
  void refreshFromServer().then(() => processOutbox());
  return () => {
    window.removeEventListener('online', onOnline);
    unsubAuth();
    window.clearInterval(tick);
    window.clearInterval(pull);
  };
}
