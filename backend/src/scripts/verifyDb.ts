import crypto from 'node:crypto';
import dotenv from 'dotenv';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  connectDatabase,
  disconnectDatabase,
  getDatabaseHealth,
  type DatabaseHealth,
} from '../config/database';
import { Incident, User } from '../models';
import { incidentRepository } from '../repositories/incidentRepository';

// Nạp biến môi trường từ cả backend/.env và ../.env (bỏ qua khi chạy Vitest để cô lập unit test)
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
  dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
}

export interface VerifyDbReport {
  connectionTarget: 'atlas_uri' | 'ephemeral_mongod';
  health: DatabaseHealth;
  idempotentDuplicatePrevented: boolean;
  nearSphereLatencyMs: number;
  nearSphereMatchedCount: number;
  used2dsphereIndex: boolean;
  cleanedUp: boolean;
}

/**
 * Script kiểm chứng toàn diện tầng Database (`npm run db:verify`):
 * 1) Kết nối thật (tới MONGODB_URI trên Atlas nếu đã cấu hình, hoặc mongod thực nghiệm cục bộ khi chạy CI/dev chưa có .env)
 * 2) Ping `db.admin().ping()` qua `getDatabaseHealth()`
 * 3) Ghi 1 bản ghi test `Incident` + thử gửi lặp cùng `syncId` xác minh Idempotent Write
 * 4) Truy vấn không gian `$nearSphere` đo tốc độ thực tế & xác nhận dùng `2dsphere` index (`IXSCAN`)
 * 5) Xóa sạch bản ghi test và xác nhận 0 lỗi
 */
export async function verifyDatabaseEndToEnd(
  options: { uri?: string; requireEnvUri?: boolean } = {},
): Promise<VerifyDbReport> {
  let memoryServer: { stop: () => Promise<unknown> } | null = null;
  let targetUri = (options.uri ?? process.env.MONGODB_URI ?? '').trim();
  let connectionTarget: 'atlas_uri' | 'ephemeral_mongod' = 'atlas_uri';

  if (!targetUri) {
    if (options.requireEnvUri) {
      throw new Error('Thiếu biến môi trường MONGODB_URI khi chạy với cờ --require-env.');
    }
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const mongod = await MongoMemoryServer.create();
    memoryServer = mongod;
    targetUri = mongod.getUri('smartcitizen_dongnai_verify');
    connectionTarget = 'ephemeral_mongod';
    console.log(
      '[db:verify] Chưa khai báo MONGODB_URI trong .env -> khởi chạy nhị phân mongod thực nghiệm cục bộ (MongoMemoryServer) để kiểm chứng.',
    );
  } else {
    console.log('[db:verify] Đang kết nối trực tiếp tới cụm MongoDB qua MONGODB_URI...');
  }

  let testIncidentId: string | null = null;
  let testUserId: string | null = null;

  await connectDatabase({ uri: targetUri, ensureIndexes: true });

  try {
    // Bước 1 & 2: Ping + Kiểm tra sức khỏe DB
    const health = await getDatabaseHealth();
    if (!health.ok || health.state !== 'connected' || health.latencyMs === null) {
      throw new Error(`getDatabaseHealth() không đạt: ${JSON.stringify(health)}`);
    }
    console.log(
      `[db:verify] 1/4 Ping OK -> state=${health.state}, latency=${health.latencyMs}ms, collections=${health.collectionsCount}, incidents=${health.totalIncidents}, users=${health.totalUsers}`,
    );

    // Tạo user tạm phục vụ khóa ngoại reporterId rồi dọn sạch ở cuối
    const uniqueSuffix = String(Math.floor(100000 + Math.random() * 899999));
    const tempUser = await User.create({
      phoneNumber: `0999${uniqueSuffix}`,
      fullName: 'Tài khoản Kiểm thử DB Verify',
      role: 'citizen',
      clientOfflineId: `verify-user-${crypto.randomUUID()}`,
    });
    testUserId = String(tempUser._id);

    // Bước 3: Ghi 1 bản ghi test + kiểm tra Idempotent Write qua syncId
    const syncId = `verify-sync-${crypto.randomUUID()}`;
    const testCoords: [number, number] = [106.8243, 10.9465]; // Phường Trấn Biên

    const firstWrite = await incidentRepository.upsertBySyncId({
      syncId,
      reporterId: tempUser._id,
      wardCode: 'DN-TB',
      category: 'OTHER',
      customCategoryLabel: 'Kiểm thử kết nối & truy vấn 2dsphere',
      title: 'Bản ghi kiểm thử tự động db:verify (sẽ xóa ngay)',
      description: 'Kiểm chứng ghi thật, chống trùng syncId và truy vấn không gian $nearSphere.',
      location: {
        type: 'Point',
        coordinates: testCoords,
        addressText: 'Đường Nguyễn Ái Quốc, Phường Trấn Biên, TP. Đồng Nai',
        ward: 'Phường Trấn Biên',
        district: 'TP. Đồng Nai',
      },
      media: [
        {
          url: 'https://storage.smartcitizen-dongnai.vn/verify/probe.jpg',
          type: 'image',
          dHash: 'a1b2c3d4e5f60718',
          capturedAt: new Date(),
        },
      ],
      imageFingerprints: [
        {
          mediaUrl: 'https://storage.smartcitizen-dongnai.vn/verify/probe.jpg',
          pHash: 'a1b2c3d4e5f60718',
          dHash: 'a1b2c3d4e5f60718',
          algorithm: 'pHash-64',
          descriptorMetadata: { width: 800, height: 600, blurScore: 210.5 },
          computedAt: new Date(),
        },
      ],
      aiEvaluation: {
        authenticityScore: 98,
        isDuplicate: false,
        matchedIncidentId: null,
        sceneMatchScore: 95,
        resolutionScore: null,
      },
    });

    if (!firstWrite.created) {
      throw new Error('Lần ghi đầu tiên phải trả về created = true.');
    }
    testIncidentId = String(firstWrite.incident._id);

    // Gửi lặp lần 2 cùng syncId (mô phỏng Client Outbox retry khi rớt mạng)
    const secondWrite = await incidentRepository.upsertBySyncId({
      syncId,
      reporterId: tempUser._id,
      wardCode: 'DN-TB',
      category: 'OTHER',
      customCategoryLabel: 'Bản ghi retry trùng syncId',
      title: 'Bản ghi kiểm thử retry lần 2',
      description: 'Phải trả về đúng bản ghi đầu tiên mà không tạo thêm document thứ 2.',
      location: {
        type: 'Point',
        coordinates: testCoords,
        addressText: 'Đường Nguyễn Ái Quốc, Phường Trấn Biên, TP. Đồng Nai',
        ward: 'Phường Trấn Biên',
        district: 'TP. Đồng Nai',
      },
    });
    const countSameSync = await Incident.countDocuments({ syncId });
    const idempotentDuplicatePrevented = !secondWrite.created && countSameSync === 1;
    if (!idempotentDuplicatePrevented) {
      throw new Error(`Idempotent syncId thất bại: second.created=${secondWrite.created}, count=${countSameSync}`);
    }
    console.log(`[db:verify] 2/4 Ghi thật & Idempotent syncId OK -> _id=${testIncidentId}, count(syncId)=1`);

    // Bước 4: Truy vấn không gian $nearSphere trong bán kính 150m quanh điểm vừa ghi
    // Chạy 1 truy vấn làm ấm plan cache rồi đo độ trễ thực tế của $nearSphere
    await incidentRepository.findNearbySphere({
      lng: 106.8244,
      lat: 10.9466,
      radiusMeters: 150,
    });

    const t0 = performance.now();
    const nearby = await incidentRepository.findNearbySphere({
      lng: 106.8244,
      lat: 10.9466,
      radiusMeters: 150,
    });
    const nearSphereLatencyMs = Math.round((performance.now() - t0) * 100) / 100;

    const matched = nearby.some((doc) => String(doc._id) === testIncidentId);
    if (!matched) {
      throw new Error('Truy vấn $nearSphere không tìm thấy bản ghi test vừa ghi trong bán kính 150m.');
    }

    const explainPlan = await Incident.find({
      location: {
        $nearSphere: {
          $geometry: { type: 'Point', coordinates: [106.8244, 10.9466] },
          $maxDistance: 150,
        },
      },
    }).explain('queryPlanner');
    const planJson = JSON.stringify(explainPlan);
    const used2dsphereIndex = planJson.includes('IXSCAN') || planJson.includes('GEO_NEAR_2DSPHERE');
    console.log(
      `[db:verify] 3/4 Truy vấn $nearSphere OK -> latency=${nearSphereLatencyMs}ms, matched=${nearby.length}, used2dsphereIndex=${used2dsphereIndex}`,
    );

    // Bước 5: Xóa sạch bản ghi test & xác nhận không còn rác
    await Incident.deleteOne({ _id: firstWrite.incident._id });
    testIncidentId = null;
    await User.deleteOne({ _id: tempUser._id });
    testUserId = null;

    const verifyDeleted = await Incident.findOne({ syncId }).lean();
    if (verifyDeleted !== null) {
      throw new Error('Bản ghi test chưa được xóa sạch khỏi collection incidents.');
    }
    console.log('[db:verify] 4/4 Dọn sạch bản ghi test OK -> 0 lỗi.');

    return {
      connectionTarget,
      health,
      idempotentDuplicatePrevented,
      nearSphereLatencyMs,
      nearSphereMatchedCount: nearby.length,
      used2dsphereIndex,
      cleanedUp: true,
    };
  } finally {
    // Đảm bảo dọn rác kể cả khi giữa chừng có ngoại lệ
    if (testIncidentId) {
      await Incident.deleteOne({ _id: testIncidentId }).catch(() => undefined);
    }
    if (testUserId) {
      await User.deleteOne({ _id: testUserId }).catch(() => undefined);
    }
    await disconnectDatabase();
    if (memoryServer) {
      await memoryServer.stop();
    }
  }
}

if (require.main === module) {
  const requireEnvUri = process.argv.includes('--require-env');
  verifyDatabaseEndToEnd({ requireEnvUri })
    .then((report) => {
      console.log(`[db:verify] PASS HOÀN TẤT (${report.connectionTarget}) — 0 lỗi.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[db:verify] THẤT BẠI:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
