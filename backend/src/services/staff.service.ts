import {
  computeSosPriorityScore,
  DEPARTMENTS,
  normalizeRole,
  normalizeRoleInput,
  toRoleCode,
  toSeverityLabel,
} from '../shared/constants';
import { normalizeCoordinates } from '../shared/coordinates';
import { DONG_NAI_WARDS, WARD_BY_CODE } from '../shared/dongNaiWards';
import { haversineMeters, normalizeEmail, normalizePhone } from '../shared/geo';
import { computeStats, toClientReport } from '../shared/report';
import type {
  AuditEntry,
  ClientReport,
  Department,
  DispatchOrder,
  Photo,
  Report,
  RescueLiveLocation,
  RescueMissionItem,
  RescueMissionState,
  RescueMissionsResponse,
  RescueReleaseEntry,
  RescueStageCode,
  Role,
  ScopeStats,
  SessionInfo,
  TrustLevel,
  UserProfile,
  UserViolationEntry,
} from '../shared/types';
import type { Repositories, UserFilterQuery, UserRecord } from '../repositories/types';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { hashPassword, newId, validatePasswordStrength } from '../utils/crypto';
import { assertScope, isAdminRole, loadStoredPhotoForVerification, parsePhotoDataUrl, type PhotoInput } from './access';
import type { AuditService } from './audit.service';
import type { CacheService } from './cache.service';
import type { EdgeStats, GeminiService } from './gemini.service';
import type { MediaService } from './media.service';
import { slaHoursFor } from './report.service';
import { notifyAllSessionsTerminated, notifySessionTerminated } from './sessionEvents';
import { toProfile, type TrustService } from './trust.service';

export type QueueTab = 'emergency' | 'high' | 'open' | 'quarantine';
const HOUR = 3600000;

const snap = (r: Report) => ({
  status: r.status,
  priority: r.priority,
  department: r.department,
  slaDueAt: r.slaDueAt,
  quarantine: r.quarantine?.reason ?? null,
  dispatches: r.dispatches.length,
  resolvedAt: r.resolvedAt,
});

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function extractStaffPhoto(p: PhotoInput): { mime: string; base64: string } {
  if (p.dataUrl) {
    const parsed = parsePhotoDataUrl(p.dataUrl);
    return { mime: parsed.mime, base64: parsed.base64 };
  }
  const buf = p.aiBuffer ?? p.buffer;
  if (buf && buf.byteLength > 0) {
    return { mime: 'image/webp', base64: buf.toString('base64') };
  }
  throw badRequest('Thiếu dữ liệu ảnh nghiệm thu (multipart hoặc dataUrl).', 'invalid_photo');
}

async function persistStaffPhoto(
  media: MediaService | undefined,
  p: PhotoInput,
  kind: Photo['kind'],
  by: string,
  reportId: string,
): Promise<Photo> {
  const now = new Date().toISOString();
  if (p.buffer && p.buffer.byteLength > 0 && media) {
    const stored = await media.storeIncidentImage({ buffer: p.buffer, dHash: p.dHash, reportId });
    return {
      id: newId('ph'),
      url: stored.url,
      thumbnailUrl: stored.thumbnailUrl,
      mediaId: stored.mediaId,
      dHash: p.dHash,
      width: stored.width,
      height: stored.height,
      bytes: stored.displayBytes,
      kind,
      takenBy: by,
      createdAt: now,
    };
  }
  return { id: newId('ph'), url: p.dataUrl ?? '', dHash: p.dHash, kind, takenBy: by, createdAt: now };
}

export class StaffService {
  constructor(
    private readonly repos: Repositories,
    private readonly gemini: GeminiService,
    private readonly trust: TrustService,
    private readonly audit: AuditService,
    private readonly cache?: CacheService,
    private readonly media?: MediaService,
    private readonly onSessionsInvalidated?: (userId: string, exceptSessionId?: string | null) => void,
  ) {}

  private actor(u: UserRecord) {
    return { id: u.id, name: u.name, role: normalizeRole(u.role) };
  }

  /** Cán bộ gắn Phường/Xã bị khóa phạm vi về wardCode của mình; Cán bộ toàn TP (`wardCode = null`) và Admin chọn tự do. */
  resolveScope(u: UserRecord, requested: string | undefined): string {
    const role = normalizeRole(u.role);
    if (role === 'officer' && u.wardCode) return `ward:${u.wardCode}`;
    if (!requested || requested === 'city') return 'city';
    if (!/^ward:DN-[A-Z]{2,4}$/.test(requested) || !WARD_BY_CODE[requested.slice(5)]) {
      throw badRequest('Phạm vi không hợp lệ.', 'invalid_scope');
    }
    return requested;
  }

  private async scoped(scope: string): Promise<Report[]> {
    return this.repos.reports.list({ wardCodes: scope.startsWith('ward:') ? [scope.slice(5)] : undefined });
  }

  private async load(u: UserRecord, id: string): Promise<Report> {
    const r = await this.repos.reports.get(id);
    if (!r) throw notFound('Không tìm thấy hồ sơ.');
    assertScope(u, r);
    return r;
  }

  async overview(u: UserRecord, scope: string): Promise<{
    stats: ScopeStats;
    trend: Array<{ date: string; avgDays: number; resolved: number }>;
    targetDays: number;
    ranking: Array<{ wardCode: string; name: string; total: number; resolved: number; avgDays: number }>;
  }> {
    const rows = (await this.scoped(scope)).map(toClientReport);
    const byDay = new Map<string, { sum: number; n: number }>();
    for (const r of rows) {
      if (r.status !== 'resolved' || !r.resolvedAt) continue;
      const day = r.createdAt.slice(0, 10);
      const e = byDay.get(day) ?? { sum: 0, n: 0 };
      e.sum += (Date.parse(r.resolvedAt) - Date.parse(r.createdAt)) / 86400000;
      e.n += 1;
      byDay.set(day, e);
    }
    const trend = [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, e]) => ({ date, avgDays: Math.round((e.sum / e.n) * 10) / 10, resolved: e.n }));
    const ranking = isAdminRole(u)
      ? DONG_NAI_WARDS.map((w) => {
          const s = computeStats(rows.filter((r) => r.wardCode === w.wardCode), w.wardCode);
          return { wardCode: w.wardCode, name: w.name, total: s.total, resolved: s.resolved, avgDays: s.avgDays };
        })
          .filter((x) => x.total > 0)
          .sort((a, b) => a.avgDays - b.avgDays)
      : [];
    return { stats: computeStats(rows, scope), trend, targetDays: 1.5, ranking };
  }

  async queue(u: UserRecord, scope: string, tab: QueueTab): Promise<ClientReport[]> {
    const rows = await this.scoped(scope);
    const open = (r: Report) => !['resolved', 'quarantined', 'rejected'].includes(r.status);
    const pick: Record<QueueTab, (r: Report) => boolean> = {
      emergency: (r) => open(r) && (r.emergencyLevel === 1 || r.priority === 'emergency'),
      high: (r) => open(r) && r.priority === 'high' && (r.clusterCount >= 2 || r.confirmations.length >= 3),
      open,
      quarantine: (r) => r.status === 'quarantined',
    };
    return rows.filter(pick[tab]).map(toClientReport);
  }

  async assign(u: UserRecord, id: string, department: Department, slaHours: number): Promise<ClientReport> {
    const r = await this.load(u, id);
    if (r.status === 'resolved' || r.status === 'quarantined' || r.status === 'rejected') {
      throw badRequest('Không thể giao việc ở trạng thái hiện tại.', 'invalid_state');
    }
    if (!DEPARTMENTS.includes(department)) throw badRequest('Bộ phận không hợp lệ.');
    const before = snap(r);
    const now = new Date().toISOString();
    r.department = department;
    r.slaDueAt = new Date(Date.now() + slaHours * HOUR).toISOString();
    if (r.status === 'received' || r.status === 'verifying') r.status = 'processing';
    r.timeline.push({ stage: 'processing', at: now, note: `Giao ${department}, hạn SLA ${slaHours} giờ` });
    r.updatedAt = now;
    await this.repos.reports.update(r);
    this.cache?.invalidateReports();
    await this.audit.log(this.actor(u), 'report.assign', r.id, before, snap(r));
    return toClientReport(r);
  }

  async setStatus(u: UserRecord, id: string, status: 'verifying' | 'processing'): Promise<ClientReport> {
    const r = await this.load(u, id);
    const order = ['received', 'verifying', 'processing'];
    if (!order.includes(r.status) || order.indexOf(status) <= order.indexOf(r.status)) {
      throw badRequest('Chuyển trạng thái không hợp lệ (chỉ được tiến lên từng chặng).', 'invalid_transition');
    }
    const before = snap(r);
    const now = new Date().toISOString();
    r.status = status;
    r.timeline.push({ stage: status, at: now, note: status === 'verifying' ? 'Cán bộ xác minh thông tin' : 'Bắt đầu xử lý' });
    r.updatedAt = now;
    await this.repos.reports.update(r);
    this.cache?.invalidateReports();
    await this.audit.log(this.actor(u), 'report.status', r.id, before, snap(r));
    return toClientReport(r);
  }

  async dispatch(u: UserRecord, id: string, wardCodes: string[] | undefined, units: Department[] | undefined, note: string): Promise<ClientReport> {
    const r = await this.load(u, id);
    if (r.status === 'resolved' || r.status === 'rejected') throw badRequest('Hồ sơ đã đóng, không thể phát lệnh chi viện.', 'invalid_state');
    const ward = WARD_BY_CODE[r.wardCode];
    const targets = wardCodes?.length ? wardCodes : ward.adjacentWardCodes;
    if (targets.some((c) => !WARD_BY_CODE[c] || c === r.wardCode)) throw badRequest('Danh sách xã/phường chi viện không hợp lệ.', 'invalid_ward');
    const before = snap(r);
    const now = new Date().toISOString();
    const order: DispatchOrder = {
      id: newId('dp'),
      fromWardCode: r.wardCode,
      toWardCodes: targets,
      units: units?.length ? units : [r.department ?? 'ubnd_khu_pho'],
      issuedAt: now,
      issuedBy: u.id,
      auto: false,
      note: note || 'Cán bộ phát lệnh chi viện liên phường/xã.',
    };
    r.dispatches.push(order);
    r.timeline.push({ stage: 'dispatched', at: now, note: `Chi viện sang ${targets.join(', ')}` });
    r.updatedAt = now;
    await this.repos.reports.update(r);
    this.cache?.invalidateReports();
    await this.audit.log(this.actor(u), 'dispatch.manual', r.id, before, { ...snap(r), order });
    return toClientReport(r);
  }

  async restore(u: UserRecord, id: string): Promise<ClientReport> {
    const r = await this.load(u, id);
    if (r.status !== 'quarantined') throw badRequest('Hồ sơ không nằm trong hàng đợi Cách ly.', 'invalid_state');
    const before = snap(r);
    const now = new Date().toISOString();
    r.status = 'received';
    r.quarantine = null;
    r.needsFieldVerification = false;
    r.timeline.push({ stage: 'received', at: now, note: 'Cán bộ khôi phục đơn (nhận diện nhầm)' });
    r.updatedAt = now;
    await this.repos.reports.update(r);
    this.cache?.invalidateReports();
    await this.audit.log(this.actor(u), 'report.restore', r.id, before, snap(r));
    return toClientReport(r);
  }

  async markSpam(u: UserRecord, id: string, reason: string): Promise<ClientReport> {
    const r = await this.load(u, id);
    if (r.status === 'resolved' || r.status === 'rejected') throw badRequest('Hồ sơ đã đóng.', 'invalid_state');
    const before = snap(r);
    const now = new Date().toISOString();
    r.status = 'rejected';
    r.timeline.push({ stage: 'quarantined', at: now, note: `Đánh dấu Spam / Tin giả. ${reason}`.trim() });
    r.updatedAt = now;
    await this.repos.reports.update(r);
    this.cache?.invalidateReports();
    await this.trust.penalizeSpam(r.reporterId);
    await this.audit.log(this.actor(u), 'report.mark_spam', r.id, before, { ...snap(r), reason });
    return toClientReport(r);
  }

  /** Nghiệm thu 4 bước Trước/Sau (Anti-Fake Forensics + Scene Match + Resolution Proof + Spatiotemporal GPS/EXIF). */
  async resolve(
    u: UserRecord,
    id: string,
    afterPhoto: PhotoInput,
    note: string,
    override: boolean,
    opts?: {
      lat?: number;
      lng?: number;
      edge?: EdgeStats;
      exif?: {
        capturedAt?: string | null;
        cameraMake?: string | null;
        cameraModel?: string | null;
        software?: string | null;
        gps?: { lat: number; lng: number; inBounds?: boolean } | null;
      } | null;
      allowTinyTestStub?: boolean;
    },
  ): Promise<{ report: ClientReport; accepted: boolean; resolutionStatus: 'AUTO_VERIFIED' | 'PENDING_MODERATION' | 'REJECTED' }> {
    const r = await this.load(u, id);
    if (r.status === 'resolved' || r.status === 'quarantined' || r.status === 'rejected') {
      throw badRequest('Không thể nghiệm thu ở trạng thái hiện tại.', 'invalid_state');
    }
    const before = r.photos[0];
    const a = extractStaffPhoto(afterPhoto);
    const b = await loadStoredPhotoForVerification(before);

    let afterLat = r.lat;
    let afterLng = r.lng;
    let explicitAfterCoords = false;
    if (typeof opts?.lat === 'number' && typeof opts?.lng === 'number') {
      afterLat = opts.lat;
      afterLng = opts.lng;
      explicitAfterCoords = true;
    } else if (opts?.exif?.gps) {
      afterLat = opts.exif.gps.lat;
      afterLng = opts.exif.gps.lng;
      explicitAfterCoords = true;
    }

    const verdict = b.isSvg
      ? this.gemini.fallbackVerify({
          reportId: r.id,
          beforeBase64: '',
          beforeMime: a.mime,
          beforeHash: before.dHash,
          afterBase64: a.base64,
          afterMime: a.mime,
          afterHash: afterPhoto.dHash,
          category: r.category,
          title: r.title,
          beforeLat: r.lat,
          beforeLng: r.lng,
          afterLat,
          afterLng,
          explicitAfterCoords,
          afterEdge: opts?.edge,
          afterExif: opts?.exif,
          reportCreatedAt: r.createdAt,
          allowTinyTestStub: opts?.allowTinyTestStub,
        })
      : await this.gemini.verifyResolution({
          reportId: r.id,
          beforeBase64: b.base64,
          beforeMime: b.mime,
          beforeHash: before.dHash,
          afterBase64: a.base64,
          afterMime: a.mime,
          afterHash: afterPhoto.dHash,
          category: r.category,
          title: r.title,
          beforeLat: r.lat,
          beforeLng: r.lng,
          afterLat,
          afterLng,
          explicitAfterCoords,
          afterEdge: opts?.edge,
          afterExif: opts?.exif,
          reportCreatedAt: r.createdAt,
          allowTinyTestStub: opts?.allowTinyTestStub,
        });

    const now = new Date().toISOString();
    const prev = snap(r);
    const finalStatus: 'AUTO_VERIFIED' | 'PENDING_MODERATION' | 'REJECTED' =
      override ? 'AUTO_VERIFIED' : verdict.resolutionStatus;

    r.resolutionStatus = finalStatus;
    r.resolution = {
      resolutionVerified: finalStatus === 'AUTO_VERIFIED',
      resolutionStatus: finalStatus,
      rejectedReasonCode: verdict.rejectedReasonCode,
      matchConfidence: verdict.matchConfidence,
      sceneMatchScore: verdict.sceneMatchScore,
      resolutionScore: verdict.resolutionScore,
      ssimScore: verdict.ssimScore,
      gpsDistanceMeters: verdict.gpsDistanceMeters,
      temporalValid: verdict.temporalValid,
      forensicPassed: verdict.forensicPassed,
      forensics: verdict.forensics,
      criteria: verdict.criteria,
      inlierKeypoints: verdict.inlierKeypoints,
      summary: verdict.summary,
      mode: verdict.mode,
      at: now,
    };
    r.afterExif = verdict.forensics?.exifSummary ?? null;
    r.afterPhoto = await persistStaffPhoto(this.media, afterPhoto, 'after', u.id, r.id);

    if (finalStatus === 'PENDING_MODERATION') {
      r.status = 'verifying';
      r.timeline.push({
        stage: 'verifying',
        at: now,
        note: `Ảnh hoàn thành đạt ${verdict.matchConfidence}% — chuyển Hàng đợi Kiểm duyệt Admin.`,
      });
      r.updatedAt = now;
      await this.repos.reports.update(r);
      this.cache?.invalidateReports();
      await this.audit.log(this.actor(u), 'report.resolve_pending_moderation', r.id, prev, {
        ...snap(r),
        resolution: r.resolution,
      });
      return { report: toClientReport(r), accepted: false, resolutionStatus: 'PENDING_MODERATION' };
    }

    if (finalStatus !== 'AUTO_VERIFIED') {
      r.timeline.push({ stage: 'processing', at: now, note: `Nghiệm thu KHÔNG đạt: ${verdict.summary}` });
      r.updatedAt = now;
      await this.repos.reports.update(r);
      this.cache?.invalidateReports();
      await this.audit.log(this.actor(u), 'report.resolve_rejected', r.id, prev, { ...snap(r), resolution: r.resolution });
      return { report: toClientReport(r), accepted: false, resolutionStatus: 'REJECTED' };
    }

    r.status = 'resolved';
    r.resolvedAt = now;
    r.timeline.push({
      stage: 'resolved',
      at: now,
      note: override && !verdict.resolutionVerified ? `Cán bộ nghiệm thu thủ công (ghi đè AI). ${note}` : `Đã khắc phục và nghiệm thu. ${note}`.trim(),
    });
    r.updatedAt = now;
    await this.repos.reports.update(r);
    this.cache?.invalidateReports();
    await this.audit.log(this.actor(u), override && !verdict.resolutionVerified ? 'report.resolve_override' : 'report.resolve', r.id, prev, {
      ...snap(r),
      resolution: r.resolution,
    });
    await Promise.all(r.contributors.map((c) => this.trust.notify(c.userId, `Hồ sơ ${r.code} "${r.title}" đã được khắc phục và nghiệm thu.`, r.code)));
    return { report: toClientReport(r), accepted: true, resolutionStatus: 'AUTO_VERIFIED' };
  }

  auditList(limit: number): Promise<AuditEntry[]> {
    return this.audit.list(limit);
  }

  async staffList(): Promise<UserProfile[]> {
    const [admins, officers, rescue] = await Promise.all([
      this.repos.users.list('admin'),
      this.repos.users.list('officer'),
      this.repos.users.list('rescue'),
    ]);
    return [...admins, ...officers, ...rescue].map(toProfile);
  }

  // ── Quản trị Người dùng 4 Vai trò Chuẩn (`ADMIN`, `OFFICER`, `RESCUE`, `CITIZEN`) ──
  async listUsers(actor: UserRecord, rawFilter: { role?: string; wardCode?: string; isActive?: boolean; q?: string }): Promise<UserProfile[]> {
    if (!isAdminRole(actor)) throw forbidden('Chỉ Quản trị viên (ADMIN) mới có quyền quản lý người dùng.');
    const filter: UserFilterQuery = {
      wardCode: rawFilter.wardCode || undefined,
      isActive: rawFilter.isActive,
      q: rawFilter.q,
    };
    if (rawFilter.role) {
      const parsed = normalizeRoleInput(rawFilter.role);
      if (!parsed) throw badRequest(`Vai trò lọc không hợp lệ: ${rawFilter.role}`, 'invalid_role');
      filter.role = parsed;
    }
    const rows = await this.repos.users.query(filter);
    return rows.map(toProfile);
  }

  async createUser(
    actor: UserRecord,
    input: {
      name: string;
      role: string;
      password?: string;
      email?: string | null;
      phone?: string | null;
      staffCode?: string | null;
      wardCode?: string | null;
      unitCode?: string | null;
    },
  ): Promise<UserProfile> {
    if (!isAdminRole(actor)) throw forbidden('Chỉ Quản trị viên (ADMIN) mới được tạo tài khoản.');
    const role = normalizeRoleInput(input.role);
    if (!role) throw badRequest('Vai trò không hợp lệ.', 'invalid_role');
    if (input.wardCode && !WARD_BY_CODE[input.wardCode]) {
      throw badRequest('Mã Phường/Xã không thuộc 95 ĐVHC Thành phố Đồng Nai.', 'invalid_ward');
    }

    const email = input.email ? normalizeEmail(input.email) : null;
    if (input.email && !email) throw badRequest('Địa chỉ Email không hợp lệ.', 'invalid_email');
    const phone = input.phone ? normalizePhone(input.phone) : null;
    if (input.phone && !phone) throw badRequest('Số điện thoại Việt Nam không hợp lệ (10 số bắt đầu bằng 0).', 'invalid_phone');

    const isStaffType = role === 'admin' || role === 'officer' || role === 'rescue';
    const prefix = role === 'admin' ? 'AD' : role === 'rescue' ? 'CUUHO' : 'CB';
    const staffCode = input.staffCode?.trim()
      ? input.staffCode.trim().toUpperCase()
      : isStaffType
        ? `${prefix}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
        : null;

    if (staffCode && (await this.repos.users.getByStaffCode(staffCode))) {
      throw badRequest(`Mã tài khoản ${staffCode} đã tồn tại.`, 'staff_exists');
    }
    if (email && (await this.repos.users.getByEmail(email))) {
      throw badRequest(`Email ${email} đã được sử dụng.`, 'email_exists');
    }
    if (phone && (await this.repos.users.getByPhone(phone))) {
      throw badRequest(`Số điện thoại ${phone} đã được sử dụng.`, 'phone_exists');
    }
    if (isStaffType) {
      if (!input.password) {
        throw badRequest('Tài khoản nội bộ (ADMIN / OFFICER / RESCUE) bắt buộc có mật khẩu mạnh.', 'password_required');
      }
      const pwCheck = validatePasswordStrength(input.password);
      if (!pwCheck.valid) {
        throw badRequest(pwCheck.reason ?? 'Mật khẩu chưa đạt chuẩn bảo mật.', 'weak_password');
      }
    } else if (input.password) {
      const pwCheck = validatePasswordStrength(input.password);
      if (!pwCheck.valid) {
        throw badRequest(pwCheck.reason ?? 'Mật khẩu chưa đạt chuẩn bảo mật.', 'weak_password');
      }
    }

    const rec: UserRecord = {
      id: newId('u'),
      role,
      name: input.name.trim(),
      phone,
      email,
      staffCode,
      passwordHash: input.password ? hashPassword(input.password) : null,
      wardCode: input.wardCode ?? null,
      unitCode: input.unitCode ?? null,
      createdAt: new Date().toISOString(),
      ...this.trust.newUserDefaults(),
      defaultWardCode: input.wardCode ?? null,
      trustScore: isStaffType ? 100 : 80,
    };
    await this.repos.users.save(rec);
    await this.audit.log(this.actor(actor), 'admin.user_create', rec.id, null, {
      role,
      roleCode: toRoleCode(role),
      staffCode: rec.staffCode,
      wardCode: rec.wardCode,
      email: rec.email,
    });
    return toProfile(rec);
  }

  async updateUser(
    actor: UserRecord,
    targetId: string,
    patch: {
      name?: string;
      role?: string;
      wardCode?: string | null;
      staffCode?: string | null;
      email?: string | null;
      phone?: string | null;
      isActive?: boolean;
      trustScore?: number;
    },
  ): Promise<UserProfile> {
    if (!isAdminRole(actor)) throw forbidden('Chỉ Quản trị viên (ADMIN) mới được chỉnh sửa tài khoản.');
    const target = await this.repos.users.get(targetId);
    if (!target) throw notFound('Không tìm thấy tài khoản người dùng.');
    target.role = normalizeRole(target.role);

    const before = {
      name: target.name,
      role: target.role,
      wardCode: target.wardCode,
      staffCode: target.staffCode,
      revoked: Boolean(target.revoked),
      trustScore: target.trustScore,
    };

    if (patch.role !== undefined) {
      const nextRole = normalizeRoleInput(patch.role);
      if (!nextRole) throw badRequest('Vai trò không hợp lệ.', 'invalid_role');
      if (target.id === actor.id && nextRole !== target.role) {
        throw badRequest('Không thể tự hạ quyền tài khoản đang đăng nhập.', 'cannot_demote_self');
      }
      target.role = nextRole;
    }

    if (patch.wardCode !== undefined) {
      if (patch.wardCode !== null && patch.wardCode !== '' && !WARD_BY_CODE[patch.wardCode]) {
        throw badRequest('Mã Phường/Xã không hợp lệ.', 'invalid_ward');
      }
      target.wardCode = patch.wardCode || null;
    }

    if (patch.name !== undefined) {
      const n = patch.name.trim();
      if (n.length < 2) throw badRequest('Họ tên tối thiểu 2 ký tự.');
      target.name = n;
    }
    if (patch.staffCode !== undefined) {
      const sc = patch.staffCode?.trim() ? patch.staffCode.trim().toUpperCase() : null;
      if (sc) {
        const dup = await this.repos.users.getByStaffCode(sc);
        if (dup && dup.id !== target.id) throw badRequest(`Mã tài khoản ${sc} đã tồn tại.`, 'staff_exists');
      }
      target.staffCode = sc;
    }
    if (patch.email !== undefined) {
      const em = patch.email?.trim() ? normalizeEmail(patch.email) : null;
      if (patch.email?.trim() && !em) throw badRequest('Email không hợp lệ.', 'invalid_email');
      if (em) {
        const dup = await this.repos.users.getByEmail(em);
        if (dup && dup.id !== target.id) throw badRequest(`Email ${em} đã tồn tại.`, 'email_exists');
      }
      target.email = em;
    }
    if (patch.phone !== undefined) {
      const ph = patch.phone?.trim() ? normalizePhone(patch.phone) : null;
      if (patch.phone?.trim() && !ph) throw badRequest('Số điện thoại không hợp lệ.', 'invalid_phone');
      if (ph) {
        const dup = await this.repos.users.getByPhone(ph);
        if (dup && dup.id !== target.id) throw badRequest(`SĐT ${ph} đã tồn tại.`, 'phone_exists');
      }
      target.phone = ph;
    }
    if (patch.trustScore !== undefined) {
      target.trustScore = Math.max(0, Math.min(100, Math.round(patch.trustScore)));
    }
    if (patch.isActive !== undefined) {
      if (!patch.isActive && target.id === actor.id) {
        throw badRequest('Không thể tự khóa tài khoản đang đăng nhập.', 'cannot_lock_self');
      }
      target.revoked = !patch.isActive;
    }

    const permissionChanged =
      before.role !== target.role ||
      before.wardCode !== target.wardCode ||
      Boolean(target.revoked);

    if (permissionChanged) {
      target.tokenVersion = (target.tokenVersion ?? 0) + 1;
      target.activeSessionId = null;
      await this.repos.sessions.revokeAllForUser(
        target.id,
        target.revoked ? 'ACCOUNT_LOCKED' : 'ROLE_CHANGED',
      );
      this.onSessionsInvalidated?.(target.id);
      notifySessionTerminated(target.id, {
        code: 'SESSION_REVOKED',
        message: target.revoked
          ? 'Tài khoản của bạn đã bị quản trị viên khóa.'
          : 'Quyền hạn tài khoản đã thay đổi — vui lòng đăng nhập lại.',
      });
    }

    await this.repos.users.save(target);
    await this.audit.log(this.actor(actor), 'admin.user_update', target.id, before, {
      name: target.name,
      role: target.role,
      wardCode: target.wardCode,
      staffCode: target.staffCode,
      revoked: Boolean(target.revoked),
      trustScore: target.trustScore,
    });
    return toProfile(target);
  }

  async resetUserPassword(actor: UserRecord, targetId: string, newPassword: string): Promise<{ ok: true }> {
    if (!isAdminRole(actor)) throw forbidden('Chỉ Quản trị viên (ADMIN) mới được đặt lại mật khẩu.');
    const pwCheck = validatePasswordStrength(newPassword);
    if (!pwCheck.valid) {
      throw badRequest(pwCheck.reason ?? 'Mật khẩu mới chưa đạt chuẩn an toàn.', 'weak_password');
    }
    const target = await this.repos.users.get(targetId);
    if (!target) throw notFound('Không tìm thấy tài khoản người dùng.');
    target.passwordHash = hashPassword(newPassword);
    target.tokenVersion = (target.tokenVersion ?? 0) + 1;
    target.activeSessionId = null;
    await this.repos.users.save(target);
    await this.repos.sessions.revokeAllForUser(target.id, 'PASSWORD_RESET_ADMIN');
    this.onSessionsInvalidated?.(target.id);
    notifySessionTerminated(target.id, {
      code: 'SESSION_REVOKED',
      message: 'Mật khẩu tài khoản vừa được quản trị viên đặt lại.',
    });
    await this.audit.log(this.actor(actor), 'admin.user_reset_password', target.id, null, {
      revokedSessions: true,
      tokenVersion: target.tokenVersion,
    });
    return { ok: true };
  }

  async deleteUser(actor: UserRecord, targetId: string): Promise<{ ok: true }> {
    if (!isAdminRole(actor)) throw forbidden('Chỉ Quản trị viên (ADMIN) mới được xóa tài khoản.');
    if (targetId === actor.id) {
      throw badRequest('Chặn an toàn: Không thể tự xóa chính tài khoản đang đăng nhập!', 'cannot_delete_self');
    }
    const target = await this.repos.users.get(targetId);
    if (!target) throw notFound('Không tìm thấy tài khoản người dùng.');
    await this.repos.sessions.revokeAllForUser(target.id, 'ACCOUNT_DELETED');
    this.onSessionsInvalidated?.(target.id);
    notifySessionTerminated(target.id, {
      code: 'SESSION_REVOKED',
      message: 'Tài khoản đã bị xóa khỏi hệ thống.',
    });
    await this.repos.users.delete(target.id);
    await this.audit.log(this.actor(actor), 'admin.user_delete', target.id, { role: target.role, name: target.name, staffCode: target.staffCode }, null);
    return { ok: true };
  }

  // ── Trung tâm Quản trị Phiên, Tin cậy, Kiểm toán & Hàng đợi Kiểm duyệt Thông minh ──
  async listSessions(
    actor: UserRecord,
    opts?: { userId?: string; includeRevoked?: boolean; limit?: number },
  ): Promise<SessionInfo[]> {
    if (!isAdminRole(actor)) throw forbidden('Chỉ Quản trị viên (ADMIN) mới xem được danh sách phiên.');
    const sessions = await this.repos.sessions.listActive({
      userId: opts?.userId,
      includeRevoked: opts?.includeRevoked ?? false,
      limit: opts?.limit ?? 200,
    });
    const users = await this.repos.users.list();
    const byUser = new Map(users.map((u) => [u.id, u]));
    return sessions.map((s) => {
      const u = byUser.get(s.userId);
      return {
        id: s.id,
        userId: s.userId,
        userName: u?.name ?? s.userId,
        role: u ? normalizeRole(u.role) : undefined,
        wardCode: u?.wardCode ?? null,
        deviceFingerprint: s.deviceFingerprint || 'web-browser',
        ip: s.ip || '0.0.0.0',
        userAgent: s.userAgent,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt ?? s.createdAt,
        expiresAt: s.expiresAt,
        isRevoked: Boolean(s.isRevoked || s.revokedAt !== null),
        revokedAt: s.revokedAt,
        revokedReason: s.revokedReason ?? null,
      };
    });
  }

  async revokeSessionById(actor: UserRecord, sessionId: string, ip?: string): Promise<{ ok: true }> {
    if (!isAdminRole(actor)) throw forbidden('Chỉ Quản trị viên (ADMIN) mới được thu hồi phiên.');
    const sess = await this.repos.sessions.get(sessionId);
    if (!sess) throw notFound('Không tìm thấy phiên đăng nhập.');
    await this.repos.sessions.revoke(sess.id, null, 'FORCE_LOGOUT');
    const target = await this.repos.users.get(sess.userId);
    if (target) {
      target.tokenVersion = (target.tokenVersion ?? 0) + 1;
      if (target.activeSessionId === sess.id) target.activeSessionId = null;
      await this.repos.users.save(target);
      this.onSessionsInvalidated?.(target.id);
      notifySessionTerminated(target.id, {
        targetSessionId: sess.id,
        code: 'SESSION_REVOKED',
        message: 'Phiên đăng nhập đã bị Quản trị viên thu hồi từ xa.',
      });
    }
    await this.audit.log(
      { ...this.actor(actor), ip },
      'admin.session_revoke',
      sess.userId,
      { sessionId: sess.id, ip: sess.ip },
      { revoked: true, reason: 'FORCE_LOGOUT' },
      ip,
    );
    return { ok: true };
  }

  async forceLogoutUser(actor: UserRecord, targetId: string, ip?: string): Promise<{ ok: true; revokedCount: number }> {
    if (!isAdminRole(actor)) throw forbidden('Chỉ Quản trị viên (ADMIN) mới được đăng xuất từ xa.');
    const target = await this.repos.users.get(targetId);
    if (!target) throw notFound('Không tìm thấy tài khoản.');
    target.tokenVersion = (target.tokenVersion ?? 0) + 1;
    target.activeSessionId = null;
    await this.repos.users.save(target);
    const revokedCount = await this.repos.sessions.revokeAllForUser(target.id, 'FORCE_LOGOUT');
    this.onSessionsInvalidated?.(target.id);
    notifySessionTerminated(target.id, {
      code: 'SESSION_REVOKED',
      message: 'Tài khoản đã bị Quản trị viên buộc đăng xuất từ xa.',
    });
    await this.audit.log(
      { ...this.actor(actor), ip },
      'admin.user_force_logout',
      target.id,
      null,
      { revokedCount, tokenVersion: target.tokenVersion },
      ip,
    );
    return { ok: true, revokedCount };
  }

  async forceLogoutAllSystem(
    actor: UserRecord,
    currentSessionId: string,
    ip?: string,
  ): Promise<{ ok: true; revokedCount: number }> {
    if (!isAdminRole(actor)) throw forbidden('Chỉ Quản trị viên (ADMIN) mới được thu hồi toàn hệ thống.');
    const revokedCount = await this.repos.sessions.revokeAllSystem(currentSessionId, 'FORCE_LOGOUT_SYSTEM');
    const allUsers = await this.repos.users.list();
    for (const u of allUsers) {
      if (u.id === actor.id) continue;
      if (u.activeSessionId) {
        u.tokenVersion = (u.tokenVersion ?? 0) + 1;
        u.activeSessionId = null;
        await this.repos.users.save(u);
      }
      this.onSessionsInvalidated?.(u.id);
    }
    notifyAllSessionsTerminated(
      currentSessionId,
      'SESSION_REVOKED',
      'Quản trị viên vừa thu hồi toàn bộ phiên đăng nhập trên hệ thống.',
    );
    await this.audit.log(
      { ...this.actor(actor), ip },
      'admin.system_force_logout_all',
      'system',
      null,
      { revokedCount, preservedSessionId: currentSessionId },
      ip,
    );
    return { ok: true, revokedCount };
  }

  async flagUserTrust(
    actor: UserRecord,
    targetId: string,
    input: { trustLevel: TrustLevel; reason: string; trustScore?: number },
    ip?: string,
  ): Promise<UserProfile> {
    if (!isAdminRole(actor)) throw forbidden('Chỉ Quản trị viên (ADMIN) mới được gắn cờ tín nhiệm.');
    const target = await this.repos.users.get(targetId);
    if (!target) throw notFound('Không tìm thấy tài khoản.');
    const before = {
      trustLevel: target.trustLevel ?? 'normal',
      trustScore: target.trustScore,
      violationCount: target.violationCount ?? 0,
    };
    target.trustLevel = input.trustLevel;
    if (input.trustScore !== undefined) {
      target.trustScore = Math.max(0, Math.min(100, Math.round(input.trustScore)));
    }
    if (input.trustLevel === 'flagged') {
      target.violationCount = (target.violationCount ?? 0) + 1;
    }
    await this.repos.users.save(target);
    await this.audit.log(
      { ...this.actor(actor), ip },
      'admin.user_trust_flag',
      target.id,
      before,
      { trustLevel: target.trustLevel, trustScore: target.trustScore, violationCount: target.violationCount, reason: input.reason },
      ip,
    );
    return toProfile(target);
  }

  async getUserViolations(
    actor: UserRecord,
    targetId: string,
  ): Promise<{ user: UserProfile; violations: UserViolationEntry[] }> {
    if (!isAdminRole(actor)) throw forbidden('Chỉ Quản trị viên (ADMIN) mới xem được lịch sử vi phạm.');
    const target = await this.repos.users.get(targetId);
    if (!target) throw notFound('Không tìm thấy tài khoản.');
    const [logs, reports] = await Promise.all([
      this.repos.audit.list(500),
      this.repos.reports.list({}),
    ]);
    const violations: UserViolationEntry[] = [];
    for (const r of reports) {
      if (r.reporterId === targetId && (r.status === 'quarantined' || r.status === 'rejected')) {
        violations.push({
          id: `rep_${r.id}`,
          action: r.status === 'quarantined' ? 'report.quarantined' : 'report.rejected',
          detail: r.quarantine?.detail ?? `Hồ sơ ${r.code}: ${r.title} (${r.status})`,
          reportId: r.id,
          at: r.updatedAt,
        });
      }
    }
    for (const e of logs) {
      if (
        (e.targetId === targetId || e.actorId === targetId) &&
        /(spam|reject|quarantine|trust_flag|reuse_detected|lock|revoke|blocked)/i.test(e.action)
      ) {
        violations.push({
          id: e.id,
          action: e.action,
          detail: typeof e.afterState === 'string' ? e.afterState : JSON.stringify(e.afterState ?? e.action),
          at: e.timestamp,
        });
      }
    }
    violations.sort((a, b) => b.at.localeCompare(a.at));
    return { user: toProfile(target), violations: violations.slice(0, 100) };
  }

  async auditListFiltered(filter: {
    limit?: number;
    action?: string;
    actorId?: string;
    targetId?: string;
    q?: string;
  }): Promise<AuditEntry[]> {
    const rows = await this.audit.list(Math.min(Math.max(filter.limit ?? 300, 1), 1000));
    const q = filter.q?.trim().toLowerCase();
    return rows.filter((e) => {
      if (filter.action && !e.action.toLowerCase().includes(filter.action.toLowerCase())) return false;
      if (filter.actorId && e.actorId !== filter.actorId) return false;
      if (filter.targetId && e.targetId !== filter.targetId) return false;
      if (q) {
        const hay = `${e.action} ${e.actorName} ${e.targetId} ${JSON.stringify(e.afterState ?? '')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  async auditExport(
    actor: UserRecord,
    filter: { action?: string; actorId?: string; targetId?: string; q?: string },
    format: 'csv' | 'json',
  ): Promise<{ body: string; contentType: string; filename: string }> {
    if (!isAdminRole(actor)) throw forbidden('Chỉ Quản trị viên (ADMIN) mới được xuất Audit Log.');
    const entries = await this.auditListFiltered({ ...filter, limit: 1000 });
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      return {
        body: JSON.stringify({ exportedAt: new Date().toISOString(), total: entries.length, entries }, null, 2),
        contentType: 'application/json; charset=utf-8',
        filename: `audit-logs-${stamp}.json`,
      };
    }
    const head = ['Seq', 'Thời gian', 'Actor ID', 'Người thao tác', 'Vai trò', 'Hành động', 'Mục tiêu', 'IP', 'Trước', 'Sau', 'Hash'];
    const lines = entries.map((e) =>
      [
        e.seq,
        e.timestamp,
        e.actorId,
        e.actorName,
        e.role,
        e.action,
        e.targetId,
        e.ip ?? '',
        JSON.stringify(e.beforeState ?? null),
        JSON.stringify(e.afterState ?? null),
        e.hash,
      ]
        .map(csvCell)
        .join(','),
    );
    return {
      body: `\uFEFF${[head.map(csvCell).join(','), ...lines].join('\r\n')}`,
      contentType: 'text/csv; charset=utf-8',
      filename: `audit-logs-${stamp}.csv`,
    };
  }

  async moderationQueue(
    u: UserRecord,
    scope: string,
  ): Promise<
    Array<{
      report: ClientReport;
      kind: 'report_intake' | 'resolution_proof';
      authenticityScore: number;
      forensicFlags: string[];
      evidenceSummary: string;
    }>
  > {
    const resolvedScope = this.resolveScope(u, scope);
    const rows = await this.scoped(resolvedScope);
    const items = rows.filter(
      (r) =>
        r.status === 'quarantined' ||
        r.resolutionStatus === 'PENDING_MODERATION' ||
        (r.ai?.moderationDecision === 'HUMAN_REVIEW' && r.status !== 'resolved' && r.status !== 'rejected'),
    );
    return items.map((r) => {
      const isResolution = r.resolutionStatus === 'PENDING_MODERATION';
      return {
        report: toClientReport(r),
        kind: isResolution ? ('resolution_proof' as const) : ('report_intake' as const),
        authenticityScore: isResolution
          ? (r.resolution?.matchConfidence ?? 0)
          : (r.ai?.authenticityScore ?? 0),
        forensicFlags: isResolution
          ? (r.resolution?.forensics?.flags ?? [])
          : [...(r.ai?.fraudFlags ?? []), ...(r.ai?.forensicFlags ?? [])],
        evidenceSummary: isResolution
          ? (r.resolution?.summary ?? 'Chờ Admin xác minh ảnh Trước/Sau')
          : (r.quarantine?.detail ?? r.ai?.officerReviewNotes ?? 'Điểm tin cậy trung bình — cần kiểm duyệt thủ công'),
      };
    });
  }

  async decideModeration(
    u: UserRecord,
    id: string,
    input: { decision: 'APPROVE' | 'REJECT'; note?: string },
    ip?: string,
  ): Promise<ClientReport> {
    const r = await this.load(u, id);
    const before = snap(r);
    const now = new Date().toISOString();
    const note = input.note?.trim() ?? '';

    if (r.resolutionStatus === 'PENDING_MODERATION') {
      if (input.decision === 'APPROVE') {
        r.resolutionStatus = 'AUTO_VERIFIED';
        if (r.resolution) r.resolution.resolutionVerified = true;
        r.status = 'resolved';
        r.resolvedAt = now;
        if (r.rescueMission) {
          r.rescueMission.status = 'completed';
          r.rescueMission.stageCode = 'RESOLVED';
          r.rescueMission.completedAt = now;
        }
        if (r.rescueStatus) r.rescueStatus = 'RESOLVED';
        r.timeline.push({ stage: 'resolved', at: now, note: `Admin duyệt hoàn thành thủ công. ${note}`.trim() });
        await this.trust.rewardVerified(r.reporterId);
        await this.trust.notify(r.reporterId, `Phản ánh ${r.code} đã được Admin xác nhận hoàn thành.`, r.code);
        await this.audit.log({ ...this.actor(u), ip }, 'moderation.resolution_approve', r.id, before, snap(r), ip);
      } else {
        r.resolutionStatus = 'REJECTED';
        if (r.resolution) r.resolution.resolutionVerified = false;
        r.afterPhoto = null;
        r.status = r.department ? 'processing' : 'verifying';
        if (r.rescueMission) r.rescueMission.status = 'in_progress';
        if (r.rescueStatus === 'RESOLVED') r.rescueStatus = 'IN_PROGRESS';
        r.timeline.push({ stage: 'processing', at: now, note: `Admin từ chối ảnh hoàn thành: ${note || 'Cần chụp lại ảnh hiện trường rõ hơn'}` });
        await this.audit.log({ ...this.actor(u), ip }, 'moderation.resolution_reject', r.id, before, { ...snap(r), note }, ip);
      }
    } else if (r.status === 'quarantined' || r.ai?.moderationDecision === 'HUMAN_REVIEW') {
      if (input.decision === 'APPROVE') {
        r.status = 'received';
        r.quarantine = null;
        r.needsFieldVerification = false;
        if (r.ai) r.ai.moderationDecision = 'AUTO_APPROVE';
        r.timeline.push({ stage: 'received', at: now, note: `Admin kiểm duyệt thông qua. ${note}`.trim() });
        await this.audit.log({ ...this.actor(u), ip }, 'moderation.report_approve', r.id, before, snap(r), ip);
      } else {
        r.status = 'rejected';
        if (r.ai) r.ai.moderationDecision = 'AUTO_REJECT';
        r.timeline.push({ stage: 'quarantined', at: now, note: `Admin từ chối sau kiểm duyệt: ${note || 'Không đạt kiểm định'}` });
        await this.trust.penalizeSpam(r.reporterId);
        await this.trust.notify(r.reporterId, `Phản ánh ${r.code} bị từ chối sau kiểm duyệt: ${note || 'Không hợp lệ'}.`, r.code);
        await this.audit.log({ ...this.actor(u), ip }, 'moderation.report_reject', r.id, before, { ...snap(r), note }, ip);
      }
    } else {
      throw badRequest('Hồ sơ không thuộc hàng đợi kiểm duyệt.', 'not_in_moderation');
    }

    r.updatedAt = now;
    await this.repos.reports.update(r);
    this.cache?.invalidateReports();
    return toClientReport(r);
  }

  // ── Backward-compatible Officer APIs (`/api/admin/staff`) ──────────────────
  async createOfficer(
    admin: UserRecord,
    input: { staffCode: string; name: string; password: string; wardCode?: string | null; email?: string },
  ): Promise<UserProfile> {
    return this.createUser(admin, {
      staffCode: input.staffCode,
      name: input.name,
      password: input.password,
      role: 'officer',
      wardCode: input.wardCode ?? null,
      email: input.email,
    });
  }

  async setStaffRevoked(admin: UserRecord, staffId: string, revoked: boolean): Promise<UserProfile> {
    if (!isAdminRole(admin)) throw forbidden('Chỉ Quản trị viên (ADMIN) mới được thu hồi tài khoản cán bộ.');
    if (staffId === admin.id) throw badRequest('Không thể tự thu hồi tài khoản của chính mình.');
    const target = await this.repos.users.get(staffId);
    if (!target) throw notFound('Không tìm thấy tài khoản cán bộ.');
    return this.updateUser(admin, staffId, { isActive: !revoked });
  }

  async transferWard(u: UserRecord, id: string, toWardCode: string, note: string): Promise<ClientReport> {
    const r = await this.load(u, id);
    const targetWard = WARD_BY_CODE[toWardCode];
    if (!targetWard) throw badRequest('Phường/Xã đích không hợp lệ.', 'invalid_ward');
    if (r.wardCode === targetWard.wardCode) throw badRequest('Hồ sơ đã thuộc Phường/Xã này.', 'same_ward');
    const prevWard = WARD_BY_CODE[r.wardCode]?.name ?? r.wardCode;
    const before = { wardCode: r.wardCode };
    const now = new Date().toISOString();
    r.wardCode = targetWard.wardCode;
    r.timeline.push({
      stage: 'dispatched',
      at: now,
      note: `Chuyển tuyến từ ${prevWard} sang ${targetWard.name}. ${note}`.trim(),
    });
    r.updatedAt = now;
    await this.repos.reports.update(r);
    this.cache?.invalidateReports();
    await this.audit.log(this.actor(u), 'report.transfer_ward', r.id, before, { wardCode: targetWard.wardCode, note });
    return toClientReport(r);
  }

  async export(u: UserRecord, scope: string, month: string, format: 'csv' | 'json'): Promise<{ body: string; contentType: string; filename: string }> {
    if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('Tháng phải có dạng YYYY-MM.');
    const rows = (await this.scoped(scope)).filter((r) => r.createdAt.startsWith(month)).map(toClientReport);
    await this.audit.log(this.actor(u), 'report.export', scope, null, { month, format, rows: rows.length });
    const name = `bao-cao-${scope.replace(':', '-')}-${month}`;
    if (format === 'json') {
      return {
        body: JSON.stringify(
          {
            scope,
            month,
            stats: computeStats(rows, scope),
            reports: rows.map(({ photos, afterPhoto, ...rest }) => {
              void photos;
              void afterPhoto;
              return rest;
            }),
          },
          null,
          2,
        ),
        contentType: 'application/json; charset=utf-8',
        filename: `${name}.json`,
      };
    }
    const head = ['Mã hồ sơ', 'Nhóm sự cố', 'Tiêu đề', 'Xã/Phường', 'Trạng thái', 'Ưu tiên', 'Ngày tạo', 'Ngày hoàn thành', 'Số ngày xử lý', 'Bộ phận', 'Số người cùng báo', 'Xác nhận'];
    const lines = rows.map((r) =>
      [
        r.code,
        r.category,
        r.title,
        WARD_BY_CODE[r.wardCode]?.name ?? r.wardCode,
        r.status,
        r.priority,
        r.createdAt,
        r.resolvedAt ?? '',
        r.resolvedAt ? Math.round(((Date.parse(r.resolvedAt) - Date.parse(r.createdAt)) / 86400000) * 10) / 10 : '',
        r.department ?? '',
        r.clusterCount,
        r.confirmCount,
      ]
        .map(csvCell)
        .join(','),
    );
    return { body: `\uFEFF${[head.map(csvCell).join(','), ...lines].join('\r\n')}`, contentType: 'text/csv; charset=utf-8', filename: `${name}.csv` };
  }

  async volunteerTasks(u: UserRecord): Promise<ClientReport[]> {
    const ward = u.wardCode ? WARD_BY_CODE[u.wardCode] : null;
    const wards = ward ? [ward.wardCode, ...ward.adjacentWardCodes] : undefined;
    const rows = await this.repos.reports.list({ wardCodes: wards });
    return rows
      .filter((r) => r.needsFieldVerification && (r.status === 'verifying' || r.status === 'quarantined') && !r.verification)
      .sort((a, b) => Number(b.seniorSubmitted) - Number(a.seniorSubmitted) || b.createdAt.localeCompare(a.createdAt))
      .map(toClientReport);
  }

  async acceptTask(u: UserRecord, id: string): Promise<ClientReport> {
    const r = await this.repos.reports.get(id);
    if (!r || !r.needsFieldVerification) throw notFound('Nhiệm vụ không tồn tại.');
    if (r.assignedVolunteerId && r.assignedVolunteerId !== u.id) {
      throw badRequest('Nhiệm vụ đã có tình nguyện viên khác tiếp nhận.', 'task_taken');
    }
    const before = { assignedVolunteerId: r.assignedVolunteerId };
    r.assignedVolunteerId = u.id;
    r.updatedAt = new Date().toISOString();
    await this.repos.reports.update(r);
    await this.audit.log(this.actor(u), 'volunteer.accept', r.id, before, { assignedVolunteerId: u.id });
    return toClientReport(r);
  }

  async verifyTask(u: UserRecord, id: string, verdict: 'true' | 'duplicate' | 'fake', note: string, photo: PhotoInput | undefined): Promise<ClientReport> {
    const r = await this.repos.reports.get(id);
    if (!r || !r.needsFieldVerification) throw notFound('Nhiệm vụ không tồn tại.');
    if (r.assignedVolunteerId !== u.id) throw forbidden('Hãy tiếp nhận nhiệm vụ trước khi gửi kết quả xác minh.');
    if (photo && !photo.buffer && photo.dataUrl) parsePhotoDataUrl(photo.dataUrl);
    const before = snap(r);
    const now = new Date().toISOString();
    r.verification = {
      verdict,
      note,
      volunteerId: u.id,
      volunteerName: u.name,
      at: now,
      photo: photo ? await persistStaffPhoto(this.media, photo, 'verify', u.id, r.id) : null,
    };
    r.needsFieldVerification = false;
    if (verdict === 'true') {
      r.status = 'processing';
      r.quarantine = null;
      r.priority = r.priority === 'emergency' ? 'emergency' : 'high';
      r.slaDueAt = new Date(Date.now() + slaHoursFor(r.priority) * HOUR).toISOString();
      r.timeline.push({ stage: 'verifying', at: now, note: `Tình nguyện viên xác minh: ĐÚNG sự thật — đẩy ưu tiên. ${note}`.trim() });
      await this.trust.rewardVerified(r.reporterId);
    } else if (verdict === 'duplicate') {
      r.status = 'rejected';
      r.timeline.push({ stage: 'quarantined', at: now, note: `Tình nguyện viên xác minh: trùng với hồ sơ khác. ${note}`.trim() });
    } else {
      r.status = 'rejected';
      r.timeline.push({ stage: 'quarantined', at: now, note: `Tình nguyện viên xác minh: tin báo giả. ${note}`.trim() });
      await this.trust.penalizeSpam(r.reporterId);
    }
    r.updatedAt = now;
    await this.repos.reports.update(r);
    this.cache?.invalidateReports();
    const me = await this.repos.users.get(u.id);
    if (me) {
      me.volunteerHours = Math.round((me.volunteerHours + 0.5) * 10) / 10;
      me.points += 10;
      await this.repos.users.save(me);
    }
    await this.audit.log(this.actor(u), 'volunteer.verify', r.id, before, { ...snap(r), verdict });
    return toClientReport(r);
  }

  async awardProxyCredit(u: UserRecord): Promise<void> {
    const me = await this.repos.users.get(u.id);
    if (!me) return;
    me.volunteerHours = Math.round((me.volunteerHours + 0.5) * 10) / 10;
    me.points += 15;
    if (!me.badges.includes('Hỗ trợ Cộng đồng')) me.badges.push('Hỗ trợ Cộng đồng');
    await this.repos.users.save(me);
  }

  async leaderboard(): Promise<{
    volunteers: Array<{ name: string; wardCode: string | null; unitCode: string | null; hours: number; points: number }>;
    wards: Array<{ wardCode: string; name: string; hours: number; points: number; members: number }>;
  }> {
    const vols = await this.repos.users.list('officer');
    const volunteers = vols
      .filter((v) => v.volunteerHours > 0 || v.points > 0)
      .map((v) => ({ name: v.name, wardCode: v.wardCode, unitCode: v.unitCode, hours: v.volunteerHours, points: v.points }))
      .sort((a, b) => b.points - a.points);
    const byWard = new Map<string, { hours: number; points: number; members: number }>();
    for (const v of vols) {
      if (!v.wardCode) continue;
      const e = byWard.get(v.wardCode) ?? { hours: 0, points: 0, members: 0 };
      e.hours += v.volunteerHours;
      e.points += v.points;
      e.members += 1;
      byWard.set(v.wardCode, e);
    }
    const wards = [...byWard.entries()]
      .map(([wardCode, e]) => ({ wardCode, name: WARD_BY_CODE[wardCode]?.name ?? wardCode, ...e }))
      .sort((a, b) => b.points - a.points);
    return { volunteers, wards };
  }

  async logbook(u: UserRecord): Promise<AuditEntry[]> {
    const all = await this.repos.audit.all();
    return all.filter((e) => e.actorId === u.id && e.action.startsWith('volunteer.')).reverse().slice(0, 50);
  }

  // ── Cổng Điều phối & Tác chiến Hiện trường Đội Cứu Hộ (`/api/rescue/...`) ──
  private enrichRescueItem(
    r: Report,
    teamCoords: { lat: number; lng: number } | null,
    reporter?: UserRecord | null,
  ): RescueMissionItem {
    const client = toClientReport(r);
    const priorityScore =
      client.priorityScore ??
      computeSosPriorityScore({
        severity: r.severity,
        isEmergency: r.isEmergency || r.emergencyLevel === 1,
        onArterial: r.onArterial,
        clusterCount: r.clusterCount,
        confirmCount: r.confirmations.length,
      });
    const severityLabel =
      client.severityLabel ?? toSeverityLabel(r.severity, r.isEmergency || r.emergencyLevel === 1);
    const tacticalBriefing =
      client.ai.tacticalBriefing ??
      this.gemini.deterministicTacticalBriefing({
        reportId: r.id,
        category: r.category,
        title: r.title,
        description: r.description,
        severity: r.severity,
        isEmergency: r.isEmergency || r.emergencyLevel === 1,
        wardCode: r.wardCode,
        address: r.address,
        roadName: r.roadName,
        onArterial: r.onArterial,
        safetyHazards: r.ai.safetyHazards,
      });

    const distanceKm = teamCoords
      ? Math.round((haversineMeters(teamCoords.lat, teamCoords.lng, r.lat, r.lng) / 1000) * 100) / 100
      : null;
    // Ước tính thời gian chạy xe thực tế (~1.26x khoảng cách chim bay, tốc độ đô thị 36 km/h)
    const etaMinutes =
      distanceKm !== null ? Math.max(1, Math.round(((distanceKm * 1.26) / 36) * 60 + 1)) : null;

    return {
      ...client,
      assignedRescueId: r.assignedRescueId ?? r.rescueMission?.assignedTeamId ?? null,
      assignedRescueName: r.assignedRescueName ?? r.rescueMission?.assignedTeamName ?? null,
      acceptedAt: r.acceptedAt ?? r.rescueMission?.acceptedAt ?? null,
      rescueStatus:
        r.rescueStatus ??
        (r.rescueMission?.stageCode && r.rescueMission.stageCode !== 'UNASSIGNED'
          ? r.rescueMission.stageCode
          : null) ??
        (r.status === 'resolved'
          ? 'RESOLVED'
          : r.dispatches.length > 0
            ? 'DISPATCHED'
            : r.status === 'verifying'
              ? 'VERIFIED'
              : 'PENDING'),
      priorityScore,
      severityLabel,
      ai: {
        ...client.ai,
        priorityScore,
        severityLabel,
        tacticalBriefing,
      },
      distanceKm,
      etaMinutes,
      reporterPhone: reporter?.phone ?? null,
      reporterName: reporter?.name ?? null,
    };
  }

  private isClaimedByAnyTeam(r: Report): boolean {
    if (r.status === 'resolved') return false;
    if (r.assignedRescueId) return true;
    if (
      r.rescueMission?.assignedTeamId &&
      r.rescueMission.status !== 'unassigned' &&
      r.rescueMission.status !== 'completed'
    ) {
      return true;
    }
    return false;
  }

  private isClaimedByUser(r: Report, userId: string): boolean {
    if (r.status === 'resolved') return false;
    if (r.assignedRescueId === userId) return true;
    if (
      r.rescueMission?.assignedTeamId === userId &&
      r.rescueMission.status !== 'unassigned' &&
      r.rescueMission.status !== 'completed'
    ) {
      return true;
    }
    return false;
  }

  async rescueMissions(
    u: UserRecord,
    opts: { lat?: number; lng?: number; radiusKm?: number; wardCode?: string; includeResolved?: boolean } = {},
  ): Promise<RescueMissionsResponse> {
    let teamCoords: { lat: number; lng: number } | null = null;
    if (opts.lat !== undefined && opts.lng !== undefined && Number.isFinite(opts.lat) && Number.isFinite(opts.lng)) {
      const norm = normalizeCoordinates({ lat: opts.lat, lng: opts.lng }, { requireVietnam: false });
      if (!norm.ok) throw badRequest(norm.message, 'invalid_coords');
      teamCoords = { lat: norm.lat, lng: norm.lng };
    } else if (u.wardCode && WARD_BY_CODE[u.wardCode]) {
      teamCoords = { lat: WARD_BY_CODE[u.wardCode].centerLat, lng: WARD_BY_CODE[u.wardCode].centerLng };
    }

    const radiusM = Math.min(200_000, Math.max(1_000, Math.round((opts.radiusKm ?? 80) * 1000)));
    let candidateReports: Report[];

    // Cán bộ gắn phường chỉ xem nhiệm vụ thuộc phường mình phụ trách; Cán bộ toàn TP, Đội cứu hộ & Admin cơ động liên phường
    const effectiveWardCode =
      normalizeRole(u.role) === 'officer' && u.wardCode ? u.wardCode : opts.wardCode;

    if (teamCoords && !effectiveWardCode) {
      const [nearRows, allRows] = await Promise.all([
        this.repos.reports.findNearby({ lat: teamCoords.lat, lng: teamCoords.lng, radiusM }),
        this.repos.reports.list({}),
      ]);
      const mergedMap = new Map<string, Report>();
      for (const r of nearRows) mergedMap.set(r.id, r);
      for (const r of allRows) {
        if (
          r.isEmergency ||
          r.emergencyLevel === 1 ||
          this.isClaimedByUser(r, u.id) ||
          (opts.includeResolved && r.status === 'resolved' && (r.assignedRescueId === u.id || r.rescueMission?.assignedTeamId === u.id))
        ) {
          mergedMap.set(r.id, r);
        }
      }
      candidateReports = [...mergedMap.values()];
    } else {
      const wardCodes = effectiveWardCode && WARD_BY_CODE[effectiveWardCode] ? [effectiveWardCode] : undefined;
      candidateReports = await this.repos.reports.list({ wardCodes });
    }

    const visible = candidateReports.filter((r) => {
      if (r.status === 'quarantined' || r.status === 'rejected') return false;
      if (!opts.includeResolved && r.status === 'resolved') return false;
      return true;
    });

    // Tải thông tin liên hệ người báo cho các đơn đang mở để đội cứu hộ gọi điện xác minh hiện trường (tel:)
    const reporterIds = [...new Set(visible.map((r) => r.reporterId).filter(Boolean))];
    const reporterEntries = await Promise.all(
      reporterIds.map(async (rid) => [rid, await this.repos.users.get(rid)] as const),
    );
    const reporterMap = new Map<string, UserRecord>();
    for (const [rid, rec] of reporterEntries) {
      if (rec) reporterMap.set(rid, rec);
    }

    let activeCandidate: Report | null = null;
    const availableRaw: Report[] = [];
    const resolvedRaw: Report[] = [];

    for (const r of visible) {
      if (r.status === 'resolved') {
        if (opts.includeResolved) resolvedRaw.push(r);
        continue;
      }
      if (this.isClaimedByUser(r, u.id)) {
        if (!activeCandidate || r.updatedAt.localeCompare(activeCandidate.updatedAt) > 0) {
          activeCandidate = r;
        }
        continue;
      }
      if (!this.isClaimedByAnyTeam(r)) {
        availableRaw.push(r);
      }
    }

    const activeMission = activeCandidate
      ? this.enrichRescueItem(activeCandidate, teamCoords, reporterMap.get(activeCandidate.reporterId))
      : null;

    const severityRank = (item: RescueMissionItem): number => {
      if (item.severityLabel === 'CRITICAL' || item.isEmergency || item.emergencyLevel === 1) return 3;
      if (item.severityLabel === 'HIGH' || item.priority === 'high') return 2;
      if (item.severityLabel === 'MEDIUM') return 1;
      return 0;
    };

    const availableMissions = availableRaw
      .map((r) => this.enrichRescueItem(r, teamCoords, reporterMap.get(r.reporterId)))
      .sort((a, b) => {
        const tierDiff = severityRank(b) - severityRank(a);
        if (tierDiff !== 0) return tierDiff;
        const distA = a.distanceKm ?? 999;
        const distB = b.distanceKm ?? 999;
        if (Math.abs(distA - distB) > 0.15) return distA - distB;
        return (b.priorityScore ?? 50) - (a.priorityScore ?? 50);
      });

    const resolvedMissions = resolvedRaw
      .map((r) => this.enrichRescueItem(r, teamCoords, reporterMap.get(r.reporterId)))
      .sort((a, b) => (b.resolvedAt ?? b.updatedAt).localeCompare(a.resolvedAt ?? a.updatedAt))
      .slice(0, 30);

    return {
      activeMission,
      availableMissions,
      resolvedMissions,
    };
  }

  /** Atomic Claim (Chống 2 đội nhận trùng cùng 1 đơn sự cố — trả 409 Conflict nếu đã có đội nhận trước). */
  async acceptRescueMission(
    u: UserRecord,
    id: string,
    lat?: number,
    lng?: number,
  ): Promise<RescueMissionItem> {
    const existingReport = await this.repos.reports.get(id);
    if (!existingReport) throw notFound('Không tìm thấy đơn sự cố.');
    assertScope(u, existingReport);

    if (existingReport.status === 'quarantined' || existingReport.status === 'rejected') {
      throw badRequest('Đơn sự cố này không ở trạng thái hợp lệ để tiếp nhận.', 'invalid_state');
    }
    if (existingReport.status === 'resolved') {
      throw conflict('Đơn sự cố này đã được đội khác tiếp nhận', 'mission_already_claimed');
    }

    // Kiểm tra nếu đội cứu hộ này đang có một nhiệm vụ khác chưa hoàn tất (1 tài xế/đội = 1 đơn active tại 1 thời điểm)
    if (normalizeRole(u.role) === 'rescue') {
      const openRows = await this.repos.reports.list({ statuses: ['received', 'verifying', 'processing'] });
      const otherActive = openRows.find((r) => r.id !== id && this.isClaimedByUser(r, u.id));
      if (otherActive) {
        throw conflict(
          `Đội của bạn đang thực hiện đơn ${otherActive.code}. Vui lòng hoàn thành hoặc trả đơn trước khi nhận đơn mới.`,
          'driver_busy',
        );
      }
    }

    let safeCoords: { lat: number; lng: number } | null = null;
    if (lat !== undefined && lng !== undefined && Number.isFinite(lat) && Number.isFinite(lng)) {
      const norm = normalizeCoordinates({ lat, lng }, { requireVietnam: false });
      if (norm.ok) safeCoords = { lat: norm.lat, lng: norm.lng };
    }

    const nowIso = new Date().toISOString();
    const claimed = await this.repos.reports.claimRescueMission(existingReport.id, {
      teamId: u.id,
      teamName: u.name,
      teamCode: u.staffCode,
      nowIso,
      lat: safeCoords?.lat ?? null,
      lng: safeCoords?.lng ?? null,
    });

    if (!claimed) {
      throw conflict('Đơn sự cố này đã được đội khác tiếp nhận', 'mission_already_claimed');
    }

    if (!claimed.department) {
      claimed.department = claimed.ai.suggestedDepartment ?? 'ubnd_khu_pho';
      await this.repos.reports.update(claimed);
    }

    await this.audit.log(
      this.actor(u),
      'rescue.accept',
      claimed.id,
      {
        status: existingReport.status,
        assignedRescueId: existingReport.assignedRescueId ?? null,
      },
      {
        status: claimed.status,
        rescueStatus: claimed.rescueStatus,
        assignedRescueId: claimed.assignedRescueId,
        acceptedAt: claimed.acceptedAt,
      },
    );

    await Promise.all(
      claimed.contributors.map((c) =>
        this.trust.notify(
          c.userId,
          `Đội Cứu Hộ (${u.name}) đã tiếp nhận sự cố ${claimed.code} và đang trên đường tới hiện trường.`,
          claimed.code,
        ),
      ),
    );

    this.cache?.invalidateReports();
    const reporter = await this.repos.users.get(claimed.reporterId);
    return this.enrichRescueItem(claimed, safeCoords, reporter);
  }

  /** Cho phép đội cứu hộ trả lại đơn về hàng chờ khi gặp sự cố bất khả kháng (bắt buộc có lý do, lưu lịch sử). */
  async releaseRescueMission(
    u: UserRecord,
    id: string,
    reason: string,
    lat?: number,
    lng?: number,
  ): Promise<RescueMissionItem> {
    const r = await this.load(u, id);
    if (r.status === 'resolved' || r.status === 'rejected' || r.status === 'quarantined') {
      throw badRequest('Không thể trả đơn ở trạng thái hiện tại.', 'invalid_state');
    }

    const ownerId = r.assignedRescueId ?? r.rescueMission?.assignedTeamId ?? null;
    if (!ownerId) {
      throw badRequest('Đơn sự cố này hiện chưa được đội nào tiếp nhận.', 'not_claimed');
    }
    if (ownerId !== u.id && !isAdminRole(u)) {
      throw forbidden('Bạn chỉ có thể trả lại đơn do chính đội của mình đang tiếp nhận.');
    }

    const cleanReason = reason.trim();
    if (cleanReason.length < 5) {
      throw badRequest('Vui lòng nhập lý do trả đơn rõ ràng (tối thiểu 5 ký tự).', 'reason_required');
    }

    let safeCoords: { lat: number; lng: number } | null = null;
    if (lat !== undefined && lng !== undefined && Number.isFinite(lat) && Number.isFinite(lng)) {
      const norm = normalizeCoordinates({ lat, lng }, { requireVietnam: false });
      if (norm.ok) safeCoords = { lat: norm.lat, lng: norm.lng };
    }

    const now = new Date().toISOString();
    const before = {
      status: r.status,
      rescueStatus: r.rescueStatus ?? null,
      assignedRescueId: ownerId,
      rescueMission: r.rescueMission ?? null,
    };

    const releaseEntry: RescueReleaseEntry = {
      teamId: u.id,
      teamName: u.name,
      teamCode: u.staffCode,
      reason: cleanReason,
      at: now,
    };
    const nextHistory = [...(r.rescueReleaseHistory ?? r.rescueMission?.releaseHistory ?? []), releaseEntry];
    const nextStage: RescueStageCode = r.dispatches.length > 0 ? 'DISPATCHED' : 'PENDING';

    r.status = r.dispatches.length > 0 ? 'processing' : 'received';
    r.rescueStatus = nextStage;
    r.assignedRescueId = null;
    r.assignedRescueName = null;
    r.acceptedAt = null;
    r.rescueLiveLocation = null;
    r.rescueReleaseHistory = nextHistory;
    r.rescueMission = {
      status: 'unassigned',
      stageCode: 'UNASSIGNED',
      assignedTeamId: null,
      assignedTeamName: null,
      assignedTeamCode: null,
      acceptedAt: null,
      enRouteAt: null,
      arrivedAt: null,
      inProgressAt: null,
      onSiteAt: null,
      completedAt: null,
      lastLat: safeCoords?.lat ?? null,
      lastLng: safeCoords?.lng ?? null,
      lastHeading: null,
      lastSpeedKmh: null,
      lastLocationUpdatedAt: null,
      note: `Đã trả đơn: ${cleanReason}`,
      releaseHistory: nextHistory,
    };
    r.timeline.push({
      stage: r.dispatches.length > 0 ? 'dispatched' : 'received',
      at: now,
      note: `[Đội Cứu Hộ ${u.staffCode ?? u.name}] Trả đơn về hàng chờ điều phối — Lý do: ${cleanReason}`,
    });
    r.updatedAt = now;

    await this.repos.reports.update(r);
    this.cache?.invalidateReports();
    await this.audit.log(this.actor(u), 'rescue.release', r.id, before, {
      status: r.status,
      rescueStatus: r.rescueStatus,
      releaseEntry,
    });

    const reporter = await this.repos.users.get(r.reporterId);
    return this.enrichRescueItem(r, safeCoords, reporter);
  }

  /** Cập nhật vị trí di chuyển thực tế của Đội Cứu Hộ (lat, lng, heading, speed) để Cán bộ & Người dân theo dõi ETA. */
  async updateRescueMissionLocation(
    u: UserRecord,
    id: string,
    lat: number,
    lng: number,
    heading: number | null,
    speed: number | null,
  ): Promise<{ ok: true; location: RescueLiveLocation; distanceKm: number; etaMinutes: number }> {
    const norm = normalizeCoordinates({ lat, lng }, { requireVietnam: false });
    if (!norm.ok) throw badRequest(norm.message, 'invalid_coords');

    const r = await this.load(u, id);
    if (r.status === 'resolved' || r.status === 'rejected' || r.status === 'quarantined') {
      throw badRequest('Đơn sự cố không còn ở trạng thái di chuyển.', 'invalid_state');
    }

    const ownerId = r.assignedRescueId ?? r.rescueMission?.assignedTeamId ?? null;
    if (ownerId && ownerId !== u.id && !isAdminRole(u)) {
      throw forbidden('Không thể cập nhật tọa độ cho nhiệm vụ của đội khác.');
    }

    const safeHeading =
      typeof heading === 'number' && Number.isFinite(heading) ? ((Math.round(heading) % 360) + 360) % 360 : null;
    const safeSpeedKmh =
      typeof speed === 'number' && Number.isFinite(speed) && speed >= 0
        ? Math.min(180, Math.round(speed * 10) / 10)
        : null;
    const now = new Date().toISOString();

    const liveLocation: RescueLiveLocation = {
      lat: norm.lat,
      lng: norm.lng,
      heading: safeHeading,
      speedKmh: safeSpeedKmh,
      updatedAt: now,
    };

    r.rescueLiveLocation = liveLocation;
    if (r.rescueMission) {
      r.rescueMission = {
        ...r.rescueMission,
        lastLat: norm.lat,
        lastLng: norm.lng,
        lastHeading: safeHeading,
        lastSpeedKmh: safeSpeedKmh,
        lastLocationUpdatedAt: now,
      };
    }
    r.updatedAt = now;
    await this.repos.reports.update(r);

    const distanceKm = Math.round((haversineMeters(norm.lat, norm.lng, r.lat, r.lng) / 1000) * 100) / 100;
    const effectiveSpeed = safeSpeedKmh && safeSpeedKmh >= 12 ? Math.min(60, safeSpeedKmh) : 36;
    const etaMinutes = Math.max(1, Math.round(((distanceKm * 1.24) / effectiveSpeed) * 60));

    return {
      ok: true,
      location: liveLocation,
      distanceKm,
      etaMinutes,
    };
  }

  async updateRescueMissionStatus(
    u: UserRecord,
    id: string,
    step: 'accepted' | 'en_route' | 'arrived' | 'in_progress' | 'on_site' | 'resolved',
    note: string,
    lat?: number,
    lng?: number,
    afterPhoto?: PhotoInput,
    override = false,
    edge?: EdgeStats,
    exif?: {
      capturedAt?: string | null;
      cameraMake?: string | null;
      cameraModel?: string | null;
      software?: string | null;
      gps?: { lat: number; lng: number; inBounds?: boolean } | null;
    } | null,
    allowTinyTestStub?: boolean,
  ): Promise<RescueMissionItem> {
    if (step === 'resolved' && afterPhoto) {
      const completed = await this.completeRescueMission(
        u,
        id,
        afterPhoto,
        note,
        override,
        edge,
        lat,
        lng,
        exif,
        allowTinyTestStub,
      );
      if (!completed.accepted && completed.resolutionStatus === 'REJECTED' && !override) {
        throw badRequest(
          completed.report.resolution?.summary ?? 'AI chưa xác nhận hiện trường đã khắc phục.',
          completed.report.resolution?.rejectedReasonCode ?? 'ai_verify_rejected',
        );
      }
      return completed.report;
    }

    const r = await this.load(u, id);
    if (r.status === 'resolved' || r.status === 'rejected' || r.status === 'quarantined') {
      throw badRequest('Hồ sơ không ở trạng thái có thể điều động hiện trường.', 'invalid_state');
    }
    const existing = r.rescueMission;
    const ownerId = r.assignedRescueId ?? existing?.assignedTeamId ?? null;
    if (
      ownerId &&
      ownerId !== u.id &&
      existing?.status !== 'unassigned' &&
      existing?.status !== 'completed' &&
      !isAdminRole(u)
    ) {
      throw conflict('Đơn sự cố này đã được đội khác tiếp nhận', 'mission_already_claimed');
    }

    let safeCoords: { lat: number; lng: number } | null = null;
    if (lat !== undefined && lng !== undefined && Number.isFinite(lat) && Number.isFinite(lng)) {
      const norm = normalizeCoordinates({ lat, lng }, { requireVietnam: false });
      if (norm.ok) safeCoords = { lat: norm.lat, lng: norm.lng };
    }

    const before = {
      status: r.status,
      rescueStatus: r.rescueStatus ?? null,
      assignedRescueId: r.assignedRescueId ?? null,
      rescueMission: r.rescueMission ?? null,
    };
    const now = new Date().toISOString();

    if (step === 'resolved') {
      r.status = 'resolved';
      r.resolvedAt = now;
      r.rescueStatus = 'RESOLVED';
      r.assignedRescueId = u.id;
      r.assignedRescueName = u.name;
      r.acceptedAt = r.acceptedAt ?? existing?.acceptedAt ?? now;
      r.rescueMission = {
        status: 'completed',
        stageCode: 'RESOLVED',
        assignedTeamId: u.id,
        assignedTeamName: u.name,
        assignedTeamCode: u.staffCode,
        acceptedAt: existing?.acceptedAt ?? r.acceptedAt ?? now,
        enRouteAt: existing?.enRouteAt ?? now,
        arrivedAt: existing?.arrivedAt ?? existing?.onSiteAt ?? now,
        inProgressAt: existing?.inProgressAt ?? now,
        onSiteAt: existing?.onSiteAt ?? existing?.arrivedAt ?? now,
        completedAt: now,
        lastLat: safeCoords?.lat ?? existing?.lastLat ?? r.lat,
        lastLng: safeCoords?.lng ?? existing?.lastLng ?? r.lng,
        lastHeading: existing?.lastHeading ?? null,
        lastSpeedKmh: 0,
        lastLocationUpdatedAt: now,
        note: note.trim() || existing?.note || '',
        releaseHistory: r.rescueReleaseHistory ?? existing?.releaseHistory ?? [],
      };
      if (!r.department) {
        r.department = r.ai.suggestedDepartment ?? 'ubnd_khu_pho';
      }
      r.timeline.push({
        stage: 'resolved',
        at: now,
        note: `[Đội Cứu Hộ ${u.staffCode ?? u.name}] Đã hoàn tất xử lý hiện trường.${note.trim() ? ` ${note.trim()}` : ''}`,
      });
      r.updatedAt = now;

      await this.repos.reports.update(r);
      this.cache?.invalidateReports();
      await this.audit.log(this.actor(u), 'rescue.resolved', r.id, before, {
        status: r.status,
        rescueStatus: r.rescueStatus,
        rescueMission: r.rescueMission,
      });
      await Promise.all(
        r.contributors.map((c) =>
          this.trust.notify(
            c.userId,
            `Đội Cứu Hộ đã xử lý hoàn tất sự cố ${r.code} "${r.title}" tại khu vực của bạn.`,
            r.code,
          ),
        ),
      );
      const reporter = await this.repos.users.get(r.reporterId);
      return this.enrichRescueItem(r, safeCoords, reporter);
    }

    const stageCodeMap: Record<'accepted' | 'en_route' | 'arrived' | 'in_progress' | 'on_site', RescueStageCode> = {
      accepted: 'EN_ROUTE',
      en_route: 'EN_ROUTE',
      arrived: 'ARRIVED',
      on_site: 'ARRIVED',
      in_progress: 'IN_PROGRESS',
    };
    const canonicalStage = stageCodeMap[step];
    const missionStatus: RescueMissionState['status'] =
      step === 'arrived' ? 'arrived' : step === 'in_progress' ? 'in_progress' : step === 'on_site' ? 'on_site' : step === 'accepted' ? 'accepted' : 'en_route';

    const nextMission: RescueMissionState = {
      status: missionStatus,
      stageCode: canonicalStage,
      assignedTeamId: u.id,
      assignedTeamName: u.name,
      assignedTeamCode: u.staffCode,
      acceptedAt: existing?.acceptedAt ?? r.acceptedAt ?? now,
      enRouteAt:
        canonicalStage === 'EN_ROUTE' || canonicalStage === 'ARRIVED' || canonicalStage === 'IN_PROGRESS'
          ? (existing?.enRouteAt ?? now)
          : (existing?.enRouteAt ?? null),
      arrivedAt:
        canonicalStage === 'ARRIVED' || canonicalStage === 'IN_PROGRESS'
          ? (existing?.arrivedAt ?? existing?.onSiteAt ?? now)
          : (existing?.arrivedAt ?? null),
      inProgressAt:
        canonicalStage === 'IN_PROGRESS'
          ? (existing?.inProgressAt ?? now)
          : (existing?.inProgressAt ?? null),
      onSiteAt:
        canonicalStage === 'ARRIVED' || canonicalStage === 'IN_PROGRESS'
          ? (existing?.onSiteAt ?? existing?.arrivedAt ?? now)
          : (existing?.onSiteAt ?? null),
      completedAt: null,
      lastLat: safeCoords?.lat ?? existing?.lastLat ?? null,
      lastLng: safeCoords?.lng ?? existing?.lastLng ?? null,
      lastHeading: existing?.lastHeading ?? null,
      lastSpeedKmh: existing?.lastSpeedKmh ?? null,
      lastLocationUpdatedAt: safeCoords ? now : (existing?.lastLocationUpdatedAt ?? null),
      note: note.trim() || existing?.note || '',
      releaseHistory: r.rescueReleaseHistory ?? existing?.releaseHistory ?? [],
    };

    r.assignedRescueId = u.id;
    r.assignedRescueName = u.name;
    r.acceptedAt = r.acceptedAt ?? nextMission.acceptedAt;
    r.rescueStatus = canonicalStage;
    r.rescueMission = nextMission;
    if (safeCoords) {
      r.rescueLiveLocation = {
        lat: safeCoords.lat,
        lng: safeCoords.lng,
        heading: r.rescueLiveLocation?.heading ?? null,
        speedKmh: canonicalStage === 'ARRIVED' || canonicalStage === 'IN_PROGRESS' ? 0 : (r.rescueLiveLocation?.speedKmh ?? null),
        updatedAt: now,
      };
    }
    if (r.status === 'received' || r.status === 'verifying') {
      r.status = 'processing';
    }
    if (!r.department) {
      r.department = r.ai.suggestedDepartment ?? 'ubnd_khu_pho';
    }

    const stepNoteMap: Record<'accepted' | 'en_route' | 'arrived' | 'in_progress' | 'on_site', string> = {
      accepted: `[Đội Cứu Hộ ${u.staffCode ?? u.name}] Đã nhận nhiệm vụ ứng cứu.`,
      en_route: `[Đội Cứu Hộ ${u.staffCode ?? u.name}] Đang cơ động di chuyển tới hiện trường.`,
      arrived: `[Đội Cứu Hộ ${u.staffCode ?? u.name}] Đã tới hiện trường sự cố.`,
      on_site: `[Đội Cứu Hộ ${u.staffCode ?? u.name}] Đã tới hiện trường sự cố.`,
      in_progress: `[Đội Cứu Hộ ${u.staffCode ?? u.name}] Đang triển khai xử lý sự cố tại hiện trường.`,
    };
    r.timeline.push({
      stage: 'processing',
      at: now,
      note: `${stepNoteMap[step]}${note.trim() ? ` ${note.trim()}` : ''}`,
    });
    r.updatedAt = now;

    await this.repos.reports.update(r);
    this.cache?.invalidateReports();
    await this.audit.log(this.actor(u), `rescue.${step}`, r.id, before, {
      status: r.status,
      rescueStatus: r.rescueStatus,
      rescueMission: r.rescueMission,
    });

    if (canonicalStage === 'ARRIVED') {
      await Promise.all(
        r.contributors.map((c) =>
          this.trust.notify(
            c.userId,
            `Đội Cứu Hộ (${u.name}) đã có mặt tại hiện trường sự cố ${r.code}.`,
            r.code,
          ),
        ),
      );
    }

    const reporter = await this.repos.users.get(r.reporterId);
    return this.enrichRescueItem(r, safeCoords, reporter);
  }

  async completeRescueMission(
    u: UserRecord,
    id: string,
    afterPhoto: PhotoInput,
    note: string,
    override: boolean,
    edge?: EdgeStats,
    lat?: number,
    lng?: number,
    exif?: {
      capturedAt?: string | null;
      cameraMake?: string | null;
      cameraModel?: string | null;
      software?: string | null;
      gps?: { lat: number; lng: number; inBounds?: boolean } | null;
    } | null,
    allowTinyTestStub?: boolean,
  ): Promise<{ report: RescueMissionItem; accepted: boolean; resolutionStatus: 'AUTO_VERIFIED' | 'PENDING_MODERATION' | 'REJECTED' }> {
    const r = await this.load(u, id);
    if (r.status === 'resolved' || r.status === 'quarantined' || r.status === 'rejected') {
      throw badRequest('Không thể hoàn tất nghiệm thu ở trạng thái hiện tại.', 'invalid_state');
    }
    const ownerId = r.assignedRescueId ?? r.rescueMission?.assignedTeamId ?? null;
    if (ownerId && ownerId !== u.id && !isAdminRole(u)) {
      throw conflict('Đơn sự cố này đã được đội khác tiếp nhận', 'mission_already_claimed');
    }

    let afterLat = r.lat;
    let afterLng = r.lng;
    let explicitAfterCoords = false;
    if (lat !== undefined && lng !== undefined && Number.isFinite(lat) && Number.isFinite(lng)) {
      const norm = normalizeCoordinates({ lat, lng }, { requireVietnam: false });
      if (norm.ok) {
        afterLat = norm.lat;
        afterLng = norm.lng;
        explicitAfterCoords = true;
      }
    } else if (exif?.gps) {
      afterLat = exif.gps.lat;
      afterLng = exif.gps.lng;
      explicitAfterCoords = true;
    }

    const before = r.photos[0];
    const a = extractStaffPhoto(afterPhoto);
    const b = await loadStoredPhotoForVerification(before);

    const verdict = b.isSvg
      ? this.gemini.fallbackVerify({
          reportId: r.id,
          beforeBase64: '',
          beforeMime: a.mime,
          beforeHash: before.dHash,
          afterBase64: a.base64,
          afterMime: a.mime,
          afterHash: afterPhoto.dHash,
          category: r.category,
          title: r.title,
          beforeLat: r.lat,
          beforeLng: r.lng,
          afterLat,
          afterLng,
          explicitAfterCoords,
          afterEdge: edge,
          afterExif: exif,
          reportCreatedAt: r.createdAt,
          allowTinyTestStub,
        })
      : await this.gemini.verifyResolution({
          reportId: r.id,
          beforeBase64: b.base64,
          beforeMime: b.mime,
          beforeHash: before.dHash,
          afterBase64: a.base64,
          afterMime: a.mime,
          afterHash: afterPhoto.dHash,
          category: r.category,
          title: r.title,
          beforeLat: r.lat,
          beforeLng: r.lng,
          afterLat,
          afterLng,
          explicitAfterCoords,
          afterEdge: edge,
          afterExif: exif,
          reportCreatedAt: r.createdAt,
          allowTinyTestStub,
        });

    const now = new Date().toISOString();
    const prev = snap(r);
    const finalStatus: 'AUTO_VERIFIED' | 'PENDING_MODERATION' | 'REJECTED' =
      override ? 'AUTO_VERIFIED' : verdict.resolutionStatus;

    r.resolutionStatus = finalStatus;
    r.resolution = {
      resolutionVerified: finalStatus === 'AUTO_VERIFIED',
      resolutionStatus: finalStatus,
      rejectedReasonCode: verdict.rejectedReasonCode,
      matchConfidence: verdict.matchConfidence,
      sceneMatchScore: verdict.sceneMatchScore,
      resolutionScore: verdict.resolutionScore,
      ssimScore: verdict.ssimScore,
      gpsDistanceMeters: verdict.gpsDistanceMeters,
      temporalValid: verdict.temporalValid,
      forensicPassed: verdict.forensicPassed,
      forensics: verdict.forensics,
      criteria: verdict.criteria,
      inlierKeypoints: verdict.inlierKeypoints,
      summary: verdict.summary,
      mode: verdict.mode,
      at: now,
    };
    r.afterExif = verdict.forensics?.exifSummary ?? null;
    r.afterPhoto = await persistStaffPhoto(this.media, afterPhoto, 'after', u.id, r.id);

    const reporter = await this.repos.users.get(r.reporterId);
    if (finalStatus === 'PENDING_MODERATION') {
      r.status = 'verifying';
      r.timeline.push({
        stage: 'verifying',
        at: now,
        note: `Ảnh hoàn thành đạt ${verdict.matchConfidence}% — chuyển Hàng đợi Kiểm duyệt để Admin xác nhận.`,
      });
      r.updatedAt = now;
      await this.repos.reports.update(r);
      this.cache?.invalidateReports();
      await this.audit.log(this.actor(u), 'rescue.complete_pending_moderation', r.id, prev, {
        ...snap(r),
        resolution: r.resolution,
      });
      return {
        report: this.enrichRescueItem(r, { lat: afterLat, lng: afterLng }, reporter),
        accepted: false,
        resolutionStatus: 'PENDING_MODERATION',
      };
    }

    if (finalStatus !== 'AUTO_VERIFIED') {
      r.timeline.push({
        stage: 'processing',
        at: now,
        note: `[AI Kiểm định Trước/Sau chưa đạt] ${verdict.summary}`,
      });
      r.updatedAt = now;
      await this.repos.reports.update(r);
      this.cache?.invalidateReports();
      await this.audit.log(this.actor(u), 'rescue.complete_rejected', r.id, prev, {
        ...snap(r),
        resolution: r.resolution,
      });
      return {
        report: this.enrichRescueItem(r, { lat: afterLat, lng: afterLng }, reporter),
        accepted: false,
        resolutionStatus: 'REJECTED',
      };
    }

    r.status = 'resolved';
    r.resolvedAt = now;
    r.rescueStatus = 'RESOLVED';
    r.assignedRescueId = u.id;
    r.assignedRescueName = u.name;
    r.acceptedAt = r.acceptedAt ?? r.rescueMission?.acceptedAt ?? now;
    r.rescueMission = {
      status: 'completed',
      stageCode: 'RESOLVED',
      assignedTeamId: u.id,
      assignedTeamName: u.name,
      assignedTeamCode: u.staffCode,
      acceptedAt: r.rescueMission?.acceptedAt ?? r.acceptedAt ?? now,
      enRouteAt: r.rescueMission?.enRouteAt ?? now,
      arrivedAt: r.rescueMission?.arrivedAt ?? r.rescueMission?.onSiteAt ?? now,
      inProgressAt: r.rescueMission?.inProgressAt ?? now,
      onSiteAt: r.rescueMission?.onSiteAt ?? r.rescueMission?.arrivedAt ?? now,
      completedAt: now,
      lastLat: afterLat,
      lastLng: afterLng,
      lastHeading: r.rescueMission?.lastHeading ?? null,
      lastSpeedKmh: 0,
      lastLocationUpdatedAt: now,
      note: note.trim() || r.rescueMission?.note || '',
      releaseHistory: r.rescueReleaseHistory ?? r.rescueMission?.releaseHistory ?? [],
    };
    r.timeline.push({
      stage: 'resolved',
      at: now,
      note: `[Đội Cứu Hộ ${u.staffCode ?? u.name}] Đã xử lý xong hiện trường & vượt qua kiểm định AI Trước/Sau.${
        note.trim() ? ` ${note.trim()}` : ''
      }`,
    });
    r.updatedAt = now;
    await this.repos.reports.update(r);
    this.cache?.invalidateReports();
    await this.audit.log(this.actor(u), 'rescue.complete', r.id, prev, {
      ...snap(r),
      resolution: r.resolution,
      rescueMission: r.rescueMission,
    });
    await Promise.all(
      r.contributors.map((c) =>
        this.trust.notify(
          c.userId,
          `Đội Cứu Hộ đã xử lý hoàn tất sự cố ${r.code} "${r.title}" tại khu vực của bạn.`,
          r.code,
        ),
      ),
    );
    return {
      report: this.enrichRescueItem(r, { lat: afterLat, lng: afterLng }, reporter),
      accepted: true,
      resolutionStatus: 'AUTO_VERIFIED',
    };
  }
}
