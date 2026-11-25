import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildMongoConnectOptions,
  connectDatabase,
  diagnoseMongoError,
  disconnectDatabase,
  getDatabaseHealth,
  maskMongoUri,
} from '../src/config/database';
import {
  AI_CACHE_TTL_SECONDS,
  aiCacheSchema,
  AUDIT_LOG_TTL_SECONDS,
  Incident,
  incidentSchema,
  operationalAuditLogSchema,
  OTP_TOKEN_GRACE_TTL_SECONDS,
  otpTokenSchema,
  User,
  Ward,
} from '../src/models';
import { createNonBlockingServerRepositories, createRepositories, incidentRepository } from '../src/repositories';
import { migrateDatabaseIndexes } from '../src/scripts/migrateIndexes';
import { runProductionSeed } from '../src/scripts/seed';
import { verifyDatabaseEndToEnd } from '../src/scripts/verifyDb';

let mongod: MongoMemoryServer;
let mongoUri = '';

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  mongoUri = mongod.getUri('smartcitizen_persistence_test');
}, 60_000);

afterAll(async () => {
  await disconnectDatabase();
  if (mongod) {
    await mongod.stop();
  }
});

describe('MongoDB Production Persistence Upgrade (Real mongod Wire Protocol)', () => {
  it('cấu hình Connection Pool chuẩn Cloud (Render -> Atlas IPv4) và kiểm soát retry / fallback an toàn', async () => {
    const opts = buildMongoConnectOptions();
    expect(opts.maxPoolSize).toBe(20);
    expect(opts.minPoolSize).toBe(5);
    expect(opts.serverSelectionTimeoutMS).toBe(10_000);
    expect(opts.connectTimeoutMS).toBe(10_000);
    expect(opts.socketTimeoutMS).toBe(45_000);
    expect(opts.family).toBe(4);
    expect(opts.retryWrites).toBe(true);
    expect(opts.w).toBe('majority');

    // Che giấu mật khẩu tuyệt đối trong log chẩn đoán
    const masked = maskMongoUri('mongodb+srv://dongnai_admin:SuperSecretPass!2026@cluster0.xyz.mongodb.net/smartcitizen_dongnai?retryWrites=true');
    expect(masked.maskedUri).not.toContain('SuperSecretPass!2026');
    expect(masked.maskedUri).toContain('***:***@cluster0.xyz.mongodb.net');
    expect(masked.host).toBe('cluster0.xyz.mongodb.net');
    expect(masked.dbName).toBe('smartcitizen_dongnai');

    const authDiag = diagnoseMongoError(Object.assign(new Error('bad auth : Authentication failed.'), { code: 8000 }));
    expect(authDiag.category).toBe('AUTH_FAILED');

    // Khi ALLOW_JSON_FALLBACK=false: thử lại có giới hạn rồi ném lỗi chẩn đoán tường minh
    await expect(
      createRepositories('mongodb://127.0.0.1:1/unreachable_db?serverSelectionTimeoutMS=250', {
        bootRetries: 2,
        retryBaseDelayMs: 60,
        allowJsonFallback: false,
      }),
    ).rejects.toThrow(/FATAL/);

    // Khi bật ALLOW_JSON_FALLBACK=true: chuyển mượt sang Local JSON Store mà không làm sập server
    const fallbackBoot = await createRepositories(
      'mongodb://127.0.0.1:1/unreachable_db?serverSelectionTimeoutMS=250',
      { bootRetries: 1, retryBaseDelayMs: 50, allowJsonFallback: true },
    );
    expect(fallbackBoot.repos.mode).toBe('json');
    expect(fallbackBoot.dbState).toBe('fallback_json');
    await fallbackBoot.repos.close();

    // Non-blocking startup proxy: trả 503 có kiểm soát khi đang kết nối mà không throw crash tiến trình
    const prevUri = process.env.MONGODB_URI;
    process.env.MONGODB_URI = '';
    const nb = createNonBlockingServerRepositories({ allowJsonFallback: true });
    expect(nb.boot.repos.mode).toBe('json');
    await nb.stop();
    process.env.MONGODB_URI = prevUri;
  });

  it('đăng ký đầy đủ Compound Indexes IOC, 2dsphere, syncId unique sparse và TTL Indexes chống tràn 512MB M0', () => {
    const incIdx = incidentSchema.indexes();
    const hasIncIdx = (keys: Record<string, unknown>, check?: (o: Record<string, unknown>) => boolean) =>
      incIdx.some(([k, o]) => JSON.stringify(k) === JSON.stringify(keys) && (!check || check(o as Record<string, unknown>)));

    expect(hasIncIdx({ location: '2dsphere' })).toBe(true);
    expect(hasIncIdx({ wardCode: 1, status: 1, createdAt: -1 })).toBe(true);
    expect(hasIncIdx({ category: 1, priorityScore: -1, createdAt: -1 })).toBe(true);
    expect(hasIncIdx({ reporterId: 1, createdAt: -1 })).toBe(true);
    expect(hasIncIdx({ syncId: 1 }, (o) => o.unique === true && o.sparse === true)).toBe(true);

    expect(
      otpTokenSchema.indexes().some(
        ([k, o]) => JSON.stringify(k) === JSON.stringify({ expiresAt: 1 }) && o.expireAfterSeconds === OTP_TOKEN_GRACE_TTL_SECONDS,
      ),
    ).toBe(true);
    expect(
      aiCacheSchema.indexes().some(
        ([k, o]) => JSON.stringify(k) === JSON.stringify({ expiresAt: 1 }) && o.expireAfterSeconds === 0,
      ),
    ).toBe(true);
    expect(AI_CACHE_TTL_SECONDS).toBe(7 * 24 * 3600);
    expect(
      operationalAuditLogSchema.indexes().some(
        ([k, o]) => JSON.stringify(k) === JSON.stringify({ createdAt: 1 }) && o.expireAfterSeconds === AUDIT_LOG_TTL_SECONDS,
      ),
    ).toBe(true);
  });

  it('migrateIndexes + seed mặc định KHÔNG bơm sự cố giả (AUTO_SEED_DEMO_REPORTS=false), chỉ giữ 95 Phường/Xã + 1 ADMIN idempotent', async () => {
    const migrated = await migrateDatabaseIndexes({ uri: mongoUri });
    expect(migrated.length).toBeGreaterThanOrEqual(10);

    // Mặc định Production: 0 sự cố mẫu, đủ 95 ĐVHC và 1 tài khoản ADMIN
    const cleanRun = await runProductionSeed({ uri: mongoUri });
    expect(cleanRun.wardsTotal).toBe(95);
    expect(cleanRun.wardsPhuongNq1662).toBe(23);
    expect(cleanRun.wardsXaNq1662).toBe(72);
    expect(cleanRun.tranBienPilotTotal).toBe(0);
    expect(cleanRun.tranBienInsertedNew).toBe(0);
    expect(cleanRun.superAdminCreated).toBe(true);

    // Khi bật tường minh includeDemo: true -> nạp idempotent 64 bản ghi phục vụ kiểm thử không gian/chỉ mục
    const run1 = await runProductionSeed({ uri: mongoUri, includeDemo: true });
    expect(run1.wardsTotal).toBe(95);
    expect(run1.tranBienPilotTotal).toBe(64);
    expect(run1.tranBienInsertedNew).toBe(64);
    expect(run1.superAdminCreated).toBe(false);

    // Chạy lại lần nữa -> không sinh thêm bản ghi trùng lặp
    const run2 = await runProductionSeed({ uri: mongoUri, includeDemo: true });
    expect(run2.wardsTotal).toBe(95);
    expect(run2.tranBienPilotTotal).toBe(64);
    expect(run2.tranBienInsertedNew).toBe(0);
    expect(run2.superAdminCreated).toBe(false);

    await connectDatabase({ uri: mongoUri, ensureIndexes: false });
    const health = await getDatabaseHealth();
    expect(health.ok).toBe(true);
    expect(health.state).toBe('connected');
    expect(health.latencyMs).not.toBeNull();
    expect(health.totalIncidents).toBe(64);
    expect(health.totalUsers).toBeGreaterThanOrEqual(1);

    const otherIncidents = await incidentRepository.listForIocDashboard({
      wardCode: 'DN-TB',
      category: 'OTHER',
      limit: 20,
    });
    expect(otherIncidents.length).toBeGreaterThan(0);
    expect(otherIncidents[0].customCategoryLabel).toBeTruthy();
    expect(otherIncidents[0].aiEvaluation.authenticityScore).toBeGreaterThanOrEqual(80);
    expect(otherIncidents[0].imageFingerprints.length).toBeGreaterThan(0);

    // Kiểm tra song song 8 request Outbox cùng syncId -> chỉ đúng 1 bản ghi được tạo (Idempotent Write)
    const admin = await User.findOne({ role: 'admin' }).lean();
    expect(admin).toBeTruthy();
    const burstSyncId = 'outbox-concurrent-burst-001';
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        incidentRepository.upsertBySyncId({
          syncId: burstSyncId,
          reporterId: admin!._id,
          wardCode: 'DN-TB',
          category: 'OTHER',
          customCategoryLabel: 'Thử nghiệm đồng bộ mạng chập chờn',
          title: 'Sự cố gửi trùng 8 lần từ hàng đợi Outbox',
          description: 'Đảm bảo MongoDB chỉ lưu đúng 1 bản ghi duy nhất.',
          location: {
            type: 'Point',
            coordinates: [106.8251, 10.9472],
          },
        }),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => String(r.incident._id))).size).toBe(1);
    expect(await Incident.countDocuments({ syncId: burstSyncId })).toBe(1);
    expect(await Ward.countDocuments()).toBe(95);

    await Incident.deleteOne({ syncId: burstSyncId });
    await disconnectDatabase();
  }, 60_000);

  it('verifyDatabaseEndToEnd chạy trọn vẹn: ping -> write -> $nearSphere (2dsphere IXSCAN) -> delete -> 0 lỗi', async () => {
    const report = await verifyDatabaseEndToEnd({ uri: mongoUri });
    expect(report.health.ok).toBe(true);
    expect(report.idempotentDuplicatePrevented).toBe(true);
    expect(report.nearSphereMatchedCount).toBeGreaterThanOrEqual(1);
    expect(report.used2dsphereIndex).toBe(true);
    expect(report.cleanedUp).toBe(true);
  }, 30_000);
});
