import dotenv from 'dotenv';
import mongoose, { type ConnectOptions } from 'mongoose';
import { Incident, SpamLog, User } from '../models';

dotenv.config();

export interface ConnectDbOptions {
  /** Chuỗi kết nối MongoDB Atlas; mặc định đọc từ process.env.MONGODB_URI */
  uri?: string;
  /** Số lần tự động kết nối lại tối đa khi mất kết nối bất ngờ (mặc định 10) */
  maxReconnectAttempts?: number;
  /** Tự động gọi createIndexes() cho toàn bộ collections sau khi kết nối (mặc định true) */
  ensureIndexes?: boolean;
}

/**
 * Cấu hình Connection Pool tối ưu cho môi trường SmartCitizen Đồng Nai:
 * - Deployment: Single long-running Node.js server trên Render Free (512MB RAM) kết nối MongoDB Atlas M0/M2.
 * - Workload: OLTP hỗn hợp (nhiều đọc bản đồ/dashboard + ghi đột biến khi người dân đồng bộ hàng loạt sau bão/mưa).
 */
export function buildMongoConnectOptions(): ConnectOptions {
  return {
    // 10 kết nối (~10MB RAM trên Atlas) đủ chịu tải burst OLTP mà không làm cạn giới hạn connection của Atlas M0/Render 512MB
    maxPoolSize: 10,
    // Giữ 2 kết nối ấm để giảm độ trễ bắt tay TLS/auth cho các request đột xuất
    minPoolSize: 2,
    // Thu hồi kết nối nhàn rỗi sau 60s để tiết kiệm tài nguyên trên Atlas và tránh bị firewall mạng cắt ngầm
    maxIdleTimeMS: 60_000,
    // Giới hạn chờ chọn Primary replica set trong 8s để fail-fast nếu sai IP whitelist / DNS
    serverSelectionTimeoutMS: 8_000,
    // Giới hạn bắt tay TCP + TLS tới Atlas Singapore
    connectTimeoutMS: 10_000,
    // Ngăn socket treo vô thời hạn cho truy vấn OLTP thông thường
    socketTimeoutMS: 30_000,
    retryWrites: true,
    retryReads: true,
    // Tắt autoIndex ngầm để kiểm soát rõ ràng bằng ensureDatabaseIndexes() -> createIndexes()
    autoIndex: false,
  };
}

let listenersAttached = false;
let manualDisconnect = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
let activeUri = '';
let maxAttempts = 10;

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  if (manualDisconnect || !activeUri || reconnectTimer) return;
  if (reconnectAttempts >= maxAttempts) {
    console.error(`[mongodb] Đã vượt quá ${maxAttempts} lần thử kết nối lại. Vui lòng kiểm tra MONGODB_URI / Atlas Network Access.`);
    return;
  }
  reconnectAttempts += 1;
  // Exponential Backoff (2s -> 4s -> 8s ... tối đa 30s) + Jitter tránh bão kết nối
  const delayMs = Math.min(30_000, 2_000 * 2 ** (reconnectAttempts - 1)) + Math.floor(Math.random() * 500);
  console.warn(`[mongodb] Mất kết nối. Tự động kết nối lại lần ${reconnectAttempts}/${maxAttempts} sau ${delayMs}ms...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (manualDisconnect || mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) return;
    mongoose
      .connect(activeUri, buildMongoConnectOptions())
      .then(() => {
        reconnectAttempts = 0;
        console.log('[mongodb] Kết nối lại MongoDB Atlas thành công.');
      })
      .catch((err) => {
        console.error(`[mongodb] Lỗi kết nối lại: ${err instanceof Error ? err.message : String(err)}`);
        scheduleReconnect();
      });
  }, delayMs);
}

function attachConnectionListeners(): void {
  if (listenersAttached) return;
  listenersAttached = true;

  mongoose.connection.on('connected', () => {
    reconnectAttempts = 0;
    clearReconnectTimer();
    console.log(`[mongodb] Đã kết nối tới MongoDB (${mongoose.connection.name || 'default'}).`);
  });

  mongoose.connection.on('reconnected', () => {
    reconnectAttempts = 0;
    clearReconnectTimer();
    console.log('[mongodb] Phiên kết nối MongoDB đã được khôi phục.');
  });

  mongoose.connection.on('error', (err) => {
    console.error(`[mongodb] Lỗi kết nối: ${err instanceof Error ? err.message : String(err)}`);
  });

  mongoose.connection.on('disconnected', () => {
    if (!manualDisconnect) {
      scheduleReconnect();
    }
  });
}

/** Khởi tạo toàn bộ indexes bắt buộc (2dsphere, compound IOC, dHash, unique sparse clientOfflineId, TTL 30 ngày). */
export async function ensureDatabaseIndexes(): Promise<void> {
  await Promise.all([
    User.createIndexes(),
    Incident.createIndexes(),
    SpamLog.createIndexes(),
  ]);
  console.log('[mongodb] Đã đồng bộ createIndexes() cho users, incidents và spam_logs.');
}

/**
 * Kết nối MongoDB Atlas qua biến môi trường `MONGODB_URI`, hỗ trợ auto-reconnect và gọi `createIndexes()`.
 */
export async function connectMongoDB(options: ConnectDbOptions = {}): Promise<typeof mongoose> {
  const uri = (options.uri ?? process.env.MONGODB_URI ?? '').trim();
  if (!uri) {
    throw new Error('Thiếu biến môi trường MONGODB_URI. Hãy cấu hình chuỗi kết nối MongoDB Atlas trong backend/.env.');
  }

  activeUri = uri;
  maxAttempts = options.maxReconnectAttempts ?? 10;
  manualDisconnect = false;
  attachConnectionListeners();

  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(uri, buildMongoConnectOptions());
  }

  if (options.ensureIndexes !== false) {
    await ensureDatabaseIndexes();
  }

  return mongoose;
}

/** Ngắt kết nối gọn gàng (tắt auto-reconnect) khi tắt server hoặc kết thúc script seed. */
export async function disconnectMongoDB(): Promise<void> {
  manualDisconnect = true;
  clearReconnectTimer();
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

export function getMongoStatus(): { readyState: number; connected: boolean; dbName: string } {
  return {
    readyState: mongoose.connection.readyState,
    connected: mongoose.connection.readyState === 1,
    dbName: mongoose.connection.name || '',
  };
}
