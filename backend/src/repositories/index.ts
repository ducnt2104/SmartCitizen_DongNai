import { env } from '../config/env';
import { createJsonRepositories } from './jsonRepositories';
import { createMongoRepositories } from './mongoRepositories';
import type { Repositories } from './types';

export interface RepositoryBootInfo {
  repos: Repositories;
  /** Lý do dùng JSON thay vì MongoDB (nếu có) */
  fallbackReason: string | null;
}

/** Dual-Mode: MongoDB khi có MONGODB_URI & kết nối được, ngược lại Local JSON Store. */
export async function createRepositories(): Promise<RepositoryBootInfo> {
  if (env.mongoUri) {
    try {
      const repos = await createMongoRepositories(env.mongoUri);
      return { repos, fallbackReason: null };
    } catch (err) {
      const reason = `Không kết nối được MongoDB (${err instanceof Error ? err.message : String(err)})`;
      console.error(`[db] ${reason} — chuyển sang Local JSON Store.`);
      return { repos: createJsonRepositories(env.dataDir), fallbackReason: reason };
    }
  }
  return { repos: createJsonRepositories(env.dataDir), fallbackReason: 'MONGODB_URI chưa cấu hình — dùng Local JSON Store.' };
}

export type { Repositories } from './types';
