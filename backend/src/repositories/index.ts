import { env } from '../config/env';
import { createJsonRepositories } from './jsonRepositories';
import { createMongoRepositories } from './mongoRepositories';
import type { Repositories } from './types';

export interface RepositoryBootInfo {
  repos: Repositories;
  /** Lý do dùng JSON thay vì MongoDB (chỉ khi chạy dev/test cục bộ không khai báo MONGODB_URI) */
  fallbackReason: string | null;
}

/**
 * Khởi tạo tầng lưu trữ chuẩn Production:
 * - Khi có `MONGODB_URI`: kết nối trực tiếp tới MongoDB Atlas. TUYỆT ĐỐI KHÔNG bắt lỗi rồi fallback
 *   sang mảng RAM/JSON giả lập — đảm bảo fail-loud nếu cấu hình DB sai và chống mất dữ liệu âm thầm.
 * - Khi `NODE_ENV === 'production'`: bắt buộc phải có `MONGODB_URI`.
 * - Chỉ cho phép Local JSON Store ở môi trường `development` / `test` khi chưa đặt `MONGODB_URI`.
 */
export async function createRepositories(customMongoUri?: string): Promise<RepositoryBootInfo> {
  const uri = (customMongoUri ?? env.mongoUri ?? '').trim();

  if (uri) {
    const repos = await createMongoRepositories(uri);
    return { repos, fallbackReason: null };
  }

  if (env.isProd) {
    throw new Error(
      '[db] Môi trường production bắt buộc phải khai báo MONGODB_URI (MongoDB Atlas). Không cho phép fallback sang Local JSON/RAM Store.',
    );
  }

  return {
    repos: createJsonRepositories(env.dataDir),
    fallbackReason: 'MONGODB_URI chưa cấu hình (dev/test) — dùng Local JSON Store.',
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
