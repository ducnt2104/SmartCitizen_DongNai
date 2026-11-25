/**
 * Data Contract dùng chung cho frontend/ và backend/ (Interface-First).
 * Mô hình chính quyền 2 cấp: Thành phố Đồng Nai -> 95 Phường/Xã (33 Phường, 62 Xã từ 30/04/2026).
 */

export type Category = 'rac_thai' | 'den_duong' | 'ngap_nuoc' | 'mat_duong' | 'khac';
export const CATEGORIES: readonly Category[] = [
  'rac_thai',
  'den_duong',
  'ngap_nuoc',
  'mat_duong',
  'khac',
] as const;

export type Role = 'admin' | 'officer' | 'rescue' | 'citizen';
export type RoleCode = 'ADMIN' | 'OFFICER' | 'RESCUE' | 'CITIZEN';

export const ROLES: readonly Role[] = [
  'admin',
  'officer',
  'rescue',
  'citizen',
] as const;

export type ReportStatus = 'received' | 'verifying' | 'processing' | 'resolved' | 'quarantined' | 'rejected';
export type Priority = 'normal' | 'high' | 'emergency';
export type SeverityLabel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

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

export type CityRegionId =
  | 'trung_tam'
  | 'nam_san_bay_cang'
  | 'dong_xuan_loc'
  | 'dong_bac_cat_tien'
  | 'bac_dong_nai';

export interface QuickJumpRegion {
  id: CityRegionId;
  labelVi: string;
  labelEn: string;
  center: readonly [lat: number, lng: number];
  zoom: number;
}

export interface Ward {
  wardCode: string;
  name: string;
  shortName: string;
  kind: 'Phường' | 'Xã';
  region: CityRegionId;
  zone: WardZone;
  centerLat: number;
  centerLng: number;
  /** 10 phường mới nâng cấp từ xã ngày 30/04/2026 (NQ 237/NQ-UBTVQH16) */
  upgradedOn2026: boolean;
  /** Tên đơn vị cũ (trước 01/07/2025 & trước 30/04/2026) để ánh xạ ngược 2 thế hệ */
  legacyAliases: readonly string[];
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

export type AiMode = 'local_rust_llm' | 'local_rust' | 'ollama' | 'gemini' | 'fallback' | 'seed';

export interface TacticalBriefing {
  /** (1) Tóm tắt rủi ro hiện trường */
  riskSummary: string;
  /** (2) Thiết bị & nhân lực cần mang theo */
  equipmentAndCrew: string;
  /** (3) Cảnh báo an toàn tại hiện trường */
  safetyWarning: string;
  mode: AiMode;
  generatedAt: string;
  latencyMs?: number;
}

export type RescueMissionStatus =
  | 'unassigned'
  | 'accepted'
  | 'en_route'
  | 'arrived'
  | 'in_progress'
  | 'on_site'
  | 'completed';

export type RescueStageCode =
  | 'PENDING'
  | 'VERIFIED'
  | 'DISPATCHED'
  | 'EN_ROUTE'
  | 'ARRIVED'
  | 'IN_PROGRESS'
  | 'RESOLVED';

export interface RescueLiveLocation {
  lat: number;
  lng: number;
  heading: number | null;
  speedKmh: number | null;
  updatedAt: string;
}

export interface RescueReleaseEntry {
  teamId: string;
  teamName: string;
  teamCode: string | null;
  reason: string;
  at: string;
}

export interface RescueMissionState {
  status: RescueMissionStatus;
  stageCode?: RescueStageCode | 'UNASSIGNED';
  assignedTeamId: string | null;
  assignedTeamName: string | null;
  assignedTeamCode: string | null;
  acceptedAt: string | null;
  enRouteAt: string | null;
  arrivedAt?: string | null;
  inProgressAt?: string | null;
  onSiteAt: string | null;
  completedAt: string | null;
  lastLat?: number | null;
  lastLng?: number | null;
  lastHeading?: number | null;
  lastSpeedKmh?: number | null;
  lastLocationUpdatedAt?: string | null;
  note?: string;
  releaseHistory?: RescueReleaseEntry[];
}

export interface AiAnalysis {
  authenticityScore: number;
  fraudFlags: string[];
  confidence: number;
  safetyHazards: string[];
  suggestedDepartment: Department | null;
  aiSuggestedLabel?: string | null;
  priorityScore?: number;
  severityLabel?: SeverityLabel;
  tacticalBriefing?: TacticalBriefing | null;
  isDuplicateCrop?: boolean;
  duplicateSimilarity?: number | null;
  inlierCount?: number | null;
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
  sceneMatchScore?: number;
  resolutionScore?: number;
  inlierKeypoints?: number;
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
  aiSuggestedLabel?: string | null;
  title: string;
  description: string;
  severity: 1 | 2 | 3 | 4 | 5;
  severityLabel?: SeverityLabel;
  priorityScore?: number;
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
  /** userId đã bấm "Cùng xác nhận" (mỗi tài khoản chỉ 1 lần) */
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
  assignedRescueId?: string | null;
  assignedRescueName?: string | null;
  acceptedAt?: string | null;
  rescueStatus?: RescueStageCode | null;
  rescueLiveLocation?: RescueLiveLocation | null;
  rescueReleaseHistory?: RescueReleaseEntry[];
  rescueMission?: RescueMissionState | null;
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

/** Bản ghi nhiệm vụ dành riêng cho Đội Cứu Hộ & Cán bộ điều phối hiện trường. */
export type RescueMissionItem = ClientReport & {
  distanceKm: number | null;
  etaMinutes: number | null;
  reporterPhone?: string | null;
  reporterName?: string | null;
};

export interface RescueMissionsResponse {
  activeMission: RescueMissionItem | null;
  availableMissions: RescueMissionItem[];
  resolvedMissions: RescueMissionItem[];
}

/** Bản tóm tắt siêu nhẹ cho Map Markers (không kéo mảng ảnh base64 lớn). */
export interface ReportSummary {
  id: string;
  code: string;
  category: Category;
  title: string;
  severity: 1 | 2 | 3 | 4 | 5;
  severityLabel?: SeverityLabel;
  priorityScore?: number;
  isEmergency: boolean;
  emergencyLevel: 0 | 1;
  priority: Priority;
  status: ReportStatus;
  wardCode: string;
  lat: number;
  lng: number;
  clusterCount: number;
  confirmCount: number;
  createdAt: string;
}

export interface PaginatedReports {
  items: ClientReport[];
  nextCursor: string | null;
  hasMore: boolean;
  total: number;
}

export interface ReverseGeocodeResult {
  inBounds: boolean;
  address: string;
  wardCode: string | null;
  wardName: string | null;
  source: 'osm_alias' | 'osm_nearest' | 'local_fallback' | 'out_of_bounds';
  needsConfirmation: boolean;
  matchedAlias: string | null;
  arterial: { name: string; distanceM: number } | null;
}

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
  roleCode?: RoleCode;
  name: string;
  phoneMasked: string | null;
  email: string | null;
  staffCode: string | null;
  wardCode: string | null;
  unitCode: string | null;
  defaultWardCode?: string | null;
  notificationsEnabled?: boolean;
  revoked?: boolean;
  isActive?: boolean;
  trustScore: number;
  badges: string[];
  volunteerHours: number;
  points: number;
  supervised: boolean;
  notifications: Notification[];
  createdAt?: string;
}

export interface AuthSession {
  token: string;
  user: UserProfile;
}

export interface VisionResult {
  category: Category;
  aiSuggestedLabel?: string | null;
  title: string;
  description: string;
  severity: 1 | 2 | 3 | 4 | 5;
  severityLabel?: SeverityLabel;
  priorityScore?: number;
  isEmergency: boolean;
  safetyHazards: string[];
  suggestedDepartment: Department;
  authenticityScore: number;
  isAuthentic?: boolean;
  fraudFlags: string[];
  confidence: number;
  tacticalBriefing?: TacticalBriefing | null;
  mode: AiMode;
  cached: boolean;
  latencyMs?: number;
}

export interface DynamicAiConfig {
  screenshotThreshold: number;
  duplicateThreshold: number;
  minKeypointInliers: number;
  sceneMatchThreshold: number;
  resolutionThreshold: number;
  allowCloudFallback: boolean;
  updatedAt: string;
  updatedBy: string;
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
