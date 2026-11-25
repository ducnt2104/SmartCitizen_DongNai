import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { performance } from 'node:perf_hooks';
import mongoose, { type ClientSession, type ConnectOptions } from 'mongoose';

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  for (const candidate of [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../.env'),
    path.resolve(__dirname, '../../.env'),
    path.resolve(__dirname, '../../../.env'),
  ]) {
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate, override: false });
    }
  }
}

export type ConnectionStateName =
  | 'disconnected'
  | 'connected'
  | 'connecting'
  | 'disconnecting'
  | 'uninitialized';

export interface ConnectDbOptions {
  /** Chuỗi kết nối MongoDB Atlas; mặc định đọc từ process.env.MONGODB_URI */
  uri?: string;
  /** Số lần thử lại ngay lúc khởi tạo (boot retry với exponential backoff, mặc định 5 ở prod/dev, 2 ở test) */
  bootRetries?: number;
  /** Thời gian chờ cơ sở giữa các lần boot retry (ms, mặc định 1000ms ở prod/dev, 150ms ở test) */
  retryBaseDelayMs?: number;
  /** Số lần tự động kết nối lại tối đa khi mất kết nối bất ngờ lúc đang chạy (mặc định 10) */
  maxReconnectAttempts?: number;
  /** Tự động gọi createIndexes() cho toàn bộ collections sau khi kết nối (mặc định true) */
  ensureIndexes?: boolean;
  /** Tự động đăng ký Graceful Shutdown trên SIGINT/SIGTERM (mặc định true) */
  registerShutdownHooks?: boolean;
}

export interface MaskedMongoUriInfo {
  configured: boolean;
  protocol: 'mongodb+srv' | 'mongodb' | 'none';
  host: string;
  dbName: string;
  maskedUri: string;
}

export interface MongoErrorDiagnosis {
  category: 'AUTH_FAILED' | 'DNS_ERROR' | 'NETWORK_OR_IP_WHITELIST' | 'TLS_HANDSHAKE' | 'INVALID_URI' | 'UNKNOWN';
  errorName: string;
  code: string | null;
  message: string;
  hint: string;
}

export interface DatabaseHealth {
  ok: boolean;
  state: ConnectionStateName;
  latencyMs: number | null;
  collectionsCount: number;
  totalIncidents: number;
  totalUsers: number;
}

export interface IndexSyncSummary {
  modelName: string;
  collectionName: string;
  indexCount: number;
  indexes: string[];
}

const READY_STATE_MAP: Readonly<Record<number, ConnectionStateName>> = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
  99: 'uninitialized',
};

export const DEFAULT_MONGODB_DB_NAME = 'smartcitizen_dongnai';

/** Che giấu tuyệt đối username/password trong URI trước khi ghi ra Render logs. */
export function maskMongoUri(rawUri?: string): MaskedMongoUriInfo {
  const trimmed = (rawUri ?? '').trim();
  if (!trimmed) {
    return {
      configured: false,
      protocol: 'none',
      host: '(none)',
      dbName: DEFAULT_MONGODB_DB_NAME,
      maskedUri: '(empty)',
    };
  }
  const protocol: 'mongodb+srv' | 'mongodb' | 'none' = trimmed.startsWith('mongodb+srv://')
    ? 'mongodb+srv'
    : trimmed.startsWith('mongodb://')
      ? 'mongodb'
      : 'none';
  const maskedUri = trimmed.replace(/(mongodb(?:\+srv)?:\/\/)([^/@\s]+)@/gi, '$1***:***@');
  const withoutScheme = maskedUri.replace(/^mongodb(?:\+srv)?:\/\//i, '').replace(/^\*\*\*:\*\*\*@/, '');
  const slashIdx = withoutScheme.indexOf('/');
  const host = (slashIdx >= 0 ? withoutScheme.slice(0, slashIdx) : withoutScheme.split('?')[0]) || '(unknown-host)';
  const rawDb = slashIdx >= 0 ? withoutScheme.slice(slashIdx + 1).split('?')[0]?.trim() ?? '' : '';
  return {
    configured: true,
    protocol,
    host,
    dbName: rawDb || DEFAULT_MONGODB_DB_NAME,
    maskedUri,
  };
}

/** Phân loại chính xác nguyên nhân lỗi kết nối Cloud (Render -> MongoDB Atlas) không lộ mật khẩu. */
export function diagnoseMongoError(err: unknown): MongoErrorDiagnosis {
  const isObj = err !== null && typeof err === 'object';
  const errorName = isObj && 'name' in err ? String((err as { name?: unknown }).name ?? 'Error') : 'Error';
  const code =
    isObj && 'code' in err && (err as { code?: unknown }).code !== undefined
      ? String((err as { code?: unknown }).code)
      : null;
  const rawMsg = err instanceof Error ? err.message : String(err);
  const safeMsg = rawMsg.replace(/(mongodb(?:\+srv)?:\/\/)([^/@\s]+)@/gi, '$1***:***@');

  if (/bad auth|Authentication failed|auth failed/i.test(safeMsg) || code === '18' || code === '8000') {
    return {
      category: 'AUTH_FAILED',
      errorName,
      code,
      message: safeMsg,
      hint: 'Sai username/password của Database User trên MongoDB Atlas (lưu ý URL-encode ký tự đặc biệt như @, :, #, % trong mật khẩu) hoặc chưa cấp quyền readWrite.',
    };
  }
  if (
    /querySrv|ENOTFOUND|ENODATA|EREFUSED|ESERVFAIL|EAI_AGAIN/i.test(safeMsg) ||
    (code !== null && ['ENOTFOUND', 'ENODATA', 'EREFUSED', 'ESERVFAIL', 'EAI_AGAIN'].includes(code))
  ) {
    return {
      category: 'DNS_ERROR',
      errorName,
      code,
      message: safeMsg,
      hint: 'Không phân giải được tên miền cụm Atlas (kiểm tra hostname trong MONGODB_URI hoặc dùng Standard Connection String mongodb:// nếu mạng chặn SRV).',
    };
  }
  if (/SSL|TLS|ERR_SSL|alert number/i.test(safeMsg)) {
    return {
      category: 'TLS_HANDSHAKE',
      errorName,
      code,
      message: safeMsg,
      hint: 'Lỗi bắt tay TLS/SSL tới MongoDB Atlas (kiểm tra Network Access IP Whitelist 0.0.0.0/0 trên Atlas vì Atlas đóng TLS sớm khi IP bị chặn).',
    };
  }
  if (
    errorName === 'MongoServerSelectionError' ||
    /Could not connect to any servers|Server selection timed out|ETIMEDOUT|ECONNREFUSED|ENETUNREACH/i.test(safeMsg)
  ) {
    return {
      category: 'NETWORK_OR_IP_WHITELIST',
      errorName,
      code,
      message: safeMsg,
      hint: 'Render chưa được phép truy cập cụm Atlas (vào MongoDB Atlas -> Network Access -> Add IP Address -> Allow Access from Anywhere 0.0.0.0/0) hoặc cụm M0 đang cold-start.',
    };
  }
  if (/Invalid scheme|uri/i.test(safeMsg)) {
    return {
      category: 'INVALID_URI',
      errorName,
      code,
      message: safeMsg,
      hint: 'Định dạng MONGODB_URI không hợp lệ (cần bắt đầu bằng mongodb+srv:// hoặc mongodb://).',
    };
  }
  return {
    category: 'UNKNOWN',
    errorName,
    code,
    message: safeMsg,
    hint: 'Kiểm tra lại biến MONGODB_URI và trạng thái cụm trên MongoDB Atlas Dashboard.',
  };
}

function uriHasDatabaseName(uri: string): boolean {
  const withoutScheme = uri.replace(/^mongodb(\+srv)?:\/\//i, '');
  const slashIdx = withoutScheme.indexOf('/');
  if (slashIdx < 0) return false;
  const pathPart = withoutScheme.slice(slashIdx + 1).split('?')[0]?.trim() ?? '';
  return pathPart.length > 0;
}

function parseExplicitTimeoutFromUri(uri: string | undefined, param: string): number | null {
  if (!uri) return null;
  const qIdx = uri.indexOf('?');
  if (qIdx < 0) return null;
  const params = new URLSearchParams(uri.slice(qIdx + 1));
  const raw = params.get(param);
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function isSrvDnsError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const msg = 'message' in err ? String((err as { message?: unknown }).message ?? '') : '';
  const code = 'code' in err ? String((err as { code?: unknown }).code ?? '') : '';
  return (
    msg.includes('querySrv') ||
    ['ENODATA', 'EREFUSED', 'ESERVFAIL', 'ETIMEOUT'].includes(code)
  );
}

async function connectMongooseWithDnsFallback(uri: string, opts: ConnectOptions): Promise<typeof mongoose> {
  try {
    return await mongoose.connect(uri, opts);
  } catch (err) {
    if (uri.startsWith('mongodb+srv://') && isSrvDnsError(err)) {
      const currentServers = dns.getServers();
      const nextServers = Array.from(new Set(['1.1.1.1', '8.8.8.8', ...currentServers]));
      dns.setServers(nextServers);
      console.warn(
        '[mongodb] DNS cục bộ không phân giải được bản ghi SRV (querySrv) -> tự động chuyển sang Public DNS (1.1.1.1, 8.8.8.8) và kết nối lại...',
      );
      return mongoose.connect(uri, opts);
    }
    throw err;
  }
}

/**
 * Cấu hình Connection Pool chuẩn Cloud Production (Render -> MongoDB Atlas):
 * - serverSelectionTimeoutMS: 10000ms (chịu được độ trễ cold-start của container Render & cụm M0/M2 Atlas)
 * - connectTimeoutMS: 10000ms, socketTimeoutMS: 45000ms
 * - family: 4 (ép dùng IPv4 tránh lỗi dual-stack IPv6 DNS/TLS handshake treo trên Linux container)
 */
export function buildMongoConnectOptions(uri?: string): ConnectOptions {
  const explicitDb = uri ? uriHasDatabaseName(uri) : true;
  const explicitServerSel = parseExplicitTimeoutFromUri(uri, 'serverSelectionTimeoutMS');
  return {
    ...(explicitDb ? {} : { dbName: DEFAULT_MONGODB_DB_NAME }),
    maxPoolSize: 20,
    minPoolSize: 5,
    serverSelectionTimeoutMS: explicitServerSel ?? 10_000,
    connectTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
    maxIdleTimeMS: 60_000,
    // Ép IPv4 để tránh lỗi DNS/TLS handshake chậm trên container Linux (Render / Docker)
    family: 4,
    retryWrites: true,
    retryReads: true,
    w: 'majority',
    autoIndex: false,
  };
}

let listenersAttached = false;
let shutdownHooksAttached = false;
let manualDisconnect = false;
let isBootConnecting = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
let activeUri = '';
let maxAttempts = 1_000;
let cachedReplicaSetSupport: boolean | null = null;
const reconnectCallbacks = new Set<() => void>();

export function onMongoReadyOrReconnected(cb: () => void): () => void {
  reconnectCallbacks.add(cb);
  return () => {
    reconnectCallbacks.delete(cb);
  };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

export function mapReadyState(readyState: number): ConnectionStateName {
  return READY_STATE_MAP[readyState] ?? 'uninitialized';
}

function scheduleReconnect(): void {
  if (manualDisconnect || isBootConnecting || !activeUri || reconnectTimer) return;
  if (reconnectAttempts >= maxAttempts) {
    console.error(
      `[mongodb] Đã vượt quá ${maxAttempts} lần kết nối lại nền. Kiểm tra ngay MONGODB_URI và Atlas Network Access (0.0.0.0/0).`,
    );
    return;
  }
  reconnectAttempts += 1;
  // Exponential Backoff (1s -> 2s -> 4s ... tối đa 30s) + Jitter [0..500ms] chống Thundering Herd
  const delayMs = Math.min(30_000, 1_000 * 2 ** (reconnectAttempts - 1)) + Math.floor(Math.random() * 500);
  console.warn(`[mongodb] Mất kết nối. Thử kết nối lại lần ${reconnectAttempts}/${maxAttempts} sau ${delayMs}ms...`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (manualDisconnect || isBootConnecting || mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) {
      return;
    }
    connectMongooseWithDnsFallback(activeUri, buildMongoConnectOptions(activeUri))
      .then(() => {
        reconnectAttempts = 0;
        cachedReplicaSetSupport = null;
        console.log('[mongodb] Kết nối lại MongoDB Atlas thành công.');
      })
      .catch((err) => {
        const diag = diagnoseMongoError(err);
        console.error(`[mongodb] Lỗi kết nối lại [${diag.category} - ${diag.errorName}]: ${diag.message}`);
        scheduleReconnect();
      });
  }, delayMs);
  reconnectTimer.unref?.();
}

function attachConnectionListeners(): void {
  if (listenersAttached) return;
  listenersAttached = true;

  mongoose.connection.on('connected', () => {
    reconnectAttempts = 0;
    cachedReplicaSetSupport = null;
    clearReconnectTimer();
    console.log(`[mongodb] connected -> database="${mongoose.connection.name || 'default'}"`);
    for (const cb of reconnectCallbacks) {
      try {
        cb();
      } catch (e) {
        console.error('[mongodb] lỗi callback onMongoReadyOrReconnected:', e);
      }
    }
  });

  mongoose.connection.on('reconnected', () => {
    reconnectAttempts = 0;
    cachedReplicaSetSupport = null;
    clearReconnectTimer();
    console.log('[mongodb] reconnected -> phiên kết nối MongoDB Atlas đã khôi phục.');
    for (const cb of reconnectCallbacks) {
      try {
        cb();
      } catch (e) {
        console.error('[mongodb] lỗi callback onMongoReadyOrReconnected:', e);
      }
    }
  });

  mongoose.connection.on('disconnected', () => {
    console.warn(`[mongodb] disconnected (manual=${manualDisconnect}).`);
    if (!manualDisconnect) {
      scheduleReconnect();
    }
  });

  mongoose.connection.on('error', (err) => {
    console.error(`[mongodb] error -> ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Đăng ký Graceful Shutdown cho tiến trình Node.js khi nhận SIGINT / SIGTERM:
 * - Nếu tiến trình chưa có listener SIGINT/SIGTERM khác (ví dụ chạy worker/CLI), đóng kết nối sạch rồi thoát 0.
 * - Nếu HTTP server đã gắn listener riêng (src/index.ts), phối hợp đóng kết nối MongoDB an toàn không cắt ngang HTTP drain.
 */
export function registerGracefulShutdown(): void {
  if (shutdownHooksAttached) return;
  shutdownHooksAttached = true;

  const handleSignal = (signal: NodeJS.Signals): void => {
    const otherListeners = process.listenerCount(signal) - 1;
    console.log(`[mongodb] Nhận tín hiệu ${signal}, đang đóng kết nối MongoDB an toàn...`);
    disconnectDatabase()
      .then(() => {
        console.log('[mongodb] Đã đóng kết nối MongoDB sạch sẽ.');
        if (otherListeners <= 0) {
          process.exit(0);
        }
      })
      .catch((err) => {
        console.error('[mongodb] Lỗi khi đóng kết nối MongoDB:', err);
        if (otherListeners <= 0) {
          process.exit(1);
        }
      });
  };

  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
}

/**
 * Đồng bộ toàn bộ hệ thống Indexes (2dsphere, Compound IOC, Unique Sparse syncId, TTL dọn rác)
 * cho tất cả Mongoose Models đã đăng ký.
 */
export async function ensureDatabaseIndexes(): Promise<IndexSyncSummary[]> {
  // Lazy import tránh circular dependency khi models import helper từ config
  const models = await import('../models/index.js');
  const targets = [
    models.Ward,
    models.User,
    models.Incident,
    models.SpamLog,
    models.OtpToken,
    models.AiCache,
    models.AuditLog,
    models.ReportModel,
    models.UserModel,
    models.ImageFingerprintModel,
    models.AiEvaluationModel,
    models.AiConfigModel,
    models.OtpModel,
    models.SessionModel,
    models.AuditLogModel,
    models.ApiKey,
  ].filter(Boolean);

  const summaries = await Promise.all(
    targets.map(async (m): Promise<IndexSyncSummary> => {
      try {
        await m.createIndexes();
      } catch (err) {
        console.warn(
          `[mongodb] Cảnh báo khi đồng bộ index cho ${m.collection.collectionName}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      const rawIndexes = await m.collection.indexes().catch(() => []);
      return {
        modelName: m.modelName,
        collectionName: m.collection.collectionName,
        indexCount: rawIndexes.length,
        indexes: rawIndexes.map((idx: Record<string, unknown>) => String(idx.name ?? 'unnamed')),
      };
    }),
  );
  console.log(
    `[mongodb] Đã đồng bộ createIndexes() song song cho ${summaries.length} collections (${summaries.map((s) => s.collectionName).join(', ')}).`,
  );
  return summaries;
}

/**
 * Kết nối tới MongoDB Atlas với cơ chế Retry có giới hạn (Exponential Backoff) lúc Cold-Start.
 * Tránh fail ngay ở lần thử đầu tiên khi container Render hoặc cụm M0/M2 vừa thức dậy.
 */
export async function connectDatabase(options: ConnectDbOptions = {}): Promise<typeof mongoose> {
  const uri = (options.uri ?? process.env.MONGODB_URI ?? '').trim();
  if (!uri) {
    throw new Error(
      'Thiếu biến môi trường MONGODB_URI. Hãy cấu hình chuỗi kết nối MongoDB Atlas trong backend/.env hoặc Render Dashboard.',
    );
  }
  if (!/^mongodb(\+srv)?:\/\/.+/.test(uri)) {
    throw new Error('MONGODB_URI không đúng định dạng (yêu cầu mongodb:// hoặc mongodb+srv://).');
  }

  const masked = maskMongoUri(uri);
  const isTestEnv = process.env.NODE_ENV === 'test';
  const explicitFastTimeout = parseExplicitTimeoutFromUri(uri, 'serverSelectionTimeoutMS');
  const defaultRetries = isTestEnv || (explicitFastTimeout !== null && explicitFastTimeout <= 1_000) ? 2 : 5;
  const totalAttempts = Math.max(1, options.bootRetries ?? defaultRetries);
  const baseDelayMs = Math.max(50, options.retryBaseDelayMs ?? (isTestEnv ? 120 : 1_000));

  activeUri = uri;
  maxAttempts = options.maxReconnectAttempts ?? 1_000;
  manualDisconnect = false;
  cachedReplicaSetSupport = null;

  attachConnectionListeners();
  if (options.registerShutdownHooks !== false) {
    registerGracefulShutdown();
  }

  if (mongoose.connection.readyState !== 1) {
    isBootConnecting = true;
    clearReconnectTimer();
    let lastErr: unknown;
    try {
      for (let attempt = 1; attempt <= totalAttempts; attempt++) {
        try {
          if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect().catch(() => undefined);
          }
          const connectOpts = buildMongoConnectOptions(uri);
          console.log(
            `[mongodb] Đang kết nối tới ${masked.protocol}://${masked.host}/${masked.dbName} ` +
              `(lần ${attempt}/${totalAttempts}, family=IPv4, timeout=${connectOpts.serverSelectionTimeoutMS}ms)...`,
          );
          await connectMongooseWithDnsFallback(uri, connectOpts);
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          const diag = diagnoseMongoError(err);
          console.error(
            `[mongodb] Kết nối lần ${attempt}/${totalAttempts} thất bại [${diag.category} - ${diag.errorName}]: ${diag.message}\n` +
              `          -> Chẩn đoán: ${diag.hint}`,
          );
          if (attempt < totalAttempts && !manualDisconnect) {
            // Không cần retry lặp lại nếu lỗi xác thực sai mật khẩu cố định hoặc URI sai cú pháp
            if (diag.category === 'AUTH_FAILED' || diag.category === 'INVALID_URI') {
              break;
            }
            const backoffMs = Math.min(15_000, baseDelayMs * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
            console.warn(`[mongodb] Chờ ${backoffMs}ms trước khi thử lại lần ${attempt + 1}/${totalAttempts}...`);
            await sleepMs(backoffMs);
          }
        }
      }
      if (lastErr !== undefined) {
        throw lastErr;
      }
    } finally {
      isBootConnecting = false;
    }
  }

  if (options.ensureIndexes !== false) {
    await ensureDatabaseIndexes();
  }

  return mongoose;
}

/** Đóng kết nối MongoDB gọn gàng và hủy bộ đếm reconnect nền. */
export async function disconnectDatabase(): Promise<void> {
  manualDisconnect = true;
  cachedReplicaSetSupport = null;
  clearReconnectTimer();
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

/**
 * Kiểm tra sức khỏe thực tế của MongoDB bằng lệnh `db.admin().ping()` kèm độ trễ và tổng số bản ghi thật.
 */
export async function getDatabaseHealth(): Promise<DatabaseHealth> {
  const state = mapReadyState(mongoose.connection.readyState);
  const db = mongoose.connection.db;

  if (state !== 'connected' || !db) {
    return {
      ok: false,
      state,
      latencyMs: null,
      collectionsCount: 0,
      totalIncidents: 0,
      totalUsers: 0,
    };
  }

  try {
    const start = performance.now();
    const pingResult = await db.admin().ping();
    const latencyMs = Math.round((performance.now() - start) * 100) / 100;

    const models = await import('../models/index.js');
    const [collections, incidentsCount, reportsCount, usersCount, appUsersCount] = await Promise.all([
      db.listCollections({}, { nameOnly: true }).toArray(),
      models.Incident.estimatedDocumentCount().catch(() => 0),
      models.ReportModel.estimatedDocumentCount().catch(() => 0),
      models.User.estimatedDocumentCount().catch(() => 0),
      models.UserModel.estimatedDocumentCount().catch(() => 0),
    ]);

    return {
      ok: Boolean(pingResult?.ok === 1),
      state: mapReadyState(mongoose.connection.readyState),
      latencyMs,
      collectionsCount: collections.length,
      totalIncidents: incidentsCount + reportsCount,
      totalUsers: Math.max(usersCount, appUsersCount),
    };
  } catch (err) {
    console.error(`[mongodb] Health ping thất bại: ${err instanceof Error ? err.message : String(err)}`);
    return {
      ok: false,
      state: mapReadyState(mongoose.connection.readyState),
      latencyMs: null,
      collectionsCount: 0,
      totalIncidents: 0,
      totalUsers: 0,
    };
  }
}

/** Kiểm tra cụm MongoDB hiện tại có hỗ trợ Multi-Document Transactions (Replica Set / Mongos) hay không. */
export async function supportsTransactions(): Promise<boolean> {
  if (cachedReplicaSetSupport !== null) return cachedReplicaSetSupport;
  const db = mongoose.connection.db;
  if (mongoose.connection.readyState !== 1 || !db) return false;
  try {
    const hello = await db.admin().command({ hello: 1 });
    cachedReplicaSetSupport = Boolean(hello.setName || hello.msg === 'isdbgrid');
    return cachedReplicaSetSupport;
  } catch {
    cachedReplicaSetSupport = false;
    return false;
  }
}

/**
 * Thực thi hàm ghi dữ liệu trong MongoDB Transaction (ACID) khi kết nối tới Atlas Replica Set / Sharded Cluster;
 * tự động fallback sang thực thi tuần tự không session khi chạy trên standalone mongod cục bộ.
 */
export async function withMongoTransaction<T>(
  work: (session: ClientSession | null) => Promise<T>,
): Promise<T> {
  if (!(await supportsTransactions())) {
    return work(null);
  }
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(
      async () => {
        result = await work(session);
      },
      {
        readConcern: { level: 'majority' },
        writeConcern: { w: 'majority' },
        readPreference: 'primary',
      },
    );
    return result;
  } finally {
    await session.endSession();
  }
}

export function getMongoStatus(): { readyState: number; connected: boolean; dbName: string } {
  return {
    readyState: mongoose.connection.readyState,
    connected: mongoose.connection.readyState === 1,
    dbName: mongoose.connection.name || '',
  };
}

// Aliases giữ tương thích ngược với các module/test đang import từ config/db
export const connectMongoDB = connectDatabase;
export const disconnectMongoDB = disconnectDatabase;
