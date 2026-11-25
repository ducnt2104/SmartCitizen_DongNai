import { env } from '../config/env';
import { createJsonRepositories } from './jsonRepositories';
import { createMongoRepositories } from './mongoRepositories';
import type { Repositories } from './types';

export interface RepositoryBootInfo {
  repos: Repositories;
  /** Lý do dùng JSON thay vì MongoDB (chỉ khi chưa khai báo MONGODB_URI hoặc bật ALLOW_JSON_FALLBACK=true) */
  fallbackReason: string | null;
}

/**
 * Khởi tạo tầng lưu trữ dữ liệu bền vững:
 * - Khi `MONGODB_URI` được cấu hình: BẮT BUỘC kết nối thật tới MongoDB Atlas (retry 3 lần).
 *   Tuyệt đối KHÔNG âm thầm rơi về mock/RAM giả nếu `ALLOW_JSON_FALLBACK` không bật tường minh!
 * - Khi `MONGODB_URI` để trống (dev/test cục bộ không có MongoDB): dùng Local Persistent JSON Store trên đĩa.
 */
export async function createRepositories(): Promise<RepositoryBootInfo> {
  if (env.mongoUri) {
    try {
      const repos = await createMongoRepositories(env.mongoUri);
      return { repos, fallbackReason: null };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (!env.allowJsonFallback) {
        throw new Error(
          `[db] FATAL: Đã cấu hình MONGODB_URI nhưng kết nối MongoDB Atlas thất bại sau 3 lần thử (${detail}). ` +
            'Hãy kiểm tra lại Network Access (IP Whitelist 0.0.0.0/0), tài khoản/mật khẩu DB user trên Atlas, hoặc đặt ALLOW_JSON_FALLBACK=true nếu muốn chạy tạm JSON Store.',
        );
      }
      const reason = `Không kết nối được MongoDB (${detail}) — ALLOW_JSON_FALLBACK=true nên chuyển sang Local JSON Store.`;
      console.error(`[db] ${reason}`);
      return { repos: createJsonRepositories(env.dataDir), fallbackReason: reason };
    }
  }
  return {
    repos: createJsonRepositories(env.dataDir),
    fallbackReason: 'MONGODB_URI chưa cấu hình — dùng Local Persistent JSON Store.',
  };
}

export type { Repositories } from './types';
