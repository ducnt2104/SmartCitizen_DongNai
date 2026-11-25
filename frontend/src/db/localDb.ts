import Dexie, { type Table } from 'dexie';
import type { ClientReport, VisionResult, Ward } from '@shared/types';

export type OutboxKind = 'create_report' | 'confirm' | 'attach_photo' | 'rate' | 'proxy_report';
export type OutboxState = 'pending' | 'sending' | 'waiting_auth' | 'failed';

export interface OutboxItem {
  /** idempotencyKey — cũng là khóa chính để đồng bộ lại an toàn (exactly-once ở phía server) */
  id: string;
  kind: OutboxKind;
  /** Hồ sơ đích (confirm / attach_photo / rate) hoặc id hồ sơ cục bộ (create_report) */
  targetId: string;
  payload: unknown;
  state: OutboxState;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
}

export interface AiCacheRow {
  dHash: string;
  sha256?: string;
  result: VisionResult;
  at: number;
}

export interface SettingRow {
  key: string;
  value: unknown;
}

class LocalDb extends Dexie {
  reports!: Table<ClientReport, string>;
  wards!: Table<Ward, string>;
  outboxQueue!: Table<OutboxItem, string>;
  aiVisionCache!: Table<AiCacheRow, string>;
  settings!: Table<SettingRow, string>;

  constructor() {
    super('smartcitizen_dongnai');
    this.version(1).stores({
      reports: 'id, wardCode, status, category, createdAt, syncState',
      wards: 'wardCode, zone',
      outboxQueue: 'id, state, nextAttemptAt, createdAt',
      aiVisionCache: 'dHash, at',
      settings: 'key',
    });
    this.version(2).stores({
      reports: 'id, wardCode, status, category, createdAt, syncState',
      wards: 'wardCode, zone',
      outboxQueue: 'id, state, nextAttemptAt, createdAt',
      aiVisionCache: 'dHash, sha256, at',
      settings: 'key',
    });
  }
}

export const db = new LocalDb();

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key);
  return row ? (row.value as T) : fallback;
}

export async function putSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value });
}
