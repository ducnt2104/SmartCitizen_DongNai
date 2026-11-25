import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { SecurityAuditLog, type ISecurityAuditLog } from '../models/SecurityAuditLog';
import { newId } from '../utils/crypto';

export interface SecurityAuditInput {
  actorId: string;
  actorName: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  ip?: string;
  deviceHash?: string;
  userAgent?: string;
  beforeState?: unknown;
  afterState?: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * Dịch vụ ghi vết bảo mật bất biến vào collection `SecurityAuditLogs` trên MongoDB Atlas
 * (có fallback append-only JSONL cục bộ khi DB Cloud đang reconnect hoặc chạy test cục bộ).
 */
export class SecurityAuditService {
  private readonly fallbackFile: string;

  constructor(dataDir = env.dataDir) {
    this.fallbackFile = path.join(dataDir, 'security_audit_logs.jsonl');
  }

  async log(input: SecurityAuditInput): Promise<ISecurityAuditLog> {
    const doc: ISecurityAuditLog = {
      id: newId('sal'),
      actorId: String(input.actorId || 'anonymous').slice(0, 120),
      actorName: String(input.actorName || 'Unknown').slice(0, 120),
      actorRole: String(input.actorRole || 'anonymous').slice(0, 40),
      action: String(input.action).slice(0, 120),
      targetType: String(input.targetType).slice(0, 64),
      targetId: String(input.targetId).slice(0, 128),
      ip: String(input.ip ?? '').slice(0, 64),
      deviceHash: String(input.deviceHash ?? '').slice(0, 64),
      userAgent: String(input.userAgent ?? '').slice(0, 200),
      beforeState: input.beforeState ?? null,
      afterState: input.afterState ?? null,
      metadata: input.metadata,
      createdAt: new Date(),
    };

    if (mongoose.connection.readyState === 1) {
      try {
        await SecurityAuditLog.create(doc);
        return doc;
      } catch (err) {
        console.warn(
          '[security-audit] Ghi MongoDB thất bại, chuyển sang fallback JSONL:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    try {
      fs.mkdirSync(path.dirname(this.fallbackFile), { recursive: true });
      fs.appendFileSync(this.fallbackFile, `${JSON.stringify(doc)}\n`, 'utf8');
    } catch (err) {
      console.error('[security-audit] Không ghi được log cục bộ:', err);
    }
    return doc;
  }

  async listRecent(opts: { action?: string; actorId?: string; limit?: number } = {}): Promise<ISecurityAuditLog[]> {
    const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);

    if (mongoose.connection.readyState === 1) {
      const filter: Record<string, unknown> = {};
      if (opts.action) filter.action = new RegExp(opts.action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      if (opts.actorId) filter.actorId = opts.actorId;
      const rows = (await SecurityAuditLog.find(filter).sort({ createdAt: -1 }).limit(limit).lean()) as Array<
        ISecurityAuditLog & { _id?: unknown }
      >;
      return rows.map(({ _id, ...rest }) => {
        void _id;
        return rest;
      });
    }

    try {
      if (!fs.existsSync(this.fallbackFile)) return [];
      const lines = fs.readFileSync(this.fallbackFile, 'utf8').trim().split('\n').filter(Boolean);
      const parsed = lines
        .map((line) => {
          try {
            return JSON.parse(line) as ISecurityAuditLog;
          } catch {
            return null;
          }
        })
        .filter((x): x is ISecurityAuditLog => x !== null)
        .reverse();
      return parsed
        .filter((row) => {
          if (opts.actorId && row.actorId !== opts.actorId) return false;
          if (opts.action && !row.action.toLowerCase().includes(opts.action.toLowerCase())) return false;
          return true;
        })
        .slice(0, limit);
    } catch {
      return [];
    }
  }
}
