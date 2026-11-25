import type { AuditEntry, Category, DynamicAiConfig, Notification, Report, ReportStatus, Role, TrustLevel } from '../shared/types';
import type { OtpChannel, OtpPurpose } from '../services/otpDelivery.service';

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
  tokenVersion?: number;
  activeSessionId?: string | null;
  trustLevel?: TrustLevel;
  violationCount?: number;
  lastLoginIp?: string | null;
  lastLoginAt?: number | null;
  trustScore: number;
  badges: string[];
  volunteerHours: number;
  points: number;
  notifications: Notification[];
  createdAt: string;
}

export interface OtpRecord {
  identifier: string;
  channel: OtpChannel;
  purpose: OtpPurpose;
  codeHash: string;
  otpSalt?: string;
  expiresAt: number;
  resendAt: number;
  failedAttempts: number;
  lockedUntil: number;
  consumedAt: number | null;
}

export interface SessionRecord {
  id: string;
  userId: string;
  refreshHash: string;
  tokenHash?: string;
  deviceFingerprint?: string;
  ip?: string;
  userAgent: string;
  tokenVersion?: number;
  createdAt: number;
  lastActiveAt?: number;
  expiresAt: number;
  isRevoked?: boolean;
  revokedAt: number | null;
  revokedReason?: string | null;
  replacedBySessionId: string | null;
}

export interface ImageFingerprintRecord {
  id: string;
  reportId: string;
  photoId: string;
  wardCode: string;
  category: Category;
  dHash: string;
  flippedDHash?: string;
  pHash: string;
  centerHash: string;
  gridHashes: string[];
  subGrid2x2?: string[];
  colorHistogram?: number[];
  keypointCount: number;
  descriptorsBase64: string;
  lat: number;
  lng: number;
  createdAt: string;
}

export interface AiEvaluationRecord {
  id: string;
  reportId: string;
  kind: 'authenticity' | 'duplicate' | 'resolution';
  authenticityScore: number | null;
  sceneMatchScore: number | null;
  resolutionScore: number | null;
  isAuthentic: boolean | null;
  isDuplicate: boolean | null;
  resolutionVerified: boolean | null;
  inlierCount: number;
  flags: string[];
  engineMode: string;
  latencyMs: number;
  summary: string;
  createdAt: string;
}

export interface BoundingBoxQuery {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export type ReportProjection = 'summary' | 'stats' | 'dedup' | 'code_only' | 'full';

export interface ReportQuery {
  wardCodes?: string[];
  statuses?: ReportStatus[];
  category?: string;
  reporterId?: string;
  bbox?: BoundingBoxQuery;
  cursor?: string;
  limit?: number;
  projection?: ReportProjection;
}

export interface NearbyQuery {
  lat: number;
  lng: number;
  radiusM: number;
  category?: string;
  sinceIso?: string;
  limit?: number;
  projection?: ReportProjection;
}

export interface AtomicRescueClaimInput {
  teamId: string;
  teamName: string;
  teamCode: string | null;
  nowIso: string;
  lat?: number | null;
  lng?: number | null;
}

export interface UserFilterQuery {
  role?: Role;
  wardCode?: string;
  isActive?: boolean;
  q?: string;
}

export interface ReportRepository {
  list(q?: ReportQuery): Promise<Report[]>;
  get(id: string): Promise<Report | null>;
  getByCode(code: string): Promise<Report | null>;
  insert(report: Report): Promise<void>;
  update(report: Report): Promise<void>;
  delete(id: string): Promise<boolean>;
  claimRescueMission(id: string, claim: AtomicRescueClaimInput): Promise<Report | null>;
  findNearby(q: NearbyQuery): Promise<Report[]>;
  findSince(sinceIso: string, projection?: ReportProjection): Promise<Report[]>;
  countByReporterSince(reporterId: string, sinceIso: string): Promise<number>;
  count(): Promise<number>;
}

export interface UserRepository {
  get(id: string): Promise<UserRecord | null>;
  getByPhone(phone: string): Promise<UserRecord | null>;
  getByEmail(email: string): Promise<UserRecord | null>;
  getByStaffCode(code: string): Promise<UserRecord | null>;
  save(user: UserRecord): Promise<void>;
  delete(id: string): Promise<boolean>;
  list(role?: Role): Promise<UserRecord[]>;
  query(filter?: UserFilterQuery): Promise<UserRecord[]>;
  count(): Promise<number>;
}

export interface FingerprintRepository {
  save(fp: ImageFingerprintRecord): Promise<void>;
  findNearbyRecent(lat: number, lng: number, radiusM: number, sinceIso: string): Promise<ImageFingerprintRecord[]>;
  listByReport(reportId: string): Promise<ImageFingerprintRecord[]>;
  count(): Promise<number>;
}

export interface AiEvaluationRepository {
  append(rec: AiEvaluationRecord): Promise<void>;
  listByReport(reportId: string): Promise<AiEvaluationRecord[]>;
  recent(limit?: number): Promise<AiEvaluationRecord[]>;
  count(): Promise<number>;
}

export interface AiConfigRepository {
  get(): Promise<DynamicAiConfig | null>;
  save(cfg: DynamicAiConfig): Promise<void>;
}

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
  get(id: string): Promise<SessionRecord | null>;
  getByRefreshHash(refreshHash: string): Promise<SessionRecord | null>;
  listActive(filter?: { userId?: string; includeRevoked?: boolean; limit?: number }): Promise<SessionRecord[]>;
  save(rec: SessionRecord): Promise<void>;
  touch(id: string, lastActiveAt: number, ip?: string): Promise<void>;
  revoke(id: string, replacedBySessionId?: string | null, reason?: string | null): Promise<void>;
  revokeAllForUser(userId: string, reason?: string | null): Promise<number>;
  revokeAllExcept(userId: string, exceptSessionId: string, reason?: string | null): Promise<number>;
  revokeAllSystem(exceptSessionId?: string | null, reason?: string | null): Promise<number>;
}

export interface DbHealthStats {
  ok: boolean;
  latencyMs: number;
  counts: {
    reports: number;
    users: number;
    fingerprints: number;
    evaluations: number;
    auditLogs: number;
  };
}

export interface Repositories {
  mode: 'mongodb' | 'json';
  reports: ReportRepository;
  users: UserRepository;
  fingerprints: FingerprintRepository;
  evaluations: AiEvaluationRepository;
  aiConfig: AiConfigRepository;
  audit: AuditRepository;
  otps: OtpRepository;
  sessions: SessionRepository;
  ping(): Promise<boolean>;
  healthStats(): Promise<DbHealthStats>;
  close(): Promise<void>;
}
