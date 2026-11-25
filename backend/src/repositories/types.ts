import type { AuditEntry, Notification, Report, ReportStatus, Role } from '../shared/types';
import type { OtpChannel } from '../services/otpDelivery.service';

export interface UserRecord {
  id: string;
  role: Role;
  name: string;
  phone: string | null;
  email: string | null;
  staffCode: string | null;
  passwordHash: string | null;
  wardCode: string | null;
  unitCode: string | null;
  defaultWardCode?: string | null;
  notificationsEnabled?: boolean;
  revoked?: boolean;
  trustScore: number;
  badges: string[];
  volunteerHours: number;
  points: number;
  notifications: Notification[];
  createdAt: string;
}

/** Bảng otp_challenges: lưu HMAC-SHA256 hash, thời hạn 5 phút, số lần sai & đánh dấu consumedAt chống replay. */
export interface OtpRecord {
  identifier: string;
  channel: OtpChannel;
  purpose: 'login' | 'reset_password';
  codeHash: string;
  expiresAt: number;
  resendAt: number;
  failedAttempts: number;
  lockedUntil: number;
  consumedAt: number | null;
}

/** Bảng sessions: quản lý Refresh Token rotation & thu hồi phiên trên từng hoặc mọi thiết bị. */
export interface SessionRecord {
  id: string;
  userId: string;
  refreshHash: string;
  userAgent: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  replacedBySessionId: string | null;
}

export interface BoundingBoxQuery {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export interface ReportQuery {
  wardCodes?: string[];
  statuses?: ReportStatus[];
  category?: string;
  reporterId?: string;
  bbox?: BoundingBoxQuery;
  /** Keyset/Cursor pagination: ISO timestamp `createdAt` của phần tử cuối trang trước */
  cursor?: string;
  limit?: number;
}

export interface NearbyQuery {
  lat: number;
  lng: number;
  radiusM: number;
  category?: string;
}

export interface ReportRepository {
  list(q?: ReportQuery): Promise<Report[]>;
  get(id: string): Promise<Report | null>;
  getByCode(code: string): Promise<Report | null>;
  insert(report: Report): Promise<void>;
  /** Thay thế toàn bộ bản ghi theo id. */
  update(report: Report): Promise<void>;
  findNearby(q: NearbyQuery): Promise<Report[]>;
  /** Các hồ sơ tạo từ `sinceIso` đến nay (phục vụ so sánh dHash trong 24h). */
  findSince(sinceIso: string): Promise<Report[]>;
  countByReporterSince(reporterId: string, sinceIso: string): Promise<number>;
  count(): Promise<number>;
}

export interface UserRepository {
  get(id: string): Promise<UserRecord | null>;
  getByPhone(phone: string): Promise<UserRecord | null>;
  getByEmail(email: string): Promise<UserRecord | null>;
  getByStaffCode(code: string): Promise<UserRecord | null>;
  save(user: UserRecord): Promise<void>;
  list(role?: Role): Promise<UserRecord[]>;
  count(): Promise<number>;
}

/** Nhật ký kiểm toán: CHỈ có append/đọc — không có update/delete. */
export interface AuditRepository {
  last(): Promise<AuditEntry | null>;
  append(entry: AuditEntry): Promise<void>;
  list(limit: number): Promise<AuditEntry[]>;
  all(): Promise<AuditEntry[]>;
}

export interface OtpRepository {
  get(identifier: string): Promise<OtpRecord | null>;
  save(rec: OtpRecord): Promise<void>;
  delete(identifier: string): Promise<void>;
}

export interface SessionRepository {
  getByRefreshHash(refreshHash: string): Promise<SessionRecord | null>;
  save(rec: SessionRecord): Promise<void>;
  revoke(id: string, replacedBySessionId?: string | null): Promise<void>;
  revokeAllForUser(userId: string): Promise<void>;
}

export interface Repositories {
  mode: 'mongodb' | 'json';
  reports: ReportRepository;
  users: UserRepository;
  audit: AuditRepository;
  otps: OtpRepository;
  sessions: SessionRepository;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
