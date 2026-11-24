import type { AuditEntry, Role } from '../../../shared/types';
import type { AuditRepository } from '../repositories/types';
import { newId, sha256 } from '../utils/crypto';

export interface Actor {
  id: string;
  name: string;
  role: Role | 'system';
}

export const SYSTEM_ACTOR: Actor = { id: 'system', name: 'Hệ thống SmartCitizen', role: 'system' };

export function computeAuditHash(e: Omit<AuditEntry, 'hash'>): string {
  return sha256(
    [e.prevHash, e.seq, e.actorId, e.role, e.action, e.targetId, e.timestamp, JSON.stringify(e.beforeState ?? null), JSON.stringify(e.afterState ?? null)].join('|'),
  );
}

/**
 * Nhật ký kiểm toán bất biến: chỉ append, mỗi bản ghi chứa hash liên kết bản ghi trước (hash chain)
 * nên mọi sửa/xóa lén ở tầng lưu trữ đều bị phát hiện bởi verifyChain().
 */
export class AuditService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly repo: AuditRepository) {}

  log(actor: Actor, action: string, targetId: string, beforeState: unknown, afterState: unknown): Promise<AuditEntry> {
    const task = this.queue.then(async () => {
      const prev = await this.repo.last();
      const partial: Omit<AuditEntry, 'hash'> = {
        id: newId('au'),
        seq: (prev?.seq ?? 0) + 1,
        actorId: actor.id,
        actorName: actor.name,
        role: actor.role,
        action,
        targetId,
        beforeState: beforeState ?? null,
        afterState: afterState ?? null,
        timestamp: new Date().toISOString(),
        prevHash: prev?.hash ?? 'GENESIS',
      };
      const entry: AuditEntry = { ...partial, hash: computeAuditHash(partial) };
      await this.repo.append(entry);
      return entry;
    });
    this.queue = task.catch((err) => {
      console.error('[audit] Ghi nhật ký thất bại:', err);
    });
    return task;
  }

  list(limit = 200): Promise<AuditEntry[]> {
    return this.repo.list(Math.min(Math.max(limit, 1), 1000));
  }

  async verifyChain(): Promise<{ valid: boolean; total: number; brokenAtSeq: number | null }> {
    const all = await this.repo.all();
    let prevHash = 'GENESIS';
    for (const e of all) {
      const { hash, ...rest } = e;
      if (e.prevHash !== prevHash || computeAuditHash(rest) !== hash) {
        return { valid: false, total: all.length, brokenAtSeq: e.seq };
      }
      prevHash = hash;
    }
    return { valid: true, total: all.length, brokenAtSeq: null };
  }
}
