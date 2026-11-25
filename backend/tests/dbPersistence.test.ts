import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildMongoConnectOptions,
  connectDatabase,
  disconnectDatabase,
  getDatabaseHealth,
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
import { createRepositories, incidentRepository } from '../src/repositories';
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
  it('cấu hình Connection Pool chuẩn Production và chặn đứng fallback sang RAM/JSON khi có MONGODB_URI', async () => {
    const opts = buildMongoConnectOptions();
    expect(opts.maxPoolSize).toBe(20);
    expect(opts.minPoolSize).toBe(5);
    expect(opts.serverSelectionTimeoutMS).toBe(5_000);
    expect(opts.socketTimeoutMS).toBe(45_000);
    expect(opts.retryWrites).toBe(true);
    expect(opts.w).toBe('majority');

    // Khi truyền MONGODB_URI không kết nối được -> bắt buộc throw lỗi, KHÔNG fallback sang json mode
    await expect(
      createRepositories('mongodb://127.0.0.1:1/unreachable_db?serverSelectionTimeoutMS=400'),
    ).rejects.toThrow();
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

  it('migrateIndexes + seed nạp đúng 95 xã/phường (23 phường, 72 xã NQ 1662), 64 sự cố P. Trấn Biên & 1 Super Admin hoàn toàn idempotent', async () => {
    const migrated = await migrateDatabaseIndexes({ uri: mongoUri });
    expect(migrated.length).toBeGreaterThanOrEqual(10);

    const run1 = await runProductionSeed({ uri: mongoUri });
    expect(run1.wardsTotal).toBe(95);
    expect(run1.wardsPhuongNq1662).toBe(23);
    expect(run1.wardsXaNq1662).toBe(72);
    expect(run1.tranBienPilotTotal).toBe(64);
    expect(run1.tranBienInsertedNew).toBe(64);
    expect(run1.superAdminCreated).toBe(true);

    // Chạy lại lần 2 -> không sinh thêm bản ghi trùng lặp và không tạo lại Super Admin
    const run2 = await runProductionSeed({ uri: mongoUri });
    expect(run2.wardsTotal).toBe(95);
    expect(run2.tranBienPilotTotal).toBe(64);
    expect(run2.tranBienInsertedNew).toBe(0);
    expect(run2.superAdminCreated).toBe(false);

    // Kết nối lại kiểm tra truy vấn thực tế trên 64 sự cố thí điểm Trấn Biên
    await connectDatabase({ uri: mongoUri, ensureIndexes: false });
    const health = await getDatabaseHealth();
    expect(health.ok).toBe(true);
    expect(health.state).toBe('connected');
    expect(health.latencyMs).not.toBeNull();
    expect(health.totalIncidents).toBe(64);
    expect(health.totalUsers).toBeGreaterThanOrEqual(1);

    // Kiểm tra sự cố danh mục OTHER có customCategoryLabel, aiEvaluation và imageFingerprints
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
    const admin = await User.findOne({ role: 'super_admin' }).lean();
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
