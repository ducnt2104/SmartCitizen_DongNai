import {
  computeSosPriorityScore,
  DEPARTMENTS,
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
  Report,
  RescueMissionState,
  Role,
  ScopeStats,
  UserProfile,
} from '../shared/types';
import type { Repositories, UserFilterQuery, UserRecord } from '../repositories/types';
import { badRequest, forbidden, notFound } from '../utils/errors';
import { hashPassword, newId } from '../utils/crypto';
import { assertScope, isAdminRole, parsePhotoDataUrl, type PhotoInput } from './access';
import type { AuditService } from './audit.service';
import type { EdgeStats, GeminiService } from './gemini.service';
import { slaHoursFor } from './report.service';
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

export class StaffService {
  constructor(
    private readonly repos: Repositories,
    private readonly gemini: GeminiService,
    private readonly trust: TrustService,
    private readonly audit: AuditService,
  ) {}

  private actor(u: UserRecord) {
    return { id: u.id, name: u.name, role: u.role };
  }

  /** Cán bộ phường bị ép về wardCode của mình; cấp TP & Super Admin chọn tự do. */
  resolveScope(u: UserRecord, requested: string | undefined): string {
    if (u.role === 'ward_officer') return `ward:${u.wardCode}`;
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
    await this.trust.penalizeSpam(r.reporterId);
    await this.audit.log(this.actor(u), 'report.mark_spam', r.id, before, { ...snap(r), reason });
    return toClientReport(r);
  }

  /** Nghiệm thu chống báo cáo khống bằng Rust CV Engine (CLAHE + ORB/RANSAC `scene_match_score` + `resolution_score`). */
  async resolve(u: UserRecord, id: string, afterPhoto: PhotoInput, note: string, override: boolean): Promise<{ report: ClientReport; accepted: boolean }> {
    const r = await this.load(u, id);
    if (r.status === 'resolved' || r.status === 'quarantined' || r.status === 'rejected') {
      throw badRequest('Không thể nghiệm thu ở trạng thái hiện tại.', 'invalid_state');
    }
    const before = r.photos[0];
    const a = parsePhotoDataUrl(afterPhoto.dataUrl);
    const svgBefore = before.url.startsWith('data:image/svg');
    const b = svgBefore ? { mime: a.mime, base64: '' } : parsePhotoDataUrl(before.url);

    const verdict = svgBefore
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
          afterLat: r.lat,
          afterLng: r.lng,
        });

    const now = new Date().toISOString();
    const prev = snap(r);
    r.resolution = {
      resolutionVerified: verdict.resolutionVerified,
      matchConfidence: verdict.matchConfidence,
      sceneMatchScore: verdict.sceneMatchScore,
      resolutionScore: verdict.resolutionScore,
      inlierKeypoints: verdict.inlierKeypoints,
      summary: verdict.summary,
      mode: verdict.mode,
      at: now,
    };
    r.afterPhoto = { id: newId('ph'), url: afterPhoto.dataUrl, dHash: afterPhoto.dHash, kind: 'after', takenBy: u.id, createdAt: now };

    const accepted = verdict.resolutionVerified || override;
    if (!accepted) {
      r.timeline.push({ stage: 'processing', at: now, note: `Nghiệm thu KHÔNG đạt: ${verdict.summary}` });
      r.updatedAt = now;
      await this.repos.reports.update(r);
      await this.audit.log(this.actor(u), 'report.resolve_rejected', r.id, prev, { ...snap(r), resolution: r.resolution });
      return { report: toClientReport(r), accepted: false };
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
    await this.audit.log(this.actor(u), override && !verdict.resolutionVerified ? 'report.resolve_override' : 'report.resolve', r.id, prev, {
      ...snap(r),
      resolution: r.resolution,
    });
    await Promise.all(r.contributors.map((c) => this.trust.notify(c.userId, `Hồ sơ ${r.code} "${r.title}" đã được khắc phục và nghiệm thu.`, r.code)));
    return { report: toClientReport(r), accepted: true };
  }

  auditList(limit: number): Promise<AuditEntry[]> {
    return this.audit.list(limit);
  }

  async staffList(): Promise<UserProfile[]> {
    const [s, b, a, r] = await Promise.all([
      this.repos.users.list('super_admin'),
      this.repos.users.list('city_admin'),
      this.repos.users.list('ward_officer'),
      this.repos.users.list('rescue_team'),
    ]);
    return [...s, ...b, ...a, ...r].map(toProfile);
  }

  // ── Super Admin & RBAC User CRUD (`/api/admin/users`) ──────────────────────
  async listUsers(actor: UserRecord, rawFilter: { role?: string; wardCode?: string; isActive?: boolean; q?: string }): Promise<UserProfile[]> {
    if (!isAdminRole(actor)) throw forbidden('Chỉ Super Admin / Admin mới có quyền quản lý người dùng.');
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
    if (!isAdminRole(actor)) throw forbidden('Chỉ Super Admin / Admin mới được tạo tài khoản.');
    const role = normalizeRoleInput(input.role);
    if (!role) throw badRequest('Vai trò không hợp lệ.', 'invalid_role');
    if ((role === 'super_admin' || role === 'city_admin') && actor.role !== 'super_admin') {
      throw forbidden('Chỉ SUPER_ADMIN mới được phép tạo tài khoản cấp Quản trị Thành phố hoặc Super Admin.');
    }
    if (role === 'ward_officer') {
      if (!input.wardCode || !WARD_BY_CODE[input.wardCode]) {
        throw badRequest('Cán bộ Phường/Xã (OFFICER) bắt buộc gắn với 1 mã Phường/Xã hợp lệ trong 95 ĐVHC Đồng Nai.', 'invalid_ward');
      }
    } else if (input.wardCode && !WARD_BY_CODE[input.wardCode]) {
      throw badRequest('Mã Phường/Xã không thuộc 95 ĐVHC Thành phố Đồng Nai.', 'invalid_ward');
    }

    const email = input.email ? normalizeEmail(input.email) : null;
    if (input.email && !email) throw badRequest('Địa chỉ Email không hợp lệ.', 'invalid_email');
    const phone = input.phone ? normalizePhone(input.phone) : null;
    if (input.phone && !phone) throw badRequest('Số điện thoại Việt Nam không hợp lệ (10 số bắt đầu bằng 0).', 'invalid_phone');

    const isStaffType =
      role === 'super_admin' || role === 'city_admin' || role === 'ward_officer' || role === 'rescue_team';
    const prefix =
      role === 'super_admin' ? 'SA' : role === 'city_admin' ? 'TP' : role === 'rescue_team' ? 'CUUHO' : 'CB';
    const staffCode = input.staffCode?.trim()
      ? input.staffCode.trim().toUpperCase()
      : isStaffType
        ? `${prefix}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
        : null;

    if (staffCode && (await this.repos.users.getByStaffCode(staffCode))) {
      throw badRequest(`Mã cán bộ ${staffCode} đã tồn tại.`, 'staff_exists');
    }
    if (email && (await this.repos.users.getByEmail(email))) {
      throw badRequest(`Email ${email} đã được sử dụng.`, 'email_exists');
    }
    if (phone && (await this.repos.users.getByPhone(phone))) {
      throw badRequest(`Số điện thoại ${phone} đã được sử dụng.`, 'phone_exists');
    }
    if (isStaffType && (!input.password || input.password.length < 8)) {
      throw badRequest('Tài khoản Quản trị / Cán bộ bắt buộc có mật khẩu tối thiểu 8 ký tự.', 'password_required');
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
    if (!isAdminRole(actor)) throw forbidden('Chỉ Super Admin / Admin mới được chỉnh sửa tài khoản.');
    const target = await this.repos.users.get(targetId);
    if (!target) throw notFound('Không tìm thấy tài khoản người dùng.');

    if ((target.role === 'super_admin' || target.role === 'city_admin') && actor.role !== 'super_admin' && target.id !== actor.id) {
      throw forbidden('Chỉ SUPER_ADMIN mới được sửa tài khoản cấp Quản trị Thành phố / Super Admin.');
    }

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
      if ((nextRole === 'super_admin' || nextRole === 'city_admin') && actor.role !== 'super_admin') {
        throw forbidden('Chỉ SUPER_ADMIN mới được gán quyền SUPER_ADMIN hoặc ADMIN.');
      }
      target.role = nextRole;
    }

    if (patch.wardCode !== undefined) {
      if (patch.wardCode !== null && patch.wardCode !== '' && !WARD_BY_CODE[patch.wardCode]) {
        throw badRequest('Mã Phường/Xã không hợp lệ.', 'invalid_ward');
      }
      target.wardCode = patch.wardCode || null;
    }
    if (target.role === 'ward_officer' && (!target.wardCode || !WARD_BY_CODE[target.wardCode])) {
      throw badRequest('Cán bộ Phường/Xã bắt buộc có mã Phường/Xã hợp lệ.', 'invalid_ward');
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
        if (dup && dup.id !== target.id) throw badRequest(`Mã cán bộ ${sc} đã tồn tại.`, 'staff_exists');
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
      if (target.revoked) {
        await this.repos.sessions.revokeAllForUser(target.id);
      }
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
    if (!isAdminRole(actor)) throw forbidden('Chỉ Super Admin / Admin mới được đặt lại mật khẩu.');
    if (newPassword.length < 8) throw badRequest('Mật khẩu mới tối thiểu 8 ký tự.');
    const target = await this.repos.users.get(targetId);
    if (!target) throw notFound('Không tìm thấy tài khoản người dùng.');
    if ((target.role === 'super_admin' || target.role === 'city_admin') && actor.role !== 'super_admin' && target.id !== actor.id) {
      throw forbidden('Chỉ SUPER_ADMIN mới được đặt lại mật khẩu cho quản trị viên khác.');
    }
    target.passwordHash = hashPassword(newPassword);
    await this.repos.users.save(target);
    await this.repos.sessions.revokeAllForUser(target.id);
    await this.audit.log(this.actor(actor), 'admin.user_reset_password', target.id, null, { revokedSessions: true });
    return { ok: true };
  }

  async deleteUser(actor: UserRecord, targetId: string): Promise<{ ok: true }> {
    if (!isAdminRole(actor)) throw forbidden('Chỉ Super Admin / Admin mới được xóa tài khoản.');
    if (targetId === actor.id) {
      throw badRequest('Chặn an toàn: Không thể tự xóa chính tài khoản Super Admin/Admin đang đăng nhập!', 'cannot_delete_self');
    }
    const target = await this.repos.users.get(targetId);
    if (!target) throw notFound('Không tìm thấy tài khoản người dùng.');
    if ((target.role === 'super_admin' || target.role === 'city_admin') && actor.role !== 'super_admin') {
      throw forbidden('Chỉ SUPER_ADMIN mới được phép xóa tài khoản Quản trị viên.');
    }
    await this.repos.sessions.revokeAllForUser(target.id);
    await this.repos.users.delete(target.id);
    await this.audit.log(this.actor(actor), 'admin.user_delete', target.id, { role: target.role, name: target.name, staffCode: target.staffCode }, null);
    return { ok: true };
  }

  // ── Backward-compatible Officer APIs (`/api/admin/staff`) ──────────────────
  async createOfficer(
    admin: UserRecord,
    input: { staffCode: string; name: string; password: string; wardCode: string; email?: string },
  ): Promise<UserProfile> {
    return this.createUser(admin, {
      staffCode: input.staffCode,
      name: input.name,
      password: input.password,
      role: 'ward_officer',
      wardCode: input.wardCode,
      email: input.email,
    });
  }

  async setStaffRevoked(admin: UserRecord, staffId: string, revoked: boolean): Promise<UserProfile> {
    if (!isAdminRole(admin)) throw forbidden('Chỉ Quản trị viên cấp Thành phố / Super Admin mới được thu hồi tài khoản cán bộ.');
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
    if (photo) parsePhotoDataUrl(photo.dataUrl);
    const before = snap(r);
    const now = new Date().toISOString();
    r.verification = {
      verdict,
      note,
      volunteerId: u.id,
      volunteerName: u.name,
      at: now,
      photo: photo ? { id: newId('ph'), url: photo.dataUrl, dHash: photo.dHash, kind: 'verify', takenBy: u.id, createdAt: now } : null,
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
    const vols = await this.repos.users.list('volunteer');
    const volunteers = vols
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
  async rescueMissions(
    u: UserRecord,
    opts: { lat?: number; lng?: number; radiusKm?: number; wardCode?: string; includeResolved?: boolean } = {},
  ): Promise<Array<ClientReport & { distanceKm: number | null; etaMinutes: number | null }>> {
    let teamCoords: { lat: number; lng: number } | null = null;
    if (opts.lat !== undefined && opts.lng !== undefined) {
      const norm = normalizeCoordinates({ lat: opts.lat, lng: opts.lng });
      if (!norm.ok) throw badRequest(norm.message, 'invalid_coords');
      teamCoords = { lat: norm.lat, lng: norm.lng };
    } else if (u.wardCode && WARD_BY_CODE[u.wardCode]) {
      teamCoords = { lat: WARD_BY_CODE[u.wardCode].centerLat, lng: WARD_BY_CODE[u.wardCode].centerLng };
    }

    const radiusM = Math.min(200_000, Math.max(1_000, Math.round((opts.radiusKm ?? 80) * 1000)));
    let candidateReports: Report[];

    // Cán bộ phường chỉ xem nhiệm vụ thuộc phường mình phụ trách; Đội cứu hộ & Admin cơ động liên phường
    const effectiveWardCode =
      u.role === 'ward_officer' ? (u.wardCode ?? opts.wardCode) : opts.wardCode;

    if (teamCoords && !effectiveWardCode) {
      // Ưu tiên truy vấn không gian $nearSphere trên 2dsphere index + gộp thêm sự cố SOS Khẩn cấp toàn thành phố
      const [nearRows, allRows] = await Promise.all([
        this.repos.reports.findNearby({ lat: teamCoords.lat, lng: teamCoords.lng, radiusM }),
        this.repos.reports.list({}),
      ]);
      const mergedMap = new Map<string, Report>();
      for (const r of nearRows) mergedMap.set(r.id, r);
      for (const r of allRows) {
        if (r.isEmergency || r.emergencyLevel === 1 || r.rescueMission?.assignedTeamId === u.id) {
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

    const enriched = visible.map((r) => {
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
      // Ước tính thời gian di chuyển đường bộ thực tế (~1.28x khoảng cách chim bay, tốc độ trung bình 38 km/h trong đô thị)
      const etaMinutes =
        distanceKm !== null ? Math.max(2, Math.round(((distanceKm * 1.28) / 38) * 60 + 1)) : null;

      return {
        ...client,
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
      };
    });

    enriched.sort((a, b) => {
      const aMine = a.rescueMission?.assignedTeamId === u.id && a.status !== 'resolved' ? 1 : 0;
      const bMine = b.rescueMission?.assignedTeamId === u.id && b.status !== 'resolved' ? 1 : 0;
      if (aMine !== bMine) return bMine - aMine;

      const aSos = a.severityLabel === 'CRITICAL' || a.isEmergency || a.emergencyLevel === 1 ? 1 : 0;
      const bSos = b.severityLabel === 'CRITICAL' || b.isEmergency || b.emergencyLevel === 1 ? 1 : 0;
      if (aSos !== bSos) return bSos - aSos;

      // Kết hợp điểm khẩn cấp AI (0..100) và ưu tiên khoảng cách gần nhất tới Đội Cứu Hộ
      const aRank = (a.priorityScore ?? 50) * 1.6 - Math.min(45, (a.distanceKm ?? 25) * 2.2);
      const bRank = (b.priorityScore ?? 50) * 1.6 - Math.min(45, (b.distanceKm ?? 25) * 2.2);
      return bRank - aRank;
    });

    return enriched;
  }

  async updateRescueMissionStatus(
    u: UserRecord,
    id: string,
    step: 'accepted' | 'en_route' | 'on_site' | 'resolved',
    note: string,
    lat?: number,
    lng?: number,
    afterPhoto?: PhotoInput,
    override = false,
    edge?: EdgeStats,
  ): Promise<ClientReport> {
    if (step === 'resolved' && afterPhoto) {
      const completed = await this.completeRescueMission(u, id, afterPhoto, note, override, edge, lat, lng);
      if (!completed.accepted && !override) {
        throw badRequest(
          completed.report.resolution?.summary ?? 'AI chưa xác nhận hiện trường đã khắc phục.',
          'ai_verify_rejected',
        );
      }
      return completed.report;
    }

    const r = await this.load(u, id);
    if (r.status === 'resolved' || r.status === 'rejected' || r.status === 'quarantined') {
      throw badRequest('Hồ sơ không ở trạng thái có thể điều động hiện trường.', 'invalid_state');
    }
    const existing = r.rescueMission;
    if (
      existing?.assignedTeamId &&
      existing.assignedTeamId !== u.id &&
      existing.status !== 'unassigned' &&
      existing.status !== 'completed' &&
      !isAdminRole(u)
    ) {
      throw badRequest(
        `Sự cố này đang được xử lý bởi ${existing.assignedTeamName ?? 'đội cứu hộ khác'}.`,
        'mission_taken',
      );
    }

    let safeCoords: { lat: number; lng: number } | null = null;
    if (lat !== undefined && lng !== undefined) {
      const norm = normalizeCoordinates({ lat, lng });
      if (norm.ok) safeCoords = { lat: norm.lat, lng: norm.lng };
    }

    const before = { status: r.status, rescueMission: r.rescueMission ?? null };
    const now = new Date().toISOString();

    if (step === 'resolved') {
      r.status = 'resolved';
      r.resolvedAt = now;
      r.rescueMission = {
        status: 'completed',
        assignedTeamId: u.id,
        assignedTeamName: u.name,
        assignedTeamCode: u.staffCode,
        acceptedAt: existing?.acceptedAt ?? now,
        enRouteAt: existing?.enRouteAt ?? now,
        onSiteAt: existing?.onSiteAt ?? now,
        completedAt: now,
        lastLat: safeCoords?.lat ?? existing?.lastLat ?? r.lat,
        lastLng: safeCoords?.lng ?? existing?.lastLng ?? r.lng,
        note: note.trim() || existing?.note || '',
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
      await this.audit.log(this.actor(u), 'rescue.resolved', r.id, before, {
        status: r.status,
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
      return toClientReport(r);
    }

    const nextMission: RescueMissionState = {
      status: step,
      assignedTeamId: u.id,
      assignedTeamName: u.name,
      assignedTeamCode: u.staffCode,
      acceptedAt: existing?.acceptedAt ?? now,
      enRouteAt: step === 'en_route' || step === 'on_site' ? (existing?.enRouteAt ?? now) : (existing?.enRouteAt ?? null),
      onSiteAt: step === 'on_site' ? (existing?.onSiteAt ?? now) : (existing?.onSiteAt ?? null),
      completedAt: null,
      lastLat: safeCoords?.lat ?? existing?.lastLat ?? null,
      lastLng: safeCoords?.lng ?? existing?.lastLng ?? null,
      note: note.trim() || existing?.note || '',
    };

    r.rescueMission = nextMission;
    if (r.status === 'received' || r.status === 'verifying') {
      r.status = 'processing';
    }
    if (!r.department) {
      r.department = r.ai.suggestedDepartment ?? 'ubnd_khu_pho';
    }

    const stepNoteMap: Record<'accepted' | 'en_route' | 'on_site', string> = {
      accepted: `[Đội Cứu Hộ ${u.staffCode ?? u.name}] Đã nhận nhiệm vụ ứng cứu.`,
      en_route: `[Đội Cứu Hộ ${u.staffCode ?? u.name}] Đang cơ động di chuyển tới hiện trường.`,
      on_site: `[Đội Cứu Hộ ${u.staffCode ?? u.name}] Đã tới hiện trường, bắt đầu xử lý sự cố.`,
    };
    r.timeline.push({
      stage: 'processing',
      at: now,
      note: `${stepNoteMap[step]}${note.trim() ? ` ${note.trim()}` : ''}`,
    });
    r.updatedAt = now;

    await this.repos.reports.update(r);
    await this.audit.log(this.actor(u), `rescue.${step}`, r.id, before, {
      status: r.status,
      rescueMission: r.rescueMission,
    });
    return toClientReport(r);
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
  ): Promise<{ report: ClientReport; accepted: boolean }> {
    const r = await this.load(u, id);
    if (r.status === 'resolved' || r.status === 'quarantined' || r.status === 'rejected') {
      throw badRequest('Không thể hoàn tất nghiệm thu ở trạng thái hiện tại.', 'invalid_state');
    }

    let afterLat = r.lat;
    let afterLng = r.lng;
    if (lat !== undefined && lng !== undefined) {
      const norm = normalizeCoordinates({ lat, lng });
      if (norm.ok) {
        afterLat = norm.lat;
        afterLng = norm.lng;
      }
    }

    const before = r.photos[0];
    const a = parsePhotoDataUrl(afterPhoto.dataUrl);
    const svgBefore = before.url.startsWith('data:image/svg');
    const b = svgBefore ? { mime: a.mime, base64: '' } : parsePhotoDataUrl(before.url);

    const verdict = svgBefore
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
          afterEdge: edge,
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
          afterEdge: edge,
        });

    const now = new Date().toISOString();
    const prev = snap(r);
    r.resolution = {
      resolutionVerified: verdict.resolutionVerified,
      matchConfidence: verdict.matchConfidence,
      sceneMatchScore: verdict.sceneMatchScore,
      resolutionScore: verdict.resolutionScore,
      inlierKeypoints: verdict.inlierKeypoints,
      summary: verdict.summary,
      mode: verdict.mode,
      at: now,
    };
    r.afterPhoto = {
      id: newId('ph'),
      url: afterPhoto.dataUrl,
      dHash: afterPhoto.dHash,
      kind: 'after',
      takenBy: u.id,
      createdAt: now,
    };

    const accepted = verdict.resolutionVerified || override;
    if (!accepted) {
      r.timeline.push({
        stage: 'processing',
        at: now,
        note: `[AI Kiểm định Trước/Sau chưa đạt] ${verdict.summary}`,
      });
      r.updatedAt = now;
      await this.repos.reports.update(r);
      await this.audit.log(this.actor(u), 'rescue.complete_rejected', r.id, prev, {
        ...snap(r),
        resolution: r.resolution,
      });
      return { report: toClientReport(r), accepted: false };
    }

    r.status = 'resolved';
    r.resolvedAt = now;
    r.rescueMission = {
      status: 'completed',
      assignedTeamId: u.id,
      assignedTeamName: u.name,
      assignedTeamCode: u.staffCode,
      acceptedAt: r.rescueMission?.acceptedAt ?? now,
      enRouteAt: r.rescueMission?.enRouteAt ?? now,
      onSiteAt: r.rescueMission?.onSiteAt ?? now,
      completedAt: now,
      lastLat: afterLat,
      lastLng: afterLng,
      note: note.trim() || r.rescueMission?.note || '',
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
    return { report: toClientReport(r), accepted: true };
  }
}
