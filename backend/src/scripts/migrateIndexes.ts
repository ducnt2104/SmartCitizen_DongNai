import dotenv from 'dotenv';
import path from 'node:path';
import {
  connectDatabase,
  disconnectDatabase,
  ensureDatabaseIndexes,
  type IndexSyncSummary,
} from '../config/database';
import {
  AiCache,
  AuditLog,
  AuditLogModel,
  Incident,
  MediaAsset,
  OtpModel,
  OtpToken,
  ReportModel,
  SessionModel,
  SpamLog,
  User,
  UserModel,
  Ward,
} from '../models';

// Nạp biến môi trường từ cả backend/.env và ../.env (root workspace)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const MANAGED_MODELS = [
  Ward,
  User,
  Incident,
  SpamLog,
  OtpToken,
  AiCache,
  AuditLog,
  ReportModel,
  UserModel,
  OtpModel,
  SessionModel,
  AuditLogModel,
] as const;

export interface MigrateIndexesOptions {
  uri?: string;
  /** Dùng syncIndexes() để tự động dọn luôn các index thừa lỗi thời (mặc định true) */
  dropObsolete?: boolean;
  /** Khởi chạy mongod thực nghiệm cục bộ (MongoMemoryServer) khi truyền --ephemeral và chưa có MONGODB_URI */
  ephemeral?: boolean;
}

/**
 * Đồng bộ toàn bộ Indexes (GeoJSON 2dsphere, Compound IOC, Unique Sparse syncId, TTL dọn rác)
 * hoàn toàn Idempotent — chạy lại nhiều lần không lỗi và đảm bảo schema khớp tuyệt đối trên Atlas.
 */
export async function migrateDatabaseIndexes(
  options: MigrateIndexesOptions = {},
): Promise<IndexSyncSummary[]> {
  let memoryServer: { stop: () => Promise<unknown> } | null = null;
  let targetUri = (options.uri ?? process.env.MONGODB_URI ?? '').trim();

  if (!targetUri && options.ephemeral) {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const mongod = await MongoMemoryServer.create();
    memoryServer = mongod;
    targetUri = mongod.getUri('smartcitizen_dongnai');
    console.log('[db:migrate-indexes] Chế độ --ephemeral: đã khởi chạy mongod thực nghiệm cục bộ.');
  }

  await connectDatabase({ uri: targetUri, ensureIndexes: false });

  try {
    const dropObsolete = options.dropObsolete !== false;
    const summaries: IndexSyncSummary[] = [];

    for (const m of MANAGED_MODELS) {
      if (dropObsolete) {
        const dropped = await m.syncIndexes();
        if (dropped.length > 0) {
          console.log(`[db:migrate-indexes] ${m.collection.collectionName}: đã gỡ ${dropped.length} index lỗi thời (${dropped.join(', ')}).`);
        }
      } else {
        await m.createIndexes();
      }

      const rawIndexes = await m.collection.indexes();
      summaries.push({
        modelName: m.modelName,
        collectionName: m.collection.collectionName,
        indexCount: rawIndexes.length,
        indexes: rawIndexes.map((idx: Record<string, unknown>) => {
          const ttl = typeof idx.expireAfterSeconds === 'number' ? ` [TTL=${idx.expireAfterSeconds}s]` : '';
          const uniq = idx.unique ? ' [UNIQUE]' : '';
          const sparse = idx.sparse ? ' [SPARSE]' : '';
          return `${String(idx.name)}${uniq}${sparse}${ttl}`;
        }),
      });
    }

    for (const s of summaries) {
      console.log(`  - ${s.collectionName.padEnd(16, ' ')} (${String(s.indexCount).padStart(2, ' ')} indexes): ${s.indexes.join(', ')}`);
    }

    return summaries;
  } finally {
    await disconnectDatabase();
    if (memoryServer) {
      await memoryServer.stop();
    }
  }
}

export { ensureDatabaseIndexes };

if (require.main === module) {
  const ephemeral = process.argv.includes('--ephemeral');
  const keepObsolete = process.argv.includes('--no-drop');
  migrateDatabaseIndexes({ ephemeral, dropObsolete: !keepObsolete })
    .then((res) => {
      console.log(`[db:migrate-indexes] Hoàn tất đồng bộ ${res.reduce((acc, s) => acc + s.indexCount, 0)} indexes trên ${res.length} collections.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[db:migrate-indexes] Thất bại:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
