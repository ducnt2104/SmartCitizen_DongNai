import dotenv from 'dotenv';
import { performance } from 'node:perf_hooks';
import mongoose, { type ClientSession, type ConnectOptions } from 'mongoose';

dotenv.config();

export type ConnectionStateName =
  | 'disconnected'
  | 'connected'
  | 'connecting'
  | 'disconnecting'
  | 'uninitialized';

export interface ConnectDbOptions {
  /** Chuỗi kết nối MongoDB Atlas; mặc định đọc từ process.env.MONGODB_URI */
  uri?: string;
  /** Số lần tự động kết nối lại tối đa khi mất kết nối bất ngờ (mặc định 10) */
  maxReconnectAttempts?: number;
  /** Tự động gọi createIndexes() cho toàn bộ collections sau khi kết nối (mặc định true) */
  ensureIndexes?: boolean;
  /** Tự động đăng ký Graceful Shutdown trên SIGINT/SIGTERM (mặc định true) */
  registerShutdownHooks?: boolean;
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

/**
 * Cấu hình Connection Pool chuẩn Production cho SmartCitizen Đồng Nai (MongoDB Atlas):
 * - Bối cảnh triển khai: Node.js/Express long-running backend phục vụ đồng thời 95 Phường/Xã
 *   (IOC Dashboard real-time + Citizen Local-First Outbox đồng bộ hàng loạt khi có mạng).
 * - Zero Mock Fallback: khi đã khai báo MONGODB_URI, hệ thống kết nối trực tiếp tới Atlas và fail-loud nếu lỗi.
 */
export function buildMongoConnectOptions(): ConnectOptions {
  return {
    // Đáp ứng ~20 truy vấn đồng thời (IOC Dashboard + Outbox burst) mà chỉ tốn ~20MB RAM phía Atlas
    maxPoolSize: 20,
    // Duy trì 5 kết nối ấm (TCP + TLS + SCRAM auth sẵn) giúp truy vấn bản đồ đạt <10ms không tốn chi phí bắt tay lại
    minPoolSize: 5,
    // Fail-fast sau 5s nếu sai IP Whitelist, lỗi DNS SRV hoặc mất Primary trong Replica Set
    serverSelectionTimeoutMS: 5_000,
    // Cho phép truy vấn thống kê/aggregation lớn hoặc mạng chập chờn hoàn tất trong tối đa 45s trước khi cắt socket
    socketTimeoutMS: 45_000,
    // Giới hạn thời gian bắt tay TCP + TLS ban đầu tới cụm Atlas
    connectTimeoutMS: 10_000,
    // Giải phóng kết nối nhàn rỗi trên 60s về mức minPoolSize để tiết kiệm tài nguyên cụm M0/M2
    maxIdleTimeMS: 60_000,
    // Tự động thử lại thao tác ghi/đọc đơn lẻ khi bầu chọn lại Primary trên Atlas Replica Set
    retryWrites: true,
    retryReads: true,
    // Đảm bảo ghi bền vững trên đa số node Replica Set — chống mất dữ liệu khi Primary gặp sự cố
    w: 'majority',
    // Tắt autoIndex ngầm lúc runtime để quản lý tường minh qua migrateIndexes / ensureDatabaseIndexes
    autoIndex: false,
  };
}

let listenersAttached = false;
let shutdownHooksAttached = false;
let manualDisconnect = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
let activeUri = '';
let maxAttempts = 10;
let cachedReplicaSetSupport: boolean | null = null;

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
  if (manualDisconnect || !activeUri || reconnectTimer) return;
  if (reconnectAttempts >= maxAttempts) {
    console.error(
      `[mongodb] Đã vượt quá ${maxAttempts} lần kết nối lại. Kiểm tra ngay MONGODB_URI và Atlas Network Access.`,
    );
    return;
  }
  reconnectAttempts += 1;
  // Exponential Backoff (1s -> 2s -> 4s ... tối đa 30s) + Jitter [0..500ms] chống Thundering Herd
  const delayMs = Math.min(30_000, 1_000 * 2 ** (reconnectAttempts - 1)) + Math.floor(Math.random() * 500);
  console.warn(`[mongodb] Mất kết nối. Thử kết nối lại lần ${reconnectAttempts}/${maxAttempts} sau ${delayMs}ms...`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (manualDisconnect || mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) return;
    mongoose
      .connect(activeUri, buildMongoConnectOptions())
      .then(() => {
        reconnectAttempts = 0;
        cachedReplicaSetSupport = null;
        console.log('[mongodb] Kết nối lại MongoDB Atlas thành công.');
      })
      .catch((err) => {
        console.error(`[mongodb] Lỗi kết nối lại: ${err instanceof Error ? err.message : String(err)}`);
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
  });

  mongoose.connection.on('reconnected', () => {
    reconnectAttempts = 0;
    cachedReplicaSetSupport = null;
    clearReconnectTimer();
    console.log('[mongodb] reconnected -> phiên kết nối MongoDB Atlas đã khôi phục.');
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
    models.OtpModel,
    models.SessionModel,
    models.AuditLogModel,
  ].filter(Boolean);

  const summaries: IndexSyncSummary[] = [];
  for (const m of targets) {
    await m.createIndexes();
    const rawIndexes = await m.collection.indexes().catch(() => []);
    summaries.push({
      modelName: m.modelName,
      collectionName: m.collection.collectionName,
      indexCount: rawIndexes.length,
      indexes: rawIndexes.map((idx: Record<string, unknown>) => String(idx.name ?? 'unnamed')),
    });
  }
  console.log(
    `[mongodb] Đã đồng bộ createIndexes() cho ${summaries.length} collections (${summaries.map((s) => s.collectionName).join(', ')}).`,
  );
  return summaries;
}

/**
 * Kết nối trực tiếp tới MongoDB Atlas (Zero Mock Fallback).
 * Ném lỗi tường minh nếu thiếu hoặc sai định dạng `MONGODB_URI`, hoặc không kết nối được tới cluster.
 */
export async function connectDatabase(options: ConnectDbOptions = {}): Promise<typeof mongoose> {
  const uri = (options.uri ?? process.env.MONGODB_URI ?? '').trim();
  if (!uri) {
    throw new Error(
      'Thiếu biến môi trường MONGODB_URI. Hãy cấu hình chuỗi kết nối MongoDB Atlas trong backend/.env (không dùng mock fallback).',
    );
  }
  if (!/^mongodb(\+srv)?:\/\/.+/.test(uri)) {
    throw new Error('MONGODB_URI không đúng định dạng (yêu cầu mongodb:// hoặc mongodb+srv://).');
  }

  activeUri = uri;
  maxAttempts = options.maxReconnectAttempts ?? 10;
  manualDisconnect = false;
  cachedReplicaSetSupport = null;

  attachConnectionListeners();
  if (options.registerShutdownHooks !== false) {
    registerGracefulShutdown();
  }

  if (mongoose.connection.readyState !== 1) {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    await mongoose.connect(uri, buildMongoConnectOptions());
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
