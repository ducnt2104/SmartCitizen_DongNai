import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { ApiKey, type IApiKey } from '../../models/ApiKey';
import { newId } from '../../utils/crypto';
import { badRequest, notFound } from '../../utils/errors';
import {
  decryptApiKey,
  detectKeyProvider,
  encryptApiKey,
  fingerprintApiKey,
  maskApiKey,
  parseBulkApiKeys,
  shortMaskApiKey,
} from './cryptoVault';
import {
  classifyUpstreamError,
  computeCooldownMs,
  computeNextMidnightMs,
  DEFAULT_COOLDOWN_STEPS_MS,
} from './errorClassifier';
import {
  API_KEY_PROVIDERS,
  type AddApiKeyInputItem,
  type ApiKeyProvider,
  type ApiKeyTestResult,
  type BulkAddApiKeysInput,
  type BulkAddApiKeysResult,
  type ExecuteWithRotationOptions,
  type KeyHealthProbeFn,
  type KeyPoolSummary,
  type MaskedApiKeyInfo,
  type PoolKeyRecord,
  type SelectedKeyMeta,
  type UpdateApiKeyPatch,
} from './types';

export interface KeyPoolLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface KeyPoolManagerOptions {
  /** Nguồn biến môi trường (mặc định `process.env`). */
  envSource?: NodeJS.ProcessEnv;
  /** Khóa bí mật mã hóa AES-256-GCM cho API key lưu trong DB. */
  encryptionSecret?: string;
  /** Chế độ lưu trữ key Admin: `auto` (MongoDB hoặc file mã hóa cục bộ) | `memory` (chỉ RAM cho unit test). */
  persistenceMode?: 'auto' | 'memory';
  /** Thư mục dữ liệu cục bộ khi chạy chế độ JSON fallback (mặc định `./data`). */
  dataDir?: string;
  /** Lịch Exponential Backoff cho lỗi 429 tạm thời (mặc định `[60_000, 180_000, 600_000]`). */
  cooldownStepsMs?: readonly number[];
  /** Múi giờ reset quota ngày RPD (mặc định `Asia/Ho_Chi_Minh`, hỗ trợ `America/Los_Angeles`). */
  quotaResetTimeZone?: string;
  /** Số key thử tối đa mặc định trong một HTTP request (mặc định `5`). */
  defaultMaxAttempts?: number;
  /** Đồng hồ tùy chỉnh để kiểm thử định thời (mặc định `Date.now`). */
  nowFn?: () => number;
  /** Hàm kiểm tra sức khỏe key trực tiếp cho endpoint `/test`. */
  probeFn?: KeyHealthProbeFn;
  /** Bộ ghi log (mặc định `console`). */
  logger?: KeyPoolLogger;
  /** Model Gemini mặc định khi bắn request probe nhẹ. */
  defaultGeminiModel?: string;
}

export class KeyPoolExhaustedError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly lastUpstreamError?: unknown,
  ) {
    super(message);
    this.name = 'KeyPoolExhaustedError';
  }
}

interface StoredEncryptedRecord {
  keyId: string;
  label: string;
  provider: ApiKeyProvider;
  encryptedKey: string;
  iv: string;
  authTag: string;
  keyFingerprint: string;
  maskedKey: string;
  weight: number;
  isEnabled: boolean;
  status: PoolKeyRecord['status'];
  totalRequests: number;
  successCount: number;
  errorCount: number;
  error429Count: number;
  consecutive429: number;
  lastUsedAt: string | null;
  cooldownUntil: string | null;
  dailyQuotaExhaustedAt: string | null;
  quotaResetAt: string | null;
  lastError: string | null;
  addedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_LOGGER: KeyPoolLogger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
};

export class KeyPoolManager {
  private readonly keys = new Map<string, PoolKeyRecord>();
  private readonly fingerprintToId = new Map<string, string>();
  private readonly envSource: NodeJS.ProcessEnv;
  private readonly encryptionSecret: string;
  private readonly persistenceMode: 'auto' | 'memory';
  private readonly fallbackFilePath: string;
  private readonly cooldownStepsMs: readonly number[];
  private readonly quotaResetTimeZone: string;
  private readonly defaultMaxAttempts: number;
  private readonly nowFn: () => number;
  private readonly logger: KeyPoolLogger;
  private readonly defaultGeminiModel: string;
  private probeFn: KeyHealthProbeFn;

  private nextSlotNumber = 1;
  private globalUseSeq = 0;
  private dbSyncPromise: Promise<void> | null = null;
  private dbSynced = false;
  private mongoIndexesEnsured = false;

  constructor(options: KeyPoolManagerOptions = {}) {
    this.envSource = options.envSource ?? process.env;
    this.encryptionSecret =
      (options.encryptionSecret ??
        this.envSource.KEY_ENCRYPTION_SECRET ??
        this.envSource.JWT_SECRET ??
        'smartcitizen-dongnai-dev-fallback-encryption-secret-32b').trim();
    this.persistenceMode = options.persistenceMode ?? 'auto';
    const dataDir = path.resolve(options.dataDir ?? this.envSource.DATA_DIR ?? './data');
    this.fallbackFilePath = path.join(dataDir, 'api_keys.encrypted.json');
    this.cooldownStepsMs = options.cooldownStepsMs ?? DEFAULT_COOLDOWN_STEPS_MS;
    this.quotaResetTimeZone =
      (options.quotaResetTimeZone ?? this.envSource.KEY_QUOTA_RESET_TZ ?? 'Asia/Ho_Chi_Minh').trim() ||
      'Asia/Ho_Chi_Minh';
    this.defaultMaxAttempts = Math.max(1, options.defaultMaxAttempts ?? 5);
    this.nowFn = options.nowFn ?? Date.now;
    this.logger = options.logger ?? DEFAULT_LOGGER;
    this.defaultGeminiModel =
      (options.defaultGeminiModel ?? this.envSource.GEMINI_MODEL ?? 'gemini-3.5-flash').trim();
    this.probeFn = options.probeFn ?? ((apiKey, meta) => this.defaultLiveProbe(apiKey, meta));

    this.loadEnvKeys();
  }

  /** Cho phép gắn hàm probe tùy chỉnh (từ GeminiService hoặc bộ mock test). */
  setProbeFn(fn: KeyHealthProbeFn): void {
    this.probeFn = fn;
  }

  /** Đồng bộ các key đã mã hóa từ MongoDB (hoặc file mã hóa cục bộ nếu chạy chế độ JSON). */
  async init(): Promise<void> {
    await this.ensureDbSynced(true);
  }

  private async ensureDbSynced(force = false): Promise<void> {
    if (this.persistenceMode === 'memory') {
      this.dbSynced = true;
      return;
    }
    if (this.dbSynced && !force) return;
    if (this.dbSyncPromise) {
      await this.dbSyncPromise;
      return;
    }
    this.dbSyncPromise = this.syncFromStorage()
      .then(() => {
        this.dbSynced = true;
      })
      .finally(() => {
        this.dbSyncPromise = null;
      });
    await this.dbSyncPromise;
  }

  private isMongoConnected(): boolean {
    return this.persistenceMode === 'auto' && mongoose.connection.readyState === 1;
  }

  /**
   * Nạp tự động toàn bộ API key từ `.env`:
   * 1. `GEMINI_API_KEYS="k1,k2,..."` (phân tách dấu phẩy/xuống dòng)
   * 2. `GEMINI_API_KEY_1..N` (sắp xếp đúng thứ tự số học)
   * 3. Fallback `GEMINI_API_KEY`
   * Đồng thời hỗ trợ `OPENROUTER_API_KEYS`/`OPENROUTER_API_KEY_*` và `GROQ_API_KEYS`/`GROQ_API_KEY_*`.
   */
  private loadEnvKeys(): void {
    const providerSpecs: Array<{
      provider: ApiKeyProvider;
      pluralVar: string;
      numberedPrefix: string;
      singleVar: string;
    }> = [
      {
        provider: 'gemini',
        pluralVar: 'GEMINI_API_KEYS',
        numberedPrefix: 'GEMINI_API_KEY_',
        singleVar: 'GEMINI_API_KEY',
      },
      {
        provider: 'openrouter',
        pluralVar: 'OPENROUTER_API_KEYS',
        numberedPrefix: 'OPENROUTER_API_KEY_',
        singleVar: 'OPENROUTER_API_KEY',
      },
      {
        provider: 'groq',
        pluralVar: 'GROQ_API_KEYS',
        numberedPrefix: 'GROQ_API_KEY_',
        singleVar: 'GROQ_API_KEY',
      },
    ];

    for (const spec of providerSpecs) {
      const collected: Array<{ rawKey: string; label: string }> = [];

      const pluralRaw = this.envSource[spec.pluralVar];
      if (pluralRaw && pluralRaw.trim()) {
        const list = parseBulkApiKeys(pluralRaw);
        list.forEach((k, idx) => {
          collected.push({ rawKey: k, label: `${spec.pluralVar}[#${idx + 1}]` });
        });
      }

      const numberedKeys = Object.keys(this.envSource)
        .map((envName) => {
          if (!envName.startsWith(spec.numberedPrefix)) return null;
          const suffix = envName.slice(spec.numberedPrefix.length);
          if (!/^\d+$/.test(suffix)) return null;
          return { envName, order: Number(suffix) };
        })
        .filter((x): x is { envName: string; order: number } => x !== null)
        .sort((a, b) => a.order - b.order);

      for (const item of numberedKeys) {
        const val = this.envSource[item.envName];
        if (val && val.trim()) {
          for (const parsed of parseBulkApiKeys(val)) {
            collected.push({ rawKey: parsed, label: item.envName });
          }
        }
      }

      const singleVal = this.envSource[spec.singleVar];
      if (singleVal && singleVal.trim()) {
        for (const parsed of parseBulkApiKeys(singleVal)) {
          collected.push({ rawKey: parsed, label: spec.singleVar });
        }
      }

      for (const entry of collected) {
        this.registerInMemoryKey({
          rawKey: entry.rawKey,
          label: entry.label,
          provider: detectKeyProvider(entry.rawKey, spec.provider),
          source: 'env',
          weight: 1,
        });
      }
    }
  }

  private registerInMemoryKey(params: {
    id?: string;
    rawKey: string;
    label: string;
    provider: ApiKeyProvider;
    source: 'env' | 'db';
    weight?: number;
    isEnabled?: boolean;
    status?: PoolKeyRecord['status'];
    totalRequests?: number;
    successCount?: number;
    errorCount?: number;
    error429Count?: number;
    consecutive429?: number;
    lastUsedAt?: number | null;
    cooldownUntil?: number | null;
    dailyQuotaExhaustedAt?: number | null;
    quotaResetAt?: number | null;
    lastError?: string | null;
    createdAt?: string;
    updatedAt?: string;
  }): PoolKeyRecord | null {
    const cleanKey = params.rawKey.trim();
    if (!cleanKey) return null;

    const fp = fingerprintApiKey(cleanKey);
    const existingId = this.fingerprintToId.get(fp);
    if (existingId) {
      return this.keys.get(existingId) ?? null;
    }

    const slotNumber = this.nextSlotNumber++;
    const id = params.id ?? (params.source === 'env' ? `env_${fp.slice(0, 12)}` : newId('ak'));
    const nowIso = new Date(this.nowFn()).toISOString();

    const record: PoolKeyRecord = {
      id,
      slotNumber,
      label: params.label || `Key #${slotNumber}`,
      provider: params.provider,
      source: params.source,
      rawKey: cleanKey,
      maskedKey: maskApiKey(cleanKey),
      shortMask: shortMaskApiKey(cleanKey),
      keyFingerprint: fp,
      weight: Math.max(1, Math.min(20, Math.round(params.weight ?? 1))),
      isEnabled: params.isEnabled ?? true,
      status: params.status ?? 'HEALTHY',
      totalRequests: params.totalRequests ?? 0,
      successCount: params.successCount ?? 0,
      errorCount: params.errorCount ?? 0,
      error429Count: params.error429Count ?? 0,
      consecutive429: params.consecutive429 ?? 0,
      inFlight: 0,
      lastUsedAt: params.lastUsedAt ?? null,
      lastUsedSeq: 0,
      cooldownUntil: params.cooldownUntil ?? null,
      dailyQuotaExhaustedAt: params.dailyQuotaExhaustedAt ?? null,
      quotaResetAt: params.quotaResetAt ?? null,
      lastError: params.lastError ?? null,
      createdAt: params.createdAt ?? nowIso,
      updatedAt: params.updatedAt ?? nowIso,
    };

    this.keys.set(id, record);
    this.fingerprintToId.set(fp, id);
    return record;
  }

  private async syncFromStorage(): Promise<void> {
    let rows: StoredEncryptedRecord[] = [];

    if (this.isMongoConnected()) {
      if (!this.mongoIndexesEnsured) {
        this.mongoIndexesEnsured = true;
        await ApiKey.createIndexes().catch((err) => {
          this.logger.warn(
            `[KeyPool] Không thể tạo index cho api_keys: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
      const docs = await ApiKey.find({}).sort({ createdAt: 1 }).lean<IApiKey[]>();
      rows = docs.map((d) => ({
        keyId: d.keyId,
        label: d.label,
        provider: d.provider,
        encryptedKey: d.encryptedKey,
        iv: d.iv,
        authTag: d.authTag,
        keyFingerprint: d.keyFingerprint,
        maskedKey: d.maskedKey,
        weight: d.weight,
        isEnabled: d.isEnabled,
        status: d.status,
        totalRequests: d.totalRequests,
        successCount: d.successCount,
        errorCount: d.errorCount,
        error429Count: d.error429Count,
        consecutive429: d.consecutive429,
        lastUsedAt: d.lastUsedAt ? new Date(d.lastUsedAt).toISOString() : null,
        cooldownUntil: d.cooldownUntil ? new Date(d.cooldownUntil).toISOString() : null,
        dailyQuotaExhaustedAt: d.dailyQuotaExhaustedAt
          ? new Date(d.dailyQuotaExhaustedAt).toISOString()
          : null,
        quotaResetAt: d.quotaResetAt ? new Date(d.quotaResetAt).toISOString() : null,
        lastError: d.lastError ?? null,
        addedBy: d.addedBy ?? null,
        createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : new Date(this.nowFn()).toISOString(),
        updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : new Date(this.nowFn()).toISOString(),
      }));
    } else {
      rows = this.readEncryptedFallbackFile();
    }

    for (const row of rows) {
      if (this.keys.has(row.keyId) || this.fingerprintToId.has(row.keyFingerprint)) {
        continue;
      }
      try {
        const decrypted = decryptApiKey(
          { encryptedKey: row.encryptedKey, keyFingerprint: row.keyFingerprint },
          this.encryptionSecret,
        );
        this.registerInMemoryKey({
          id: row.keyId,
          rawKey: decrypted,
          label: row.label,
          provider: row.provider,
          source: 'db',
          weight: row.weight,
          isEnabled: row.isEnabled,
          status: row.status,
          totalRequests: row.totalRequests,
          successCount: row.successCount,
          errorCount: row.errorCount,
          error429Count: row.error429Count,
          consecutive429: row.consecutive429,
          lastUsedAt: row.lastUsedAt ? Date.parse(row.lastUsedAt) : null,
          cooldownUntil: row.cooldownUntil ? Date.parse(row.cooldownUntil) : null,
          dailyQuotaExhaustedAt: row.dailyQuotaExhaustedAt
            ? Date.parse(row.dailyQuotaExhaustedAt)
            : null,
          quotaResetAt: row.quotaResetAt ? Date.parse(row.quotaResetAt) : null,
          lastError: row.lastError,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `[KeyPool] Không giải mã được key ${row.keyId} (${row.maskedKey}) từ DB: ${msg}`,
        );
      }
    }
  }

  private readEncryptedFallbackFile(): StoredEncryptedRecord[] {
    try {
      if (!fs.existsSync(this.fallbackFilePath)) return [];
      const raw = fs.readFileSync(this.fallbackFilePath, 'utf8');
      if (!raw.trim()) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as StoredEncryptedRecord[]) : [];
    } catch (err) {
      this.logger.warn(
        `[KeyPool] Không đọc được kho key mã hóa cục bộ: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  private writeEncryptedFallbackFile(rows: StoredEncryptedRecord[]): void {
    const dir = path.dirname(this.fallbackFilePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.fallbackFilePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(rows, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.fallbackFilePath);
  }

  private persistRecordStateAsync(record: PoolKeyRecord): void {
    if (record.source !== 'db' || this.persistenceMode === 'memory') return;

    const updateFields = {
      label: record.label,
      weight: record.weight,
      isEnabled: record.isEnabled,
      status: record.status,
      totalRequests: record.totalRequests,
      successCount: record.successCount,
      errorCount: record.errorCount,
      error429Count: record.error429Count,
      consecutive429: record.consecutive429,
      lastUsedAt: record.lastUsedAt ? new Date(record.lastUsedAt) : null,
      cooldownUntil: record.cooldownUntil ? new Date(record.cooldownUntil) : null,
      dailyQuotaExhaustedAt: record.dailyQuotaExhaustedAt
        ? new Date(record.dailyQuotaExhaustedAt)
        : null,
      quotaResetAt: record.quotaResetAt ? new Date(record.quotaResetAt) : null,
      lastError: record.lastError,
    };

    if (this.isMongoConnected()) {
      void ApiKey.updateOne({ keyId: record.id }, { $set: updateFields }).catch((err) => {
        this.logger.warn(
          `[KeyPool] Không đồng bộ được telemetry của key ${record.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      return;
    }

    try {
      const rows = this.readEncryptedFallbackFile();
      const idx = rows.findIndex((r) => r.keyId === record.id);
      if (idx >= 0) {
        rows[idx] = {
          ...rows[idx],
          label: record.label,
          weight: record.weight,
          isEnabled: record.isEnabled,
          status: record.status,
          totalRequests: record.totalRequests,
          successCount: record.successCount,
          errorCount: record.errorCount,
          error429Count: record.error429Count,
          consecutive429: record.consecutive429,
          lastUsedAt: record.lastUsedAt ? new Date(record.lastUsedAt).toISOString() : null,
          cooldownUntil: record.cooldownUntil ? new Date(record.cooldownUntil).toISOString() : null,
          dailyQuotaExhaustedAt: record.dailyQuotaExhaustedAt
            ? new Date(record.dailyQuotaExhaustedAt).toISOString()
            : null,
          quotaResetAt: record.quotaResetAt ? new Date(record.quotaResetAt).toISOString() : null,
          lastError: record.lastError,
          updatedAt: record.updatedAt,
        };
        this.writeEncryptedFallbackFile(rows);
      }
    } catch (err) {
      this.logger.warn(
        `[KeyPool] Không lưu được trạng thái key cục bộ: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Tự động phục hồi các key đã hết thời gian COOLDOWN hoặc qua 00:00 (reset quota ngày EXHAUSTED).
   */
  private refreshTimeBasedStates(nowMs: number): void {
    for (const k of this.keys.values()) {
      if (k.status === 'COOLDOWN' && k.cooldownUntil !== null && nowMs >= k.cooldownUntil) {
        k.status = 'HEALTHY';
        k.cooldownUntil = null;
        k.updatedAt = new Date(nowMs).toISOString();
        this.persistRecordStateAsync(k);
      } else if (k.status === 'EXHAUSTED' && k.quotaResetAt !== null && nowMs >= k.quotaResetAt) {
        k.status = 'HEALTHY';
        k.dailyQuotaExhaustedAt = null;
        k.quotaResetAt = null;
        k.consecutive429 = 0;
        k.updatedAt = new Date(nowMs).toISOString();
        this.persistRecordStateAsync(k);
      }
    }
  }

  private matchesProvider(
    record: PoolKeyRecord,
    providerFilter?: ApiKeyProvider | readonly ApiKeyProvider[],
  ): boolean {
    if (!providerFilter) return true;
    if (typeof providerFilter === 'string') return record.provider === providerFilter;
    return providerFilter.includes(record.provider);
  }

  /**
   * Chiến lược chọn Key thông minh: kết hợp Weighted Round-Robin + Least-Recently-Used (LRU)
   * và ưu tiên phân tán tải đồng thời (`inFlight` thấp nhất).
   */
  private pickNextHealthyKey(
    excludedIds: ReadonlySet<string>,
    providerFilter?: ApiKeyProvider | readonly ApiKeyProvider[],
  ): PoolKeyRecord | null {
    const nowMs = this.nowFn();
    this.refreshTimeBasedStates(nowMs);

    const candidates: PoolKeyRecord[] = [];
    for (const k of this.keys.values()) {
      if (!k.isEnabled) continue;
      if (k.status !== 'HEALTHY') continue;
      if (excludedIds.has(k.id)) continue;
      if (!this.matchesProvider(k, providerFilter)) continue;
      candidates.push(k);
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      // 1. Ưu tiên key đang rảnh (inFlight thấp hơn) để không dồn burst vào cùng 1 key
      if (a.inFlight !== b.inFlight) return a.inFlight - b.inFlight;

      // 2. Các key chưa từng dùng trong phiên được ưu tiên theo trọng số rồi thứ tự nạp (Key #1 -> #2 -> #3...)
      const aUnused = a.lastUsedSeq === 0;
      const bUnused = b.lastUsedSeq === 0;
      if (aUnused && bUnused) {
        if (a.weight !== b.weight) return b.weight - a.weight;
        return a.slotNumber - b.slotNumber;
      }
      if (aUnused !== bUnused) return aUnused ? -1 : 1;

      // 3. Weighted Round-Robin + LRU trên các key đã đi vào chu trình xoay vòng:
      // Khoảng nghỉ ảo = (globalUseSeq - lastUsedSeq) * weight * hệ_số_tin_cậy
      const aReliability = 1 / (1 + a.consecutive429 * 0.25);
      const bReliability = 1 / (1 + b.consecutive429 * 0.25);
      const aWeightedIdle = (this.globalUseSeq - a.lastUsedSeq) * a.weight * aReliability;
      const bWeightedIdle = (this.globalUseSeq - b.lastUsedSeq) * b.weight * bReliability;

      if (Math.abs(bWeightedIdle - aWeightedIdle) > 1e-6) {
        return bWeightedIdle - aWeightedIdle;
      }

      // 4. Tie-breaker: Least-Recently-Used theo timestamp thực tế -> tỷ lệ tải/weight -> slotNumber
      const aLast = a.lastUsedAt ?? 0;
      const bLast = b.lastUsedAt ?? 0;
      if (aLast !== bLast) return aLast - bLast;

      const aNormLoad = a.totalRequests / a.weight;
      const bNormLoad = b.totalRequests / b.weight;
      if (aNormLoad !== bNormLoad) return aNormLoad - bNormLoad;

      return a.slotNumber - b.slotNumber;
    });

    return candidates[0];
  }

  private toMeta(record: PoolKeyRecord): SelectedKeyMeta {
    return {
      id: record.id,
      slotNumber: record.slotNumber,
      label: record.label,
      provider: record.provider,
      maskedKey: record.maskedKey,
      shortMask: record.shortMask,
    };
  }

  private toMaskedInfo(record: PoolKeyRecord, nowMs: number): MaskedApiKeyInfo {
    const cooldownRemainingMs =
      record.status === 'COOLDOWN' && record.cooldownUntil !== null
        ? Math.max(0, record.cooldownUntil - nowMs)
        : 0;
    return {
      id: record.id,
      slotNumber: record.slotNumber,
      label: record.label,
      provider: record.provider,
      source: record.source,
      maskedKey: record.maskedKey,
      weight: record.weight,
      isEnabled: record.isEnabled,
      status: record.status,
      totalRequests: record.totalRequests,
      successCount: record.successCount,
      errorCount: record.errorCount,
      error429Count: record.error429Count,
      lastUsedAt: record.lastUsedAt !== null ? new Date(record.lastUsedAt).toISOString() : null,
      cooldownUntil:
        record.cooldownUntil !== null ? new Date(record.cooldownUntil).toISOString() : null,
      cooldownRemainingMs,
      dailyQuotaExhaustedAt:
        record.dailyQuotaExhaustedAt !== null
          ? new Date(record.dailyQuotaExhaustedAt).toISOString()
          : null,
      quotaResetAt:
        record.quotaResetAt !== null ? new Date(record.quotaResetAt).toISOString() : null,
      lastError: record.lastError,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  /**
   * Thực thi hàm gọi AI với cơ chế tự động xoay vòng Key tức thì (Zero-Sleep Seamless Failover).
   * Ngay trong cùng 1 HTTP request: nếu Key A gặp 429 / hết quota / die -> lập tức chuyển sang Key B, C...
   */
  async executeWithRotation<T>(
    fn: (apiKey: string, meta: SelectedKeyMeta) => Promise<T>,
    options: ExecuteWithRotationOptions = {},
  ): Promise<T> {
    await this.ensureDbSynced();

    const triedIds = new Set<string>();
    const initialHealthyCount = this.countHealthyKeys(options.provider);
    if (initialHealthyCount === 0) {
      throw new KeyPoolExhaustedError(
        'Không có API Key nào ở trạng thái HEALTHY trong KeyPool.',
        0,
      );
    }

    const maxAttempts = Math.min(
      initialHealthyCount,
      Math.max(1, options.maxAttempts ?? this.defaultMaxAttempts),
    );

    let attempt = 0;
    let lastError: unknown;
    let preselected: PoolKeyRecord | null = null;

    while (attempt < maxAttempts) {
      const candidate =
        preselected ?? this.pickNextHealthyKey(triedIds, options.provider);
      preselected = null;

      if (!candidate) {
        break;
      }

      attempt += 1;
      triedIds.add(candidate.id);

      const startNow = this.nowFn();
      candidate.inFlight += 1;
      candidate.totalRequests += 1;
      candidate.lastUsedAt = startNow;
      candidate.lastUsedSeq = ++this.globalUseSeq;
      candidate.updatedAt = new Date(startNow).toISOString();

      try {
        const result = await fn(candidate.rawKey, this.toMeta(candidate));
        const finishNow = this.nowFn();
        candidate.successCount += 1;
        candidate.consecutive429 = 0;
        candidate.status = 'HEALTHY';
        candidate.cooldownUntil = null;
        candidate.lastError = null;
        candidate.updatedAt = new Date(finishNow).toISOString();
        this.persistRecordStateAsync(candidate);
        return result;
      } catch (err) {
        lastError = err;
        const failNow = this.nowFn();
        const classified = classifyUpstreamError(err);

        candidate.errorCount += 1;
        candidate.lastError = classified.reasonSummary;
        candidate.updatedAt = new Date(failNow).toISOString();

        let hitDesc = `${classified.httpStatus ?? 'ERR'}`;
        let stateActionDesc = 'Retry next key';

        if (classified.kind === 'RATE_LIMIT_429') {
          candidate.error429Count += 1;
          candidate.consecutive429 += 1;
          const cooldownMs = computeCooldownMs(candidate.consecutive429, this.cooldownStepsMs);
          candidate.status = 'COOLDOWN';
          candidate.cooldownUntil = failNow + cooldownMs;
          hitDesc = '429';
          stateActionDesc = `Cooldown ${Math.round(cooldownMs / 1000)}s`;
        } else if (classified.kind === 'DAILY_QUOTA_EXHAUSTED') {
          candidate.error429Count += 1;
          candidate.consecutive429 += 1;
          const resetMs = computeNextMidnightMs(failNow, this.quotaResetTimeZone);
          candidate.status = 'EXHAUSTED';
          candidate.cooldownUntil = null;
          candidate.dailyQuotaExhaustedAt = failNow;
          candidate.quotaResetAt = resetMs;
          hitDesc = '429 (RPD Daily Quota)';
          stateActionDesc = `EXHAUSTED until ${new Date(resetMs).toISOString()}`;
        } else if (classified.kind === 'INVALID_KEY') {
          candidate.status = 'INVALID';
          candidate.cooldownUntil = null;
          hitDesc = `${classified.httpStatus ?? 401} (Invalid/Revoked)`;
          stateActionDesc = 'Marked INVALID';
        }

        this.persistRecordStateAsync(candidate);

        if (!classified.retryable) {
          throw err;
        }

        const nextCandidate =
          attempt < maxAttempts
            ? this.pickNextHealthyKey(triedIds, options.provider)
            : null;
        preselected = nextCandidate;

        const switchTarget = nextCandidate
          ? `Switched to Key #${nextCandidate.slotNumber} (${nextCandidate.shortMask})`
          : attempt >= maxAttempts
            ? `Reached maxAttempts (${maxAttempts})`
            : 'No healthy keys remaining';

        const logLine = `[KeyPool] Key #${candidate.slotNumber} (${candidate.shortMask}) hit ${hitDesc} -> ${stateActionDesc} -> ${switchTarget}`;
        if (classified.kind === 'INVALID_KEY') {
          this.logger.error(`[KeyPool] CẢNH BÁO KEY HỎNG: ${logLine}`);
        } else {
          this.logger.warn(logLine);
        }

        if (!nextCandidate) {
          break;
        }
      } finally {
        candidate.inFlight = Math.max(0, candidate.inFlight - 1);
      }
    }

    throw new KeyPoolExhaustedError(
      `Đã xoay vòng qua ${attempt} API key nhưng đều thất bại (${lastError instanceof Error ? lastError.message : String(lastError)}).`,
      attempt,
      lastError,
    );
  }

  /** Kiểm tra nhanh có ít nhất 1 key được cấu hình & đang bật hay không. */
  hasConfiguredKeys(provider?: ApiKeyProvider | readonly ApiKeyProvider[]): boolean {
    for (const k of this.keys.values()) {
      if (k.isEnabled && this.matchesProvider(k, provider)) return true;
    }
    return false;
  }

  /** Đếm số lượng key đang ở trạng thái HEALTHY (sau khi tự động mở khóa các key hết hạn cooldown). */
  countHealthyKeys(provider?: ApiKeyProvider | readonly ApiKeyProvider[]): number {
    this.refreshTimeBasedStates(this.nowFn());
    let count = 0;
    for (const k of this.keys.values()) {
      if (k.isEnabled && k.status === 'HEALTHY' && this.matchesProvider(k, provider)) {
        count += 1;
      }
    }
    return count;
  }

  /** Trả về thống kê tức thời (đồng bộ) phục vụ `/healthz` và log khởi động. */
  getSummarySync(): KeyPoolSummary {
    const nowMs = this.nowFn();
    this.refreshTimeBasedStates(nowMs);

    const byProvider: KeyPoolSummary['byProvider'] = {
      gemini: { total: 0, healthy: 0 },
      openrouter: { total: 0, healthy: 0 },
      groq: { total: 0, healthy: 0 },
    };

    let enabledKeys = 0;
    let healthyKeys = 0;
    let cooldownKeys = 0;
    let exhaustedKeys = 0;
    let invalidKeys = 0;
    let totalRequests = 0;
    let totalSuccess = 0;
    let totalErrors = 0;
    let total429 = 0;

    for (const p of API_KEY_PROVIDERS) {
      byProvider[p] = { total: 0, healthy: 0 };
    }

    for (const k of this.keys.values()) {
      byProvider[k.provider].total += 1;
      if (k.isEnabled) {
        enabledKeys += 1;
        if (k.status === 'HEALTHY') {
          healthyKeys += 1;
          byProvider[k.provider].healthy += 1;
        } else if (k.status === 'COOLDOWN') {
          cooldownKeys += 1;
        } else if (k.status === 'EXHAUSTED') {
          exhaustedKeys += 1;
        } else if (k.status === 'INVALID') {
          invalidKeys += 1;
        }
      }
      totalRequests += k.totalRequests;
      totalSuccess += k.successCount;
      totalErrors += k.errorCount;
      total429 += k.error429Count;
    }

    return {
      totalKeys: this.keys.size,
      enabledKeys,
      healthyKeys,
      cooldownKeys,
      exhaustedKeys,
      invalidKeys,
      totalRequests,
      totalSuccess,
      totalErrors,
      total429,
      byProvider,
    };
  }

  /** Danh sách toàn bộ API key đã được che (`AIzaSy...8xKp`) cho Admin Dashboard. */
  async listMaskedKeys(): Promise<{ summary: KeyPoolSummary; keys: MaskedApiKeyInfo[] }> {
    await this.ensureDbSynced();
    const nowMs = this.nowFn();
    const summary = this.getSummarySync();
    const keys = [...this.keys.values()]
      .sort((a, b) => a.slotNumber - b.slotNumber)
      .map((k) => this.toMaskedInfo(k, nowMs));
    return { summary, keys };
  }

  /**
   * Thêm 1 hoặc dán hàng loạt (10+ key) vào Pool, mã hóa AES-256-GCM trước khi lưu vào MongoDB.
   */
  async addKeys(input: BulkAddApiKeysInput): Promise<BulkAddApiKeysResult> {
    await this.ensureDbSynced();

    const normalizedItems: AddApiKeyInputItem[] = [];
    if (Array.isArray(input.items)) {
      for (const item of input.items) {
        for (const parsed of parseBulkApiKeys(item.apiKey)) {
          normalizedItems.push({
            apiKey: parsed,
            label: item.label,
            provider: item.provider ?? input.provider,
            weight: item.weight ?? input.weight,
          });
        }
      }
    }
    if (input.apiKey) {
      for (const parsed of parseBulkApiKeys(input.apiKey)) {
        normalizedItems.push({
          apiKey: parsed,
          provider: input.provider,
          weight: input.weight,
        });
      }
    }
    if (Array.isArray(input.apiKeys)) {
      for (const parsed of parseBulkApiKeys(input.apiKeys)) {
        normalizedItems.push({
          apiKey: parsed,
          provider: input.provider,
          weight: input.weight,
        });
      }
    }
    if (input.keysText) {
      for (const parsed of parseBulkApiKeys(input.keysText)) {
        normalizedItems.push({
          apiKey: parsed,
          provider: input.provider,
          weight: input.weight,
        });
      }
    }

    if (normalizedItems.length === 0) {
      throw badRequest(
        'Vui lòng cung cấp ít nhất một API key hợp lệ (apiKey, apiKeys hoặc keysText).',
        'empty_api_keys',
      );
    }

    const added: MaskedApiKeyInfo[] = [];
    const skippedDuplicates: string[] = [];
    let invalidFormatCount = 0;
    const toPersist: StoredEncryptedRecord[] = [];
    const nowMs = this.nowFn();
    const nowIso = new Date(nowMs).toISOString();

    for (let i = 0; i < normalizedItems.length; i++) {
      const item = normalizedItems[i];
      const clean = item.apiKey.trim();
      if (clean.length < 8 || /\s/.test(clean)) {
        invalidFormatCount += 1;
        continue;
      }

      const fp = fingerprintApiKey(clean);
      if (this.fingerprintToId.has(fp)) {
        skippedDuplicates.push(maskApiKey(clean));
        continue;
      }

      const encrypted = encryptApiKey(clean, this.encryptionSecret);
      const keyId = newId('ak');
      const provider = detectKeyProvider(clean, item.provider);
      const weight = Math.max(1, Math.min(20, Math.round(item.weight ?? 1)));
      const nextSlotPreview = this.nextSlotNumber;
      const label =
        item.label?.trim() ||
        (input.labelPrefix?.trim()
          ? `${input.labelPrefix.trim()} #${i + 1}`
          : `${provider.toUpperCase()} Admin Key #${nextSlotPreview}`);

      const docCandidate = {
        keyId,
        label,
        provider,
        encryptedKey: encrypted.encryptedKey,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        keyFingerprint: encrypted.keyFingerprint,
        maskedKey: encrypted.maskedKey,
        weight,
        isEnabled: true,
        status: 'HEALTHY' as const,
        totalRequests: 0,
        successCount: 0,
        errorCount: 0,
        error429Count: 0,
        consecutive429: 0,
        lastUsedAt: null,
        cooldownUntil: null,
        dailyQuotaExhaustedAt: null,
        quotaResetAt: null,
        lastError: null,
        addedBy: input.addedBy ?? null,
      };

      // Luôn kiểm tra schema Mongoose ApiKey ngay cả khi chạy chế độ JSON hoặc memory
      const validationErr = new ApiKey(docCandidate).validateSync();
      if (validationErr) {
        throw badRequest(`Dữ liệu API Key không hợp lệ: ${validationErr.message}`, 'invalid_api_key');
      }

      const mem = this.registerInMemoryKey({
        id: keyId,
        rawKey: clean,
        label,
        provider,
        source: 'db',
        weight,
        isEnabled: true,
        status: 'HEALTHY',
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      if (mem) {
        added.push(this.toMaskedInfo(mem, nowMs));
        toPersist.push({
          ...docCandidate,
          createdAt: nowIso,
          updatedAt: nowIso,
        });
      }
    }

    if (toPersist.length > 0 && this.persistenceMode === 'auto') {
      if (this.isMongoConnected()) {
        await ApiKey.insertMany(toPersist, { ordered: false });
      } else {
        const existing = this.readEncryptedFallbackFile();
        this.writeEncryptedFallbackFile([...existing, ...toPersist]);
      }
    }

    return {
      addedCount: added.length,
      skippedDuplicateCount: skippedDuplicates.length,
      invalidFormatCount,
      added,
      skippedDuplicates,
    };
  }

  /** Bật/tắt (`isEnabled`), đổi nhãn/trọng số hoặc reset thủ công trạng thái Cooldown/Exhausted/Invalid. */
  async updateKey(id: string, patch: UpdateApiKeyPatch): Promise<MaskedApiKeyInfo> {
    await this.ensureDbSynced();
    const record = this.keys.get(id);
    if (!record) {
      throw notFound('Không tìm thấy API key theo ID yêu cầu.');
    }

    const nowMs = this.nowFn();
    if (patch.isEnabled !== undefined) {
      record.isEnabled = patch.isEnabled;
    }
    if (patch.label !== undefined && patch.label.trim()) {
      record.label = patch.label.trim().slice(0, 120);
    }
    if (patch.weight !== undefined) {
      record.weight = Math.max(1, Math.min(20, Math.round(patch.weight)));
    }
    if (patch.resetCooldown) {
      record.status = 'HEALTHY';
      record.cooldownUntil = null;
      record.dailyQuotaExhaustedAt = null;
      record.quotaResetAt = null;
      record.consecutive429 = 0;
      record.lastError = null;
    }
    record.updatedAt = new Date(nowMs).toISOString();

    this.persistRecordStateAsync(record);
    return this.toMaskedInfo(record, nowMs);
  }

  /** Xóa API key khỏi DB và khỏi KeyPool. */
  async deleteKey(id: string): Promise<{ deleted: true; id: string; maskedKey: string }> {
    await this.ensureDbSynced();
    const record = this.keys.get(id);
    if (!record) {
      throw notFound('Không tìm thấy API key theo ID yêu cầu.');
    }
    if (record.source === 'env') {
      throw badRequest(
        'Key nạp từ biến môi trường (.env) không thể xóa vĩnh viễn qua API. Hãy dùng PATCH { "isEnabled": false } để tạm tắt key này.',
        'cannot_delete_env_key',
      );
    }

    this.keys.delete(id);
    this.fingerprintToId.delete(record.keyFingerprint);

    if (this.persistenceMode === 'auto') {
      if (this.isMongoConnected()) {
        await ApiKey.deleteOne({ keyId: id });
      } else {
        const rows = this.readEncryptedFallbackFile().filter((r) => r.keyId !== id);
        this.writeEncryptedFallbackFile(rows);
      }
    }

    return { deleted: true, id: record.id, maskedKey: record.maskedKey };
  }

  /** Bắn 1 request nhẹ kiểm tra trực tiếp một API key cụ thể có còn sống hay không. */
  async testKey(id: string): Promise<ApiKeyTestResult> {
    await this.ensureDbSynced();
    const record = this.keys.get(id);
    if (!record) {
      throw notFound('Không tìm thấy API key theo ID yêu cầu.');
    }

    const startMs = this.nowFn();
    record.totalRequests += 1;
    record.lastUsedAt = startMs;

    try {
      const res = await this.probeFn(record.rawKey, this.toMeta(record));
      const latencyMs = Math.max(0, this.nowFn() - startMs);
      if (res.ok) {
        record.successCount += 1;
        record.status = 'HEALTHY';
        record.cooldownUntil = null;
        record.dailyQuotaExhaustedAt = null;
        record.quotaResetAt = null;
        record.consecutive429 = 0;
        record.lastError = null;
        record.updatedAt = new Date(this.nowFn()).toISOString();
        this.persistRecordStateAsync(record);
        return {
          id: record.id,
          maskedKey: record.maskedKey,
          provider: record.provider,
          ok: true,
          status: record.status,
          latencyMs,
          detail: res.detail ?? 'API Key hoạt động bình thường (HEALTHY).',
        };
      }
      throw new Error(res.detail ?? 'Kiểm tra API Key thất bại.');
    } catch (err) {
      const endMs = this.nowFn();
      const latencyMs = Math.max(0, endMs - startMs);
      const classified = classifyUpstreamError(err);

      record.errorCount += 1;
      record.lastError = classified.reasonSummary;
      if (classified.kind === 'RATE_LIMIT_429') {
        record.error429Count += 1;
        record.consecutive429 += 1;
        record.status = 'COOLDOWN';
        record.cooldownUntil =
          endMs + computeCooldownMs(record.consecutive429, this.cooldownStepsMs);
      } else if (classified.kind === 'DAILY_QUOTA_EXHAUSTED') {
        record.error429Count += 1;
        record.status = 'EXHAUSTED';
        record.dailyQuotaExhaustedAt = endMs;
        record.quotaResetAt = computeNextMidnightMs(endMs, this.quotaResetTimeZone);
      } else if (classified.kind === 'INVALID_KEY') {
        record.status = 'INVALID';
        record.cooldownUntil = null;
      }
      record.updatedAt = new Date(endMs).toISOString();
      this.persistRecordStateAsync(record);

      return {
        id: record.id,
        maskedKey: record.maskedKey,
        provider: record.provider,
        ok: false,
        status: record.status,
        latencyMs,
        detail: classified.reasonSummary,
      };
    }
  }

  /** Probe mặc định kiểm tra key thật trên Google AI Studio / OpenRouter / Groq. */
  private async defaultLiveProbe(
    apiKey: string,
    meta: SelectedKeyMeta,
  ): Promise<{ ok: boolean; detail?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      if (meta.provider === 'openrouter') {
        const res = await fetch('https://openrouter.ai/api/v1/key', {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = Object.assign(new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 180)}`), {
            status: res.status,
          });
          throw err;
        }
        return { ok: true, detail: 'OpenRouter API Key hợp lệ.' };
      }

      if (meta.provider === 'groq') {
        const res = await fetch('https://api.groq.com/openai/v1/models', {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = Object.assign(new Error(`Groq HTTP ${res.status}: ${text.slice(0, 180)}`), {
            status: res.status,
          });
          throw err;
        }
        return { ok: true, detail: 'Groq API Key hợp lệ.' };
      }

      const mod = await import('@google/genai');
      const client = new mod.GoogleGenAI({ apiKey });
      const res = await client.models.generateContent({
        model: this.defaultGeminiModel,
        contents: 'Trả lời duy nhất từ: OK',
        config: {
          maxOutputTokens: 5,
          temperature: 0,
        },
      });
      return {
        ok: true,
        detail: `Gemini (${this.defaultGeminiModel}) phản hồi thành công${res.text ? `: "${res.text.trim().slice(0, 24)}"` : ''}.`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
