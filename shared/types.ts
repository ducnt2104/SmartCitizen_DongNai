/**
 * Data Contract dùng chung cho client/ và server/ (Interface-First).
 * Mọi thay đổi schema phải bắt đầu từ file này.
 */

export type Category = 'rac_thai' | 'den_duong' | 'ngap_nuoc' | 'mat_duong';
export const CATEGORIES: readonly Category[] = ['rac_thai', 'den_duong', 'ngap_nuoc', 'mat_duong'] as const;

export type Role = 'citizen' | 'volunteer' | 'ward_officer' | 'city_admin';

export type ReportStatus = 'received' | 'verifying' | 'processing' | 'resolved' | 'quarantined' | 'rejected';
export type Priority = 'normal' | 'high' | 'emergency';

export type QuarantineReason =
  | 'duplicate_image'
  | 'low_authenticity'
  | 'gps_anomaly'
  | 'low_trust'
  | 'manual';

export type Department =
  | 'dien_chieu_sang'
  | 'moi_truong'
  | 'giao_thong'
  | 'ubnd_khu_pho'
  | 'dien_luc'
  | 'csgt';

export type WardZone = 'Trung tâm' | 'Công nghiệp' | 'Nông thôn - Sinh thái' | 'Liên vùng';

export interface Ward {
  wardCode: string;
  name: string;
  kind: 'Phường' | 'Xã';
  zone: WardZone;
  centerLat: number;
  centerLng: number;
  adjacentWardCodes: string[];
  arterialRoads: string[];
}

export interface Photo {
  id: string;
  url: string;
  /** 64-bit dHash dạng 16 ký tự hex */
  dHash: string;
  kind: 'before' | 'angle' | 'after' | 'verify';
  takenBy: string;
  createdAt: string;
}

export type AiMode = 'gemini' | 'fallback' | 'seed';

export interface AiAnalysis {
  authenticityScore: number;
  fraudFlags: string[];
  confidence: number;
  safetyHazards: string[];
  suggestedDepartment: Department | null;
  mode: AiMode;
}

export interface DispatchOrder {
  id: string;
  fromWardCode: string;
  toWardCodes: string[];
  units: Department[];
  issuedAt: string;
  issuedBy: string;
  auto: boolean;
  note: string;
}

export interface ResolutionVerification {
  resolutionVerified: boolean;
  matchConfidence: number;
  summary: string;
  mode: AiMode;
  at: string;
}

export interface Rating {
  stars: 1 | 2 | 3 | 4 | 5;
  comment: string;
  at: string;
}

export interface FieldVerification {
  verdict: 'true' | 'duplicate' | 'fake';
  note: string;
  volunteerId: string;
  volunteerName: string;
  photo: Photo | null;
  at: string;
}

export type TimelineStage = 'received' | 'verifying' | 'processing' | 'resolved';
export interface TimelineEvent {
  stage: TimelineStage | 'quarantined' | 'escalated' | 'dispatched';
  at: string;
  note: string;
}

export interface Contributor {
  userId: string;
  phoneMasked: string;
  at: string;
}

/** Bản ghi đầy đủ (chỉ server/IOC nội bộ nhìn thấy). */
export interface Report {
  id: string;
  code: string;
  category: Category;
  title: string;
  description: string;
  severity: 1 | 2 | 3 | 4 | 5;
  isEmergency: boolean;
  emergencyLevel: 0 | 1;
  priority: Priority;
  status: ReportStatus;
  wardCode: string;
  address: string;
  roadName: string | null;
  onArterial: boolean;
  lat: number;
  lng: number;
  photos: Photo[];
  afterPhoto: Photo | null;
  clusterCount: number;
  contributors: Contributor[];
  /** userId đã bấm "Cùng xác nhận" (mỗi SĐT/userId chỉ 1 lần) */
  confirmations: string[];
  reporterId: string;
  reporterPhoneMasked: string;
  isProxyReport: boolean;
  proxyVolunteerId: string | null;
  seniorSubmitted: boolean;
  needsFieldVerification: boolean;
  assignedVolunteerId: string | null;
  verification: FieldVerification | null;
  ai: AiAnalysis;
  gpsMismatchWarning: boolean;
  gpsDistanceKm: number | null;
  quarantine: { reason: QuarantineReason; detail: string; at: string; relatedReportId: string | null } | null;
  possibleDuplicateOf: string | null;
  department: Department | null;
  slaDueAt: string | null;
  dispatches: DispatchOrder[];
  resolvedAt: string | null;
  resolution: ResolutionVerification | null;
  rating: Rating | null;
  timeline: TimelineEvent[];
  source: 'seed' | 'user';
  createdAt: string;
  updatedAt: string;
}

/** Bản ghi gửi xuống trình duyệt (không lộ danh tính nội bộ). */
export type ClientReport = Omit<Report, 'reporterId' | 'contributors' | 'confirmations'> & {
  confirmCount: number;
  contributorCount: number;
  /** Chỉ có ở bản local chưa đồng bộ */
  syncState?: 'synced' | 'pending';
  /** Đánh dấu bản ghi do thiết bị này gửi */
  mine?: boolean;
};

export interface AuditEntry {
  id: string;
  seq: number;
  actorId: string;
  actorName: string;
  role: Role | 'system';
  action: string;
  targetId: string;
  beforeState: unknown;
  afterState: unknown;
  timestamp: string;
  prevHash: string;
  hash: string;
}

export interface Notification {
  id: string;
  text: string;
  reportCode: string;
  at: string;
  read: boolean;
}

export interface UserProfile {
  id: string;
  role: Role;
  name: string;
  phoneMasked: string | null;
  email: string | null;
  staffCode: string | null;
  wardCode: string | null;
  unitCode: string | null;
  trustScore: number;
  badges: string[];
  volunteerHours: number;
  points: number;
  supervised: boolean;
  notifications: Notification[];
}

export interface AuthSession {
  token: string;
  user: UserProfile;
}

export interface VisionResult {
  category: Category;
  title: string;
  description: string;
  severity: 1 | 2 | 3 | 4 | 5;
  isEmergency: boolean;
  safetyHazards: string[];
  suggestedDepartment: Department;
  authenticityScore: number;
  fraudFlags: string[];
  confidence: number;
  mode: 'gemini' | 'fallback';
  cached: boolean;
}

export interface ScopeStats {
  scope: string;
  total: number;
  resolved: number;
  open: number;
  resolvedPct: number;
  avgDays: number;
  byCategory: Record<Category, number>;
  emergency: number;
  quarantined: number;
  slaOverdue: number;
}
