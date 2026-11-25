import mongoose from 'mongoose';
import { diagnoseMongoError, maskMongoUri, onMongoReadyOrReconnected } from '../config/database';
import { env } from '../config/env';
import type { AuditEntry, DynamicAiConfig, Report } from '../shared/types';
import { createJsonRepositories } from './jsonRepositories';
import { createMongoRepositories } from './mongoRepositories';
import {
  createLocalPersistentRepositories,
  type LocalPersistentRepositories,
  type SyncCollectionName,
} from './sqliteRepositories';
import type {
  AiEvaluationRecord,
  DbHealthStats,
  ImageFingerprintRecord,
  OtpRecord,
  Repositories,
  SessionRecord,
  UserRecord,
} from './types';

export type DbLifecycleState =
  | 'connected'
  | 'connecting'
  | 'reconnecting'
  | 'fallback_json'
  | 'local_standby'
  | 'unconfigured';

export interface RepositoryBootInfo {
  repos: Repositories;
  /** Lý do dùng bộ đệm Local thay vì MongoDB trực tiếp */
  fallbackReason: string | null;
  /** Trạng thái vòng đời kết nối DB phục vụ non-blocking startup & chẩn đoán trên Render */
  dbState?: DbLifecycleState;
  /** Chi tiết lỗi kết nối gần nhất đã được ẩn mật khẩu an toàn (chỉ dùng cho server log / admin diagnostics) */
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
 * Khởi tạo tầng lưu trữ đồng bộ (dùng cho CLI scripts, tests, hoặc worker cần kết nối xong ngay).
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
      const reason = `Không kết nối được MongoDB Atlas ${safeDetail} — chuyển mượt sang Local Persistent Store.`;
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
      '[db] Môi trường production bắt buộc khai báo MONGODB_URI hoặc bật ALLOW_JSON_FALLBACK=true.',
    );
  }

  const reason = env.isProd
    ? 'MONGODB_URI chưa cấu hình trên production nhưng ALLOW_JSON_FALLBACK=true — dùng Local Persistent Store.'
    : 'MONGODB_URI chưa cấu hình (dev/test) — dùng Local Persistent Store.';
  return {
    repos: createJsonRepositories(env.dataDir),
    fallbackReason: reason,
    dbState: 'fallback_json',
    lastError: null,
  };
}

function isTransientMongoRuntimeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = 'name' in err ? String((err as { name?: unknown }).name ?? '') : '';
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /MongoServerSelectionError|MongooseServerSelectionError|MongoNetworkError|MongoNetworkTimeoutError|MongoNotConnectedError|MongoTopologyClosedError/i.test(
      name,
    ) ||
    /Client must be connected|Topology is closed|Server selection timed out|Could not connect to any servers|ECONNRESET|ETIMEDOUT|buffering timed out/i.test(
      msg,
    )
  );
}

/**
 * Đồng bộ 2 chiều giữa Local SQLite/Persistent Cache và MongoDB Atlas:
 * 1) Đẩy toàn bộ bản ghi `dirty` phát sinh lúc cold-start / đứt mạng lên MongoDB Atlas.
 * 2) Kéo dữ liệu mới nhất từ MongoDB Atlas về bộ đệm nóng cục bộ.
 */
async function syncBidirectionalWithAtlas(
  mongoRepos: Repositories,
  localRepos: LocalPersistentRepositories,
): Promise<{ pushed: number; hydratedUsers: number; hydratedReports: number }> {
  const dirtyEntries = localRepos.listDirtyEntries();
  let pushed = 0;

  for (const item of dirtyEntries) {
    try {
      switch (item.collection) {
        case 'users':
          if (item.deleted) await mongoRepos.users.delete(item.id);
          else await mongoRepos.users.save(item.payload as UserRecord);
          break;
        case 'reports': {
          if (item.deleted) {
            await mongoRepos.reports.delete(item.id);
          } else {
            const rep = item.payload as Report;
            const existing = await mongoRepos.reports.get(rep.id);
            if (existing) await mongoRepos.reports.update(rep);
            else await mongoRepos.reports.insert(rep);
          }
          break;
        }
        case 'otps':
          if (item.deleted) await mongoRepos.otps.delete(item.id);
          else await mongoRepos.otps.save(item.payload as OtpRecord);
          break;
        case 'sessions':
          await mongoRepos.sessions.save(item.payload as SessionRecord);
          break;
        case 'fingerprints':
          await mongoRepos.fingerprints.save(item.payload as ImageFingerprintRecord);
          break;
        case 'evaluations':
          await mongoRepos.evaluations.append(item.payload as AiEvaluationRecord).catch(() => undefined);
          break;
        case 'aiConfig':
          await mongoRepos.aiConfig.save(item.payload as DynamicAiConfig);
          break;
        case 'audit':
          await mongoRepos.audit.append(item.payload as AuditEntry).catch(() => undefined);
          break;
      }
      localRepos.clearDirtyEntry(item.collection, item.id);
      pushed += 1;
    } catch (err) {
      console.warn(
        `[db-sync] Chưa đẩy được bản ghi ${item.collection}:${item.id} lên MongoDB (sẽ thử lại ở chu kỳ sau):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const [remoteUsers, remoteReports, remoteAiCfg] = await Promise.all([
    mongoRepos.users.list().catch(() => [] as UserRecord[]),
    mongoRepos.reports.list({ limit: 400 }).catch(() => [] as Report[]),
    mongoRepos.aiConfig.get().catch(() => null),
  ]);

  for (const u of remoteUsers) {
    localRepos.hydrateClean('users', u.id, u);
  }
  for (const r of remoteReports) {
    localRepos.hydrateClean('reports', r.id, r);
  }
  if (remoteAiCfg) {
    localRepos.hydrateClean('aiConfig', 'global', remoteAiCfg);
  }

  return {
    pushed,
    hydratedUsers: remoteUsers.length,
    hydratedReports: remoteReports.length,
  };
}

export interface NonBlockingBootController {
  boot: RepositoryBootInfo;
  localRepos: LocalPersistentRepositories;
  /** Chạy vòng lặp kết nối MongoDB ở hậu cảnh + đồng bộ 2 chiều tự động không bao giờ làm sập Đăng nhập / Chatbot / Phản ánh. */
  startBackgroundConnect: (onReady?: (repos: Repositories) => Promise<void>) => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Khởi tạo Resilient Local-First + Cloud Sync cho HTTP Server (`src/index.ts`):
 * - Ngay từ mili-giây 0: phục vụ thông qua SQLite WAL (`resilient_local.sqlite` tại `DATA_DIR`) để Đăng nhập, OTP, Báo cáo & Chatbot phản hồi tức thì (0% lỗi 503).
 * - Khi MongoDB Atlas kết nối thành công: ghi trực tiếp xuống Atlas, đồng bộ 2 chiều toàn bộ dữ liệu phát sinh lúc offline/cold-start, và giữ bản sao nóng cục bộ.
 * - Khi MongoDB Atlas chập chờn hoặc chưa whitelist IP: tự động hấp thụ lỗi hạ tầng, ghi vào hàng đợi `dirty` cục bộ và đồng bộ bù ngay khi kết nối khôi phục.
 */
export function createNonBlockingServerRepositories(options?: CreateRepositoriesOptions): NonBlockingBootController {
  const uri = (env.mongoUri ?? '').trim();
  const allowFallback = options?.allowJsonFallback ?? env.allowJsonFallback;

  logDbEnvironmentSummary(uri, allowFallback);

  const localRepos = createLocalPersistentRepositories(env.dataDir, {
    markWritesDirtyByDefault: Boolean(uri),
  });

  if (!uri && (!env.isProd || allowFallback)) {
    const reason = env.isProd
      ? 'MONGODB_URI chưa cấu hình nhưng ALLOW_JSON_FALLBACK=true — dùng Local Persistent Store.'
      : `MONGODB_URI chưa cấu hình (dev/test) — dùng Local Persistent Store (${localRepos.engine}).`;
    const boot: RepositoryBootInfo = {
      repos: localRepos,
      fallbackReason: reason,
      dbState: 'fallback_json',
      lastError: null,
    };
    return {
      boot,
      localRepos,
      startBackgroundConnect: async (onReady) => {
        if (onReady) await onReady(localRepos);
      },
      stop: async () => {
        await localRepos.close();
      },
    };
  }

  let mongoRepos: Repositories | null = null;
  let stopped = false;
  let bgTimer: NodeJS.Timeout | null = null;
  let syncInFlight: Promise<void> | null = null;

  const isMongoLive = (): boolean => Boolean(mongoRepos && mongoose.connection.readyState === 1);

  const boot: RepositoryBootInfo = {
    repos: null as unknown as Repositories,
    fallbackReason: uri
      ? `Đang dùng bộ đệm nóng cục bộ (${localRepos.engine}) trong lúc kết nối đồng bộ MongoDB.`
      : 'Chưa cấu hình MONGODB_URI — đang vận hành trên bộ lưu trữ bền vững cục bộ.',
    dbState: uri ? 'connecting' : 'local_standby',
    lastError: null,
  };

  const handleMongoDegraded = (err: unknown): void => {
    const diag = diagnoseMongoError(err);
    boot.dbState = 'reconnecting';
    boot.lastError = `[${diag.category} - ${diag.errorName}] ${diag.message}`;
    boot.fallbackReason = `Đang duy trì hoạt động không gián đoạn trên bộ đệm cục bộ (${localRepos.engine}) trong khi tự động kết nối lại cơ sở dữ liệu đám mây.`;
    console.error(`[db-resilient] Tạm chuyển sang Local Persistence do lỗi kết nối MongoDB: ${boot.lastError}`);
  };

  const readResilient = async <R>(
    mongoOp: (m: Repositories) => Promise<R>,
    localOp: () => Promise<R>,
  ): Promise<R> => {
    if (isMongoLive() && mongoRepos) {
      try {
        return await mongoOp(mongoRepos);
      } catch (err) {
        if (isTransientMongoRuntimeError(err)) {
          handleMongoDegraded(err);
          return localOp();
        }
        throw err;
      }
    }
    return localOp();
  };

  const writeResilient = async <R>(
    mongoOp: (m: Repositories) => Promise<R>,
    localCleanMirror: (() => void) | null,
    localDirtyOp: () => Promise<R>,
  ): Promise<R> => {
    if (isMongoLive() && mongoRepos) {
      try {
        const res = await mongoOp(mongoRepos);
        localCleanMirror?.();
        return res;
      } catch (err) {
        if (isTransientMongoRuntimeError(err)) {
          handleMongoDegraded(err);
          return localDirtyOp();
        }
        throw err;
      }
    }
    return localDirtyOp();
  };

  const hydrateCollectionItem = <T>(col: SyncCollectionName, id: string, item: T): void => {
    try {
      localRepos.hydrateClean(col, id, item);
    } catch {
      // Không chặn luồng chính nếu ghi bộ đệm phụ gặp sự cố
    }
  };

  const proxyRepos: Repositories = {
    get mode() {
      return isMongoLive() ? 'mongodb' : 'json';
    },
    reports: {
      list: (q) => readResilient((m) => m.reports.list(q), () => localRepos.reports.list(q)),
      get: (id) => readResilient((m) => m.reports.get(id), () => localRepos.reports.get(id)),
      getByCode: (code) => readResilient((m) => m.reports.getByCode(code), () => localRepos.reports.getByCode(code)),
      insert: (report) =>
        writeResilient(
          (m) => m.reports.insert(report),
          () => hydrateCollectionItem('reports', report.id, report),
          () => localRepos.reports.insert(report),
        ),
      update: (report) =>
        writeResilient(
          (m) => m.reports.update(report),
          () => hydrateCollectionItem('reports', report.id, report),
          () => localRepos.reports.update(report),
        ),
      delete: (id) =>
        writeResilient(
          (m) => m.reports.delete(id),
          () => {
            void localRepos.reports.delete(id);
            localRepos.clearDirtyEntry('reports', id);
          },
          () => localRepos.reports.delete(id),
        ),
      claimRescueMission: async (id, claim) => {
        if (isMongoLive() && mongoRepos) {
          try {
            const claimed = await mongoRepos.reports.claimRescueMission(id, claim);
            if (claimed) hydrateCollectionItem('reports', claimed.id, claimed);
            return claimed;
          } catch (err) {
            if (isTransientMongoRuntimeError(err)) {
              handleMongoDegraded(err);
              return localRepos.reports.claimRescueMission(id, claim);
            }
            throw err;
          }
        }
        return localRepos.reports.claimRescueMission(id, claim);
      },
      findNearby: (q) => readResilient((m) => m.reports.findNearby(q), () => localRepos.reports.findNearby(q)),
      findSince: (sinceIso) =>
        readResilient((m) => m.reports.findSince(sinceIso), () => localRepos.reports.findSince(sinceIso)),
      countByReporterSince: (reporterId, sinceIso) =>
        readResilient(
          (m) => m.reports.countByReporterSince(reporterId, sinceIso),
          () => localRepos.reports.countByReporterSince(reporterId, sinceIso),
        ),
      count: () => readResilient((m) => m.reports.count(), () => localRepos.reports.count()),
    },
    users: {
      get: (id) => readResilient((m) => m.users.get(id), () => localRepos.users.get(id)),
      getByPhone: (phone) => readResilient((m) => m.users.getByPhone(phone), () => localRepos.users.getByPhone(phone)),
      getByEmail: (email) => readResilient((m) => m.users.getByEmail(email), () => localRepos.users.getByEmail(email)),
      getByStaffCode: (code) =>
        readResilient((m) => m.users.getByStaffCode(code), () => localRepos.users.getByStaffCode(code)),
      save: (user) =>
        writeResilient(
          (m) => m.users.save(user),
          () => hydrateCollectionItem('users', user.id, user),
          () => localRepos.users.save(user),
        ),
      delete: (id) =>
        writeResilient(
          (m) => m.users.delete(id),
          () => localRepos.clearDirtyEntry('users', id),
          () => localRepos.users.delete(id),
        ),
      list: (role) => readResilient((m) => m.users.list(role), () => localRepos.users.list(role)),
      query: (filter) => readResilient((m) => m.users.query(filter), () => localRepos.users.query(filter)),
      count: () => readResilient((m) => m.users.count(), () => localRepos.users.count()),
    },
    fingerprints: {
      save: (fp) =>
        writeResilient(
          (m) => m.fingerprints.save(fp),
          () => hydrateCollectionItem('fingerprints', fp.id, fp),
          () => localRepos.fingerprints.save(fp),
        ),
      findNearbyRecent: (lat, lng, radiusM, sinceIso) =>
        readResilient(
          (m) => m.fingerprints.findNearbyRecent(lat, lng, radiusM, sinceIso),
          () => localRepos.fingerprints.findNearbyRecent(lat, lng, radiusM, sinceIso),
        ),
      listByReport: (reportId) =>
        readResilient((m) => m.fingerprints.listByReport(reportId), () => localRepos.fingerprints.listByReport(reportId)),
      count: () => readResilient((m) => m.fingerprints.count(), () => localRepos.fingerprints.count()),
    },
    evaluations: {
      append: (rec) =>
        writeResilient(
          (m) => m.evaluations.append(rec),
          () => hydrateCollectionItem('evaluations', rec.id, rec),
          () => localRepos.evaluations.append(rec),
        ),
      listByReport: (reportId) =>
        readResilient((m) => m.evaluations.listByReport(reportId), () => localRepos.evaluations.listByReport(reportId)),
      recent: (limit) => readResilient((m) => m.evaluations.recent(limit), () => localRepos.evaluations.recent(limit)),
      count: () => readResilient((m) => m.evaluations.count(), () => localRepos.evaluations.count()),
    },
    aiConfig: {
      get: () => readResilient((m) => m.aiConfig.get(), () => localRepos.aiConfig.get()),
      save: (cfg) =>
        writeResilient(
          (m) => m.aiConfig.save(cfg),
          () => hydrateCollectionItem('aiConfig', 'global', cfg),
          () => localRepos.aiConfig.save(cfg),
        ),
    },
    audit: {
      last: () => readResilient((m) => m.audit.last(), () => localRepos.audit.last()),
      append: (entry) =>
        writeResilient(
          (m) => m.audit.append(entry),
          () => hydrateCollectionItem('audit', String(entry.seq), entry),
          () => localRepos.audit.append(entry),
        ),
      list: (limit) => readResilient((m) => m.audit.list(limit), () => localRepos.audit.list(limit)),
      all: () => readResilient((m) => m.audit.all(), () => localRepos.audit.all()),
    },
    otps: {
      get: (identifier) => readResilient((m) => m.otps.get(identifier), () => localRepos.otps.get(identifier)),
      save: (rec) =>
        writeResilient(
          (m) => m.otps.save(rec),
          () => hydrateCollectionItem('otps', rec.identifier, rec),
          () => localRepos.otps.save(rec),
        ),
      delete: (identifier) =>
        writeResilient(
          (m) => m.otps.delete(identifier),
          () => localRepos.clearDirtyEntry('otps', identifier),
          () => localRepos.otps.delete(identifier),
        ),
    },
    sessions: {
      get: (id) => readResilient((m) => m.sessions.get(id), () => localRepos.sessions.get(id)),
      getByRefreshHash: (refreshHash) =>
        readResilient((m) => m.sessions.getByRefreshHash(refreshHash), () => localRepos.sessions.getByRefreshHash(refreshHash)),
      listActive: (filter) =>
        readResilient((m) => m.sessions.listActive(filter), () => localRepos.sessions.listActive(filter)),
      save: (rec) =>
        writeResilient(
          (m) => m.sessions.save(rec),
          () => hydrateCollectionItem('sessions', rec.id, rec),
          () => localRepos.sessions.save(rec),
        ),
      touch: (id, lastActiveAt, ip) =>
        writeResilient(
          (m) => m.sessions.touch(id, lastActiveAt, ip),
          null,
          () => localRepos.sessions.touch(id, lastActiveAt, ip),
        ),
      revoke: (id, replacedBySessionId, reason) =>
        writeResilient(
          (m) => m.sessions.revoke(id, replacedBySessionId, reason),
          null,
          () => localRepos.sessions.revoke(id, replacedBySessionId, reason),
        ),
      revokeAllForUser: (userId, reason) =>
        writeResilient(
          (m) => m.sessions.revokeAllForUser(userId, reason),
          null,
          () => localRepos.sessions.revokeAllForUser(userId, reason),
        ),
      revokeAllExcept: (userId, exceptSessionId, reason) =>
        writeResilient(
          (m) => m.sessions.revokeAllExcept(userId, exceptSessionId, reason),
          null,
          () => localRepos.sessions.revokeAllExcept(userId, exceptSessionId, reason),
        ),
      revokeAllSystem: (exceptSessionId, reason) =>
        writeResilient(
          (m) => m.sessions.revokeAllSystem(exceptSessionId, reason),
          null,
          () => localRepos.sessions.revokeAllSystem(exceptSessionId, reason),
        ),
    },
    ping: async () => {
      if (isMongoLive() && mongoRepos) {
        const ok = await mongoRepos.ping().catch(() => false);
        if (ok) return true;
      }
      return localRepos.ping();
    },
    healthStats: async (): Promise<DbHealthStats> => {
      if (isMongoLive() && mongoRepos) {
        const st = await mongoRepos.healthStats();
        if (st.ok) return st;
      }
      return localRepos.healthStats();
    },
    close: async () => {
      await Promise.allSettled([mongoRepos?.close(), localRepos.close()]);
    },
  };

  boot.repos = proxyRepos;

  const triggerSyncOnReconnect = (onReady?: (repos: Repositories) => Promise<void>): void => {
    if (!isMongoLive() || !mongoRepos || syncInFlight || stopped) return;
    const targetMongo = mongoRepos;
    syncInFlight = (async () => {
      try {
        boot.dbState = 'connected';
        boot.fallbackReason = null;
        boot.lastError = null;
        if (onReady) {
          await onReady(targetMongo);
        }
        const summary = await syncBidirectionalWithAtlas(targetMongo, localRepos);
        console.log(
          `[db-sync] Đồng bộ 2 chiều hoàn tất: đẩy lên=${summary.pushed}, nạp ấm=${summary.hydratedUsers} tài khoản & ${summary.hydratedReports} hồ sơ.`,
        );
      } catch (err) {
        console.error('[db-sync] Lỗi đồng bộ 2 chiều sau khi kết nối:', err);
      } finally {
        syncInFlight = null;
      }
    })();
  };

  const unsubscribeReconnect = onMongoReadyOrReconnected(() => {
    triggerSyncOnReconnect();
  });

  const startBackgroundConnect = async (onReady?: (repos: Repositories) => Promise<void>): Promise<void> => {
    if (!uri) {
      console.warn(
        `[db] Chưa cấu hình MONGODB_URI — vận hành ổn định trên Local Persistent Store (${localRepos.engine}).`,
      );
      boot.dbState = 'local_standby';
      return;
    }

    const attemptMongoConnect = async (bootRetries: number): Promise<boolean> => {
      try {
        const connectedMongo = await createMongoRepositories(uri, {
          bootRetries,
          retryBaseDelayMs: options?.retryBaseDelayMs,
        });
        if (stopped) {
          await connectedMongo.close();
          return false;
        }
        mongoRepos = connectedMongo;
        boot.dbState = 'connected';
        boot.fallbackReason = null;
        boot.lastError = null;
        if (onReady) {
          await onReady(connectedMongo);
        }
        const syncRes = await syncBidirectionalWithAtlas(connectedMongo, localRepos);
        console.log(
          `[db] Đã kết nối MongoDB Atlas & đồng bộ 2 chiều sẵn sàng (pushed=${syncRes.pushed}, users=${syncRes.hydratedUsers}, reports=${syncRes.hydratedReports})!`,
        );
        return true;
      } catch (err) {
        const diag = diagnoseMongoError(err);
        boot.lastError = `[${diag.category} - ${diag.errorName}] ${diag.message}`;
        return false;
      }
    };

    // Pha 1: Thử kết nối ngay ở hậu cảnh (không chặn HTTP, mọi request trong lúc này đã được phục vụ bởi localRepos)
    const ok = await attemptMongoConnect(options?.bootRetries ?? 3);
    if (ok || stopped) return;

    boot.dbState = 'reconnecting';
    boot.fallbackReason = `Đang phục vụ tức thì từ bộ đệm bền vững cục bộ (${localRepos.engine}) trong khi tự động kết nối lại đám mây.`;
    console.warn(
      `[db] Chưa kết nối được MongoDB Atlas ở lượt khởi động đầu (${boot.lastError}). ` +
        `Hệ thống vẫn hoạt động 100% qua Local Persistence (${localRepos.engine}) và tự động thử kết nối lại nền...`,
    );

    // Pha 2: Worker nền tự động kết nối lại và đồng bộ 2 chiều ngay khi MongoDB Atlas mở lại
    let bgAttempt = 0;
    const scheduleNextProbe = (): void => {
      if (stopped || isMongoLive()) return;
      bgAttempt += 1;
      const delayMs = Math.min(30_000, 10_000 * Math.min(3, bgAttempt));
      bgTimer = setTimeout(() => {
        bgTimer = null;
        if (stopped || isMongoLive()) return;
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
    localRepos,
    startBackgroundConnect,
    stop: async () => {
      stopped = true;
      unsubscribeReconnect();
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
