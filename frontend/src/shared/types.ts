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
  thumbnailUrl?: string;
  mediaId?: string;
  width?: number;
  height?: number;
  bytes?: number;
  /** 64-bit dHash dạng 16 ký tự hex */
  dHash: string;
  /** 64-bit 2D-DCT pHash dạng 16 ký tự hex */
  pHash?: string;
  /** Lưới băm 3x3 chống cắt xén (crop) */
  subGridHashes?: string[];
  /** Histogram màu 24-bin chuẩn hóa */
  colorHistogram?: number[];
  kind: 'before' | 'angle' | 'after' | 'verify';
  takenBy: string;
  createdAt: string;
}

export type AiMode =
  | 'local_ai'
  | 'local_rust_llm'
  | 'local_rust'
  | 'ollama'
  | 'gemini'
  | 'fallback'
  | 'seed';

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

export type ModerationDecision = 'AUTO_APPROVE' | 'HUMAN_REVIEW' | 'AUTO_REJECT';
export type AbuseRisk = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
export type TrustLevel = 'high' | 'normal' | 'watchlist' | 'flagged';
export type StandardizedCivicCategory =
  | 'RAC_THAI_MOI_TRUONG'
  | 'HA_TANG_GIAO_THONG'
  | 'NGAP_UNG_THOAT_NUOC'
  | 'CAY_XANH_DO_NGA'
  | 'DIEN_VIEN_THONG'
  | 'TRAT_TU_DO_THI'
  | 'PCCC_KHAN_CAP'
  | 'KHAC';

export interface ExifForensicInfo {
  capturedAt?: string | null;
  gpsLat?: number | null;
  gpsLng?: number | null;
  cameraMake?: string | null;
  cameraModel?: string | null;
  software?: string | null;
  hasCameraExif?: boolean;
  c2paDetected?: boolean;
  aiSignatureMatched?: string | null;
}

export interface ForensicSignals {
  elaScore: number;
  noiseResidualScore: number;
  fftSmoothnessScore: number;
  moireScore: number;
  edgeDensityScore: number;
  screenshotProbability: number;
  aiProbability: number;
  staleExifMinutes?: number | null;
  gpsDriftMeters?: number | null;
  exifSummary?: ExifForensicInfo;
  flags: string[];
  hardwareAuthenticated: boolean;
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
  standardizedCategory?: StandardizedCivicCategory;
  moderationDecision?: ModerationDecision;
  decision?: ModerationDecision;
  relevanceScore?: number;
  abuseRisk?: AbuseRisk;
  isScreenCaptureOrFake?: boolean;
  forensicFlags?: string[];
  forensics?: ForensicSignals | null;
  keyEvidenceTags?: string[];
  officerReviewNotes?: string | null;
  citizenFeedback?: string | null;
  latencyMs?: number;
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
  resolutionStatus?: 'AUTO_VERIFIED' | 'PENDING_MODERATION' | 'REJECTED';
  rejectedReasonCode?: string | null;
  matchConfidence: number;
  sceneMatchScore?: number;
  resolutionScore?: number;
  ssimScore?: number | null;
  gpsDistanceMeters?: number | null;
  temporalValid?: boolean;
  forensicPassed?: boolean;
  forensics?: ForensicSignals | null;
  criteria?: {
    isAuthentic: boolean;
    sameScene: boolean;
    issueResolved: boolean;
    spatiotemporalValid: boolean;
  };
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
  resolutionStatus?: 'NONE' | 'AUTO_VERIFIED' | 'PENDING_MODERATION' | 'REJECTED';
  resolution: ResolutionVerification | null;
  afterExif?: ExifForensicInfo | null;
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
  thumbnailUrl?: string | null;
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
  ip?: string | null;
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

export interface SessionInfo {
  id: string;
  userId: string;
  userName?: string;
  role?: Role;
  wardCode?: string | null;
  deviceFingerprint: string;
  ip: string;
  userAgent: string;
  createdAt: number;
  lastActiveAt: number;
  expiresAt: number;
  isRevoked: boolean;
  revokedAt: number | null;
  revokedReason: string | null;
  isCurrent?: boolean;
}

export interface UserViolationEntry {
  id: string;
  action: string;
  detail: string;
  reportId?: string | null;
  at: string;
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
  followedWardCodes?: string[];
  notificationsEnabled?: boolean;
  revoked?: boolean;
  isActive?: boolean;
  trustScore: number;
  trustLevel?: TrustLevel;
  violationCount?: number;
  tokenVersion?: number;
  activeSessionId?: string | null;
  hasPassword?: boolean;
  lastLoginAt?: number | null;
  lastLoginIp?: string | null;
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
  // ── 3-Stage AI Cascade Fields ──
  status?: 'ANALYZED' | 'DUPLICATE_FOUND' | 'REJECTED_PREFILTER';
  duplicateIncidentId?: string | null;
  duplicateIncidentCode?: string | null;
  standardizedCategory?: StandardizedCivicCategory;
  suggestedUnit?: string;
  suggestedTitle?: string;
  suggestedDescription?: string;
  keyEvidenceTags?: string[];
  isScreenCaptureOrFake?: boolean;
  forensicFlags?: string[];
  forensics?: ForensicSignals | null;
  relevanceScore?: number;
  abuseRisk?: AbuseRisk;
  decision?: ModerationDecision;
  citizenFeedback?: string | null;
  officerReviewNotes?: string | null;
  stageTimingsMs?: { stage0?: number; stage1?: number; total: number };
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

export type WeatherRiskLevel = 'normal' | 'advisory' | 'warning' | 'emergency';

export interface WeatherSnapshotItem {
  id: string;
  regionKey: string;
  regionName: string;
  wardCode: string;
  lat: number;
  lng: number;
  temperatureC: number;
  humidityPct: number;
  precipitationMm: number;
  precipitation24hMm: number;
  precipitationProbabilityPct: number;
  windGustsKmh: number;
  weatherCode: number;
  weatherLabel: string;
  riskLevel: WeatherRiskLevel;
  isHazard: boolean;
  source: string;
  observedAt: string;
  fetchedAt: string;
}

export type AlertCategory = 'disaster' | 'traffic' | 'utility' | 'official_notice';
export type AlertSeverity = 1 | 2 | 3;
export type AlertSourceType =
  | 'official_rss'
  | 'weather_api'
  | 'rescue_admin'
  | 'community_cluster'
  | 'community_user';
export type AlertGeometryType = 'point' | 'circle' | 'polyline';

export interface CivicAlertItem {
  id: string;
  title: string;
  description: string;
  category: AlertCategory;
  severity: AlertSeverity;
  sourceType: AlertSourceType;
  sourceLabel: string;
  sourceUrl?: string | null;
  sourceUrlHash?: string | null;
  wardIds: string[];
  affectedRoads: string[];
  detourNote?: string | null;
  geometryType: AlertGeometryType;
  lat: number;
  lng: number;
  radiusM?: number | null;
  polyline?: Array<[number, number]>;
  status: 'active' | 'resolved';
  isVerifiedOfficial: boolean;
  confirmCount: number;
  confirmedByUserIds?: string[];
  clusterReportCount?: number | null;
  clusterDistinctUsers?: number | null;
  createdById?: string | null;
  createdByName?: string | null;
  startsAt?: string | null;
  expiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OfficialBulletinItem {
  id: string;
  title: string;
  cleanSummary: string;
  category: AlertCategory;
  severity: AlertSeverity;
  wardIds: string[];
  affectedRoads: string[];
  sourceName: string;
  sourceUrl: string;
  sourceUrlHash: string;
  publishedAt: string;
  fetchedAt: string;
}

export interface DailyDigestItem {
  id: string;
  dateKey: string;
  bullets: string[];
  highlightsCount: {
    alerts: number;
    bulletins: number;
    openIncidents: number;
  };
  generatedAt: string;
  expiresAt: string;
  cached: boolean;
  model?: string;
}

export type WardOverviewStatus = 'Ổn định' | 'Cần chú ý' | 'Điểm nóng';

export interface WardOverviewResponse {
  ward: Ward;
  stats30d: {
    totalReports: number;
    resolvedReports: number;
    resolvedPct: number;
    openReports: number;
    emergencyReports: number;
    avgResolutionHours: number | null;
    areaStatus: WardOverviewStatus;
  };
  heatmapPoints: Array<[number, number, number]>;
  incidents: {
    items: Report[];
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
  };
  alerts: CivicAlertItem[];
  bulletins: OfficialBulletinItem[];
  weather: WeatherSnapshotItem | null;
}

export interface RouteCheckResponse {
  roadQuery: string;
  status: 'clear' | 'caution' | 'danger';
  maxSeverity: 0 | 1 | 2 | 3;
  activeAlerts: CivicAlertItem[];
  relatedIncidentsCount: number;
  message: string;
  checkedAt: string;
}
