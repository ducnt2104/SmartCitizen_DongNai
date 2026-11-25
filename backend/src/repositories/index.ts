import { diagnoseMongoError, maskMongoUri } from '../config/database';
import { env } from '../config/env';
import { HttpError } from '../utils/errors';
import { createJsonRepositories } from './jsonRepositories';
import { createMongoRepositories } from './mongoRepositories';
import type { DbHealthStats, Repositories } from './types';

export type DbLifecycleState =
  | 'connected'
  | 'connecting'
  | 'reconnecting'
  | 'fallback_json'
  | 'unconfigured';

export interface RepositoryBootInfo {
  repos: Repositories;
  /** Lý do dùng JSON thay vì MongoDB (khi chưa khai báo MONGODB_URI ở dev/test hoặc khi bật ALLOW_JSON_FALLBACK=true) */
  fallbackReason: string | null;
  /** Trạng thái vòng đời kết nối DB phục vụ non-blocking startup & chẩn đoán trên Render */
  dbState?: DbLifecycleState;
  /** Chi tiết lỗi kết nối gần nhất đã được ẩn mật khẩu an toàn */
  lastError?: string | null;
}

export interface CreateRepositoriesOptions {
  bootRetries?: number;
  retryBaseDelayMs?: number;
  allowJsonFallback?: boolean;
}

function logDbEnvironmentSummary(uri: string, allowJsonFallback: boolean): void {
  const masked = maskMongoUri(uri);
  console.log(
    `[db] Chế độ môi trường: NODE_ENV=${env.nodeEnv} | RENDER=${Boolean(process.env.RENDER)} | ` +
      `MONGODB_URI=${masked.configured ? `đã nhận (${masked.protocol}://${masked.host}/${masked.dbName})` : 'CHƯA CẤU HÌNH'} | ` +
      `ALLOW_JSON_FALLBACK=${allowJsonFallback}`,
  );
}

/**
 * Khởi tạo tầng lưu trữ đồng bộ (dùng cho CLI scripts, tests, hoặc worker cần kết nối xong ngay):
 * - Thử kết nối MongoDB Atlas tối đa `bootRetries` lần với Exponential Backoff (mặc định 5 lần ở prod/dev).
 * - Nếu `ALLOW_JSON_FALLBACK=true` (kể cả trên môi trường Cloud/Render khi được bật tường minh), tự động chuyển mượt sang JSON Store.
 * - Nếu `ALLOW_JSON_FALLBACK=false` và kết nối thất bại sau toàn bộ lượt retry, ném lỗi kèm chẩn đoán chi tiết (ẩn mật khẩu).
 */
export async function createRepositories(
  customMongoUri?: string,
  options?: CreateRepositoriesOptions,
): Promise<RepositoryBootInfo> {
  const uri = (customMongoUri ?? env.mongoUri ?? '').trim();
  const allowFallback = options?.allowJsonFallback ?? (!customMongoUri && env.allowJsonFallback);

  logDbEnvironmentSummary(uri, allowFallback);

  if (uri) {
    try {
      const repos = await createMongoRepositories(uri, {
        bootRetries: options?.bootRetries,
        retryBaseDelayMs: options?.retryBaseDelayMs,
      });
      return { repos, fallbackReason: null, dbState: 'connected', lastError: null };
    } catch (err) {
      const diag = diagnoseMongoError(err);
      const safeDetail = `[${diag.category} - ${diag.errorName}] ${diag.message} (${diag.hint})`;
      if (!allowFallback) {
        throw new Error(
          `[db] FATAL: Đã cấu hình MONGODB_URI nhưng kết nối MongoDB Atlas thất bại sau các lượt retry ${safeDetail}`,
        );
      }
      const reason = `Không kết nối được MongoDB Atlas ${safeDetail} — ALLOW_JSON_FALLBACK=true nên chuyển mượt sang Local JSON Store.`;
      console.warn(`[db] CẢNH BÁO: ${reason}`);
      return {
        repos: createJsonRepositories(env.dataDir),
        fallbackReason: reason,
        dbState: 'fallback_json',
        lastError: safeDetail,
      };
    }
  }

  if (env.isProd && !allowFallback) {
    throw new Error(
      '[db] Môi trường production bắt buộc khai báo MONGODB_URI (MongoDB Atlas) hoặc đặt ALLOW_JSON_FALLBACK=true nếu muốn chạy tạm Local JSON Store.',
    );
  }

  const reason = env.isProd
    ? 'MONGODB_URI chưa cấu hình trên production nhưng ALLOW_JSON_FALLBACK=true — dùng Local Persistent JSON Store.'
    : 'MONGODB_URI chưa cấu hình (dev/test) — dùng Local Persistent JSON Store.';
  return {
    repos: createJsonRepositories(env.dataDir),
    fallbackReason: reason,
    dbState: 'fallback_json',
    lastError: null,
  };
}

function createUnavailableEntityProxy<T extends object>(
  entityName: string,
  getDelegate: () => T | null,
  getBootInfo: () => RepositoryBootInfo,
): T {
  return new Proxy({} as T, {
    get(_target, prop, receiver) {
      const delegate = getDelegate();
      if (delegate) {
        const val = Reflect.get(delegate, prop, receiver);
        return typeof val === 'function' ? val.bind(delegate) : val;
      }
      if (prop === 'then') return undefined;
      return async () => {
        const info = getBootInfo();
        const msg =
          info.dbState === 'unconfigured'
            ? 'Chưa cấu hình biến môi trường MONGODB_URI trên máy chủ.'
            : 'Hệ thống đang kết nối tới MongoDB Atlas (cold-start / retry nền), vui lòng thử lại sau vài giây.';
        throw new HttpError(503, msg, 'database_connecting', {
          dbState: info.dbState,
          diagnostic: info.lastError,
        });
      };
    },
  });
}

export interface NonBlockingBootController {
  boot: RepositoryBootInfo;
  /** Chạy vòng lặp kết nối MongoDB ở hậu cảnh (5 lần boot retry + phục hồi tự động không làm sập HTTP server). */
  startBackgroundConnect: (onReady?: (repos: Repositories) => Promise<void>) => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Khởi tạo Non-Blocking cho HTTP Server (`src/index.ts`):
 * - Cho phép Express bind `PORT` và mở `/healthz` ngay lập tức để Render không bao giờ kill container hoặc rơi vào crash-loop `exit(1)`.
 * - Chạy 5 lần retry kết nối MongoDB Atlas với Exponential Backoff ngay ở hậu cảnh; nếu `ALLOW_JSON_FALLBACK=true` sẽ tự chuyển mượt sang JSON Store;
 *   nếu `ALLOW_JSON_FALLBACK=false` sẽ giữ HTTP server sống và tiếp tục tự động kết nối lại nền cho tới khi MongoDB Atlas sẵn sàng.
 */
export function createNonBlockingServerRepositories(options?: CreateRepositoriesOptions): NonBlockingBootController {
  const uri = (env.mongoUri ?? '').trim();
  const allowFallback = options?.allowJsonFallback ?? env.allowJsonFallback;

  logDbEnvironmentSummary(uri, allowFallback);

  // Trường hợp chưa cấu hình MONGODB_URI và được phép chạy JSON Store (dev/test hoặc bật ALLOW_JSON_FALLBACK=true)
  if (!uri && (!env.isProd || allowFallback)) {
    const jsonRepos = createJsonRepositories(env.dataDir);
    const reason = env.isProd
      ? 'MONGODB_URI chưa cấu hình nhưng ALLOW_JSON_FALLBACK=true — dùng Local Persistent JSON Store.'
      : 'MONGODB_URI chưa cấu hình (dev/test) — dùng Local Persistent JSON Store.';
    const boot: RepositoryBootInfo = {
      repos: jsonRepos,
      fallbackReason: reason,
      dbState: 'fallback_json',
      lastError: null,
    };
    return {
      boot,
      startBackgroundConnect: async (onReady) => {
        if (onReady) await onReady(jsonRepos);
      },
      stop: async () => {
        await jsonRepos.close();
      },
    };
  }

  let activeRepos: Repositories | null = null;
  let stopped = false;
  let bgTimer: NodeJS.Timeout | null = null;

  const emptyStats = (): DbHealthStats => ({
    ok: false,
    latencyMs: 0,
    counts: { reports: 0, users: 0, fingerprints: 0, evaluations: 0, auditLogs: 0 },
  });

  const boot: RepositoryBootInfo = {
    repos: null as unknown as Repositories,
    fallbackReason: null,
    dbState: uri ? 'connecting' : 'unconfigured',
    lastError: uri
      ? null
      : 'Thiếu biến môi trường MONGODB_URI trên Render Dashboard -> Environment (hoặc bật ALLOW_JSON_FALLBACK=true).',
  };

  const proxyRepos: Repositories = {
    get mode() {
      return activeRepos ? activeRepos.mode : 'mongodb';
    },
    reports: createUnavailableEntityProxy('reports', () => activeRepos?.reports ?? null, () => boot),
    users: createUnavailableEntityProxy('users', () => activeRepos?.users ?? null, () => boot),
    fingerprints: createUnavailableEntityProxy('fingerprints', () => activeRepos?.fingerprints ?? null, () => boot),
    evaluations: createUnavailableEntityProxy('evaluations', () => activeRepos?.evaluations ?? null, () => boot),
    aiConfig: createUnavailableEntityProxy('aiConfig', () => activeRepos?.aiConfig ?? null, () => boot),
    audit: createUnavailableEntityProxy('audit', () => activeRepos?.audit ?? null, () => boot),
    otps: createUnavailableEntityProxy('otps', () => activeRepos?.otps ?? null, () => boot),
    sessions: createUnavailableEntityProxy('sessions', () => activeRepos?.sessions ?? null, () => boot),
    ping: async () => (activeRepos ? activeRepos.ping() : false),
    healthStats: async () => (activeRepos ? activeRepos.healthStats() : emptyStats()),
    close: async () => {
      if (activeRepos) await activeRepos.close();
    },
  };

  boot.repos = proxyRepos;

  const startBackgroundConnect = async (onReady?: (repos: Repositories) => Promise<void>): Promise<void> => {
    if (!uri) {
      console.error(
        '[db] CẢNH BÁO NGHIÊM TRỌNG: Đang chạy NODE_ENV=production nhưng chưa khai báo MONGODB_URI và ALLOW_JSON_FALLBACK=false. ' +
          'HTTP Server vẫn mở cổng để không bị Render crash-loop; hãy thêm MONGODB_URI vào Render Dashboard -> Environment!',
      );
      return;
    }

    const attemptMongoConnect = async (bootRetries: number): Promise<boolean> => {
      try {
        const mongoRepos = await createMongoRepositories(uri, {
          bootRetries,
          retryBaseDelayMs: options?.retryBaseDelayMs,
        });
        if (stopped) {
          await mongoRepos.close();
          return false;
        }
        const prevRepos = activeRepos;
        activeRepos = mongoRepos;
        boot.dbState = 'connected';
        boot.fallbackReason = null;
        boot.lastError = null;
        if (prevRepos && prevRepos.mode === 'json') {
          await prevRepos.close().catch(() => undefined);
        }
        if (onReady) {
          await onReady(proxyRepos);
        }
        console.log('[db] Đã kết nối MongoDB Atlas & đồng bộ dữ liệu sẵn sàng phục vụ!');
        return true;
      } catch (err) {
        const diag = diagnoseMongoError(err);
        boot.lastError = `[${diag.category} - ${diag.errorName}] ${diag.message} | Gợi ý: ${diag.hint}`;
        return false;
      }
    };

    // Pha 1: Thử tối đa 5 lần với Exponential Backoff ngay lúc khởi động
    const ok = await attemptMongoConnect(options?.bootRetries ?? 5);
    if (ok || stopped) return;

    // Pha 2: Nếu bật ALLOW_JSON_FALLBACK=true -> chuyển mượt sang JSON Store ngay lập tức mà không sập server
    if (allowFallback) {
      const jsonRepos = createJsonRepositories(env.dataDir);
      activeRepos = jsonRepos;
      boot.dbState = 'fallback_json';
      boot.fallbackReason = `MongoDB Atlas tạm thời chưa kết nối được (${boot.lastError}) — ALLOW_JSON_FALLBACK=true nên đã chuyển mượt sang Local JSON Store.`;
      console.warn(`[db] ${boot.fallbackReason}`);
      if (onReady) {
        await onReady(proxyRepos).catch((e) => console.error('[db] Lỗi seed trên JSON fallback:', e));
      }
    } else {
      boot.dbState = 'reconnecting';
      console.error(
        `[db] Không thể kết nối MongoDB Atlas sau đợt khởi tạo đầu tiên: ${boot.lastError}\n` +
          '[db] HTTP Server vẫn giữ cổng lắng nghe (tránh crash-loop trên Render) và tiếp tục thử kết nối lại MongoDB ở hậu cảnh...',
      );
    }

    // Pha 3: Worker nền tự động thử kết nối lại tới MongoDB Atlas định kỳ (15s -> 30s) cho đến khi thành công
    let bgAttempt = 0;
    const scheduleNextProbe = (): void => {
      if (stopped || boot.dbState === 'connected') return;
      bgAttempt += 1;
      const delayMs = Math.min(30_000, 10_000 * Math.min(3, bgAttempt));
      bgTimer = setTimeout(() => {
        bgTimer = null;
        if (stopped || boot.dbState === 'connected') return;
        console.log(`[db] Worker nền đang thử kết nối lại tới MongoDB Atlas (đợt #${bgAttempt})...`);
        attemptMongoConnect(1)
          .then((connected) => {
            if (!connected) scheduleNextProbe();
          })
          .catch(() => scheduleNextProbe());
      }, delayMs);
      bgTimer.unref?.();
    };

    scheduleNextProbe();
  };

  return {
    boot,
    startBackgroundConnect,
    stop: async () => {
      stopped = true;
      if (bgTimer) {
        clearTimeout(bgTimer);
        bgTimer = null;
      }
      await proxyRepos.close();
    },
  };
}

export type { Repositories } from './types';
export {
  IncidentRepository,
  incidentRepository,
  type CreateIncidentInput,
  type IocAggregatedStats,
  type IocDashboardQuery,
  type LeanIncident,
  type LeanWard,
  type SpatialBoxQuery,
  type SpatialRadiusQuery,
  type UpsertIncidentResult,
} from './incidentRepository';
