import { env } from '../config/env';
import { createJsonRepositories } from './jsonRepositories';
import { createMongoRepositories } from './mongoRepositories';
import type { Repositories } from './types';

export interface RepositoryBootInfo {
  repos: Repositories;
  /** Lý do dùng JSON thay vì MongoDB (chỉ khi chưa khai báo MONGODB_URI ở dev/test hoặc bật ALLOW_JSON_FALLBACK=true) */
  fallbackReason: string | null;
}

/**
 * Khởi tạo tầng lưu trữ chuẩn Production:
 * - Khi có `MONGODB_URI` (hoặc `customMongoUri`): kết nối trực tiếp tới MongoDB Atlas.
 *   TUYỆT ĐỐI KHÔNG âm thầm rơi về RAM/JSON giả lập nếu kết nối lỗi (trừ khi bật tường minh `ALLOW_JSON_FALLBACK=true` ở môi trường dev).
 * - Khi `NODE_ENV === 'production'`: bắt buộc phải có `MONGODB_URI`.
 * - Khi chưa đặt `MONGODB_URI` ở môi trường `development` / `test`: dùng Local Persistent JSON Store.
 */
export async function createRepositories(customMongoUri?: string): Promise<RepositoryBootInfo> {
  const uri = (customMongoUri ?? env.mongoUri ?? '').trim();

  if (uri) {
    try {
      const repos = await createMongoRepositories(uri);
      return { repos, fallbackReason: null };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (customMongoUri || env.isProd || !env.allowJsonFallback) {
        throw new Error(
          `[db] FATAL: Đã cấu hình MONGODB_URI nhưng kết nối MongoDB Atlas thất bại (${detail}). ` +
            'Hãy kiểm tra lại Network Access (IP Whitelist 0.0.0.0/0), tài khoản/mật khẩu DB user trên Atlas, hoặc đặt ALLOW_JSON_FALLBACK=true nếu muốn chạy tạm JSON Store.',
        );
      }
      const reason = `Không kết nối được MongoDB (${detail}) — ALLOW_JSON_FALLBACK=true nên chuyển sang Local JSON Store.`;
      console.error(`[db] ${reason}`);
      return { repos: createJsonRepositories(env.dataDir), fallbackReason: reason };
    }
  }

  if (env.isProd) {
    throw new Error(
      '[db] Môi trường production bắt buộc phải khai báo MONGODB_URI (MongoDB Atlas). Không cho phép fallback sang Local JSON/RAM Store.',
    );
  }

  return {
    repos: createJsonRepositories(env.dataDir),
    fallbackReason: 'MONGODB_URI chưa cấu hình (dev/test) — dùng Local Persistent JSON Store.',
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
