import { DEPARTMENTS } from '../shared/constants';
import { DONG_NAI_WARDS, WARD_BY_CODE } from '../shared/dongNaiWards';
import { computeStats, toClientReport } from '../shared/report';
import type {
  AuditEntry, Category, ClientReport, Department, DispatchOrder, Report, ScopeStats, UserProfile,
} from '../shared/types';
import type { Repositories, UserRecord } from '../repositories/types';
import { badRequest, forbidden, notFound } from '../utils/errors';
import { hashPassword, newId } from '../utils/crypto';
import { assertScope, inScope, parsePhotoDataUrl, type PhotoInput } from './access';
import type { AuditService } from './audit.service';
import type { GeminiService } from './gemini.service';
import { slaHoursFor } from './report.service';
import { toProfile, type TrustService } from './trust.service';

export type QueueTab = 'emergency' | 'high' | 'open' | 'quarantine';
const HOUR = 3600000;

const snap = (r: Report) => ({
  status: r.status, priority: r.priority, department: r.department, slaDueAt: r.slaDueAt,
  quarantine: r.quarantine?.reason ?? null, dispatches: r.dispatches.length, resolvedAt: r.resolvedAt,
});

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // chống CSV/Formula injection
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

  /** Cán bộ phường bị ép về wardCode của mình; cấp TP chọn tự do. */
  resolveScope(u: UserRecord, requested: string | undefined): string {
    if (u.role === 'ward_officer') return `ward:${u.wardCode}`;
    if (!requested || requested === 'city') return 'city';
    if (!/^ward:DN-[A-Z]{2,4}$/.test(requested) || !WARD_BY_CODE[requested.slice(5)]) throw badRequest('Phạm vi không hợp lệ.', 'invalid_scope');
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

  // ── Dashboard ──────────────────────────────────────────────────────────────
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
    const trend = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([date, e]) => ({ date, avgDays: Math.round((e.sum / e.n) * 10) / 10, resolved: e.n }));
    const ranking = u.role === 'city_admin'
      ? DONG_NAI_WARDS.map((w) => {
          const s = computeStats(rows.filter((r) => r.wardCode === w.wardCode), w.wardCode);
          return { wardCode: w.wardCode, name: w.name, total: s.total, resolved: s.resolved, avgDays: s.avgDays };
        }).filter((x) => x.total > 0).sort((a, b) => a.avgDays - b.avgDays)
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

  // ── Điều phối ──────────────────────────────────────────────────────────────
  async assign(u: UserRecord, id: string, department: Department, slaHours: number): Promise<ClientReport> {
    const r = await this.load(u, id);
    if (r.status === 'resolved' || r.status === 'quarantined' || r.status === 'rejected') throw badRequest('Không thể giao việc ở trạng thái hiện tại.', 'invalid_state');
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
      id: newId('dp'), fromWardCode: r.wardCode, toWardCodes: targets,
      units: units?.length ? units : [r.department ?? 'ubnd_khu_pho'], issuedAt: now, issuedBy: u.id, auto: false,
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

  /** Nghiệm thu chống báo cáo khống: AI so ảnh Trước/Sau trước khi cho phép đóng hồ sơ. */
  async resolve(u: UserRecord, id: string, afterPhoto: PhotoInput, note: string, override: boolean): Promise<{ report: ClientReport; accepted: boolean }> {
    const r = await this.load(u, id);
    if (r.status === 'resolved' || r.status === 'quarantined' || r.status === 'rejected') throw badRequest('Không thể nghiệm thu ở trạng thái hiện tại.', 'invalid_state');
    const before = r.photos[0];
    const a = parsePhotoDataUrl(afterPhoto.dataUrl);
    const b = parsePhotoDataUrl(before.url.startsWith('data:image/svg') ? afterPhoto.dataUrl : before.url);
    const svgBefore = before.url.startsWith('data:image/svg');
    const verdict = svgBefore
      ? this.gemini.fallbackVerify({ beforeBase64: '', beforeMime: a.mime, beforeHash: before.dHash, afterBase64: a.base64, afterMime: a.mime, afterHash: afterPhoto.dHash, category: r.category, title: r.title })
      : await this.gemini.verifyResolution({ beforeBase64: b.base64, beforeMime: b.mime, beforeHash: before.dHash, afterBase64: a.base64, afterMime: a.mime, afterHash: afterPhoto.dHash, category: r.category, title: r.title });
    const now = new Date().toISOString();
    const prev = snap(r);
    r.resolution = { resolutionVerified: verdict.resolutionVerified, matchConfidence: verdict.matchConfidence, summary: verdict.summary, mode: verdict.mode, at: now };
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
    r.timeline.push({ stage: 'resolved', at: now, note: override && !verdict.resolutionVerified ? `Cán bộ nghiệm thu thủ công (ghi đè AI). ${note}` : `Đã khắc phục và nghiệm thu. ${note}`.trim() });
    r.updatedAt = now;
    await this.repos.reports.update(r);
    await this.audit.log(this.actor(u), override && !verdict.resolutionVerified ? 'report.resolve_override' : 'report.resolve', r.id, prev, { ...snap(r), resolution: r.resolution });
    // Thông báo hàng loạt cho toàn bộ người dân trong cụm
    await Promise.all(r.contributors.map((c) => this.trust.notify(c.userId, `Hồ sơ ${r.code} "${r.title}" đã được khắc phục và nghiệm thu.`, r.code)));
    return { report: toClientReport(r), accepted: true };
  }

  // ── Audit / Export / Staff ────────────────────────────────────────────────
  auditList(limit: number): Promise<AuditEntry[]> {
    return this.audit.list(limit);
  }

  async staffList(): Promise<UserProfile[]> {
    const [a, b] = await Promise.all([this.repos.users.list('ward_officer'), this.repos.users.list('city_admin')]);
    return [...b, ...a].map(toProfile);
  }

  /** Cấp tài khoản Cán bộ Phường/Xã mới (chỉ city_admin — mô hình RBAC 2 cấp). */
  async createOfficer(
    admin: UserRecord,
    input: { staffCode: string; name: string; password: string; wardCode: string; email?: string },
  ): Promise<UserProfile> {
    if (admin.role !== 'city_admin') throw forbidden('Chỉ Quản trị viên cấp Thành phố mới được cấp tài khoản cán bộ.');
    const ward = WARD_BY_CODE[input.wardCode];
    if (!ward) throw badRequest('Phường/Xã phân công không thuộc 95 ĐVHC Thành phố Đồng Nai.', 'invalid_ward');
    const code = input.staffCode.trim().toUpperCase();
    const existing = await this.repos.users.getByStaffCode(code);
    if (existing) throw badRequest(`Mã cán bộ ${code} đã tồn tại.`, 'staff_exists');
    const record: UserRecord = {
      id: newId('u_staff'),
      role: 'ward_officer',
      name: input.name.trim(),
      phone: null,
      email: input.email ? input.email.trim().toLowerCase() : null,
      staffCode: code,
      passwordHash: hashPassword(input.password),
      wardCode: ward.wardCode,
      unitCode: null,
      createdAt: new Date().toISOString(),
      ...this.trust.newUserDefaults(),
      trustScore: 100,
    };
    await this.repos.users.save(record);
    await this.audit.log(this.actor(admin), 'staff.create', record.id, null, { staffCode: code, wardCode: ward.wardCode, name: record.name });
    return toProfile(record);
  }

  /** Thu hồi / khôi phục quyền tài khoản cán bộ (đồng thời thu hồi mọi phiên đăng nhập đang mở). */
  async setStaffRevoked(admin: UserRecord, staffId: string, revoked: boolean): Promise<UserProfile> {
    if (admin.role !== 'city_admin') throw forbidden('Chỉ Quản trị viên cấp Thành phố mới được thu hồi tài khoản cán bộ.');
    if (staffId === admin.id) throw badRequest('Không thể tự thu hồi tài khoản của chính mình.');
    const target = await this.repos.users.get(staffId);
    if (!target || (target.role !== 'ward_officer' && target.role !== 'city_admin')) {
      throw notFound('Không tìm thấy tài khoản cán bộ.');
    }
    const before = { revoked: Boolean(target.revoked) };
    target.revoked = revoked;
    await this.repos.users.save(target);
    if (revoked) await this.repos.sessions.revokeAllForUser(target.id);
    await this.audit.log(this.actor(admin), revoked ? 'staff.revoke' : 'staff.reinstate', target.id, before, { revoked });
    return toProfile(target);
  }

  /** Điều phối chuyển tuyến khi phản ánh bị gửi nhầm Phường/Xã sang đúng ĐVHC trong 95 Phường/Xã. */
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
      return { body: JSON.stringify({ scope, month, stats: computeStats(rows, scope), reports: rows.map(({ photos, afterPhoto, ...rest }) => { void photos; void afterPhoto; return rest; }) }, null, 2), contentType: 'application/json; charset=utf-8', filename: `${name}.json` };
    }
    const head = ['Mã hồ sơ', 'Nhóm sự cố', 'Tiêu đề', 'Xã/Phường', 'Trạng thái', 'Ưu tiên', 'Ngày tạo', 'Ngày hoàn thành', 'Số ngày xử lý', 'Bộ phận', 'Số người cùng báo', 'Xác nhận'];
    const lines = rows.map((r) => [
      r.code, r.category, r.title, WARD_BY_CODE[r.wardCode]?.name ?? r.wardCode, r.status, r.priority, r.createdAt, r.resolvedAt ?? '',
      r.resolvedAt ? Math.round(((Date.parse(r.resolvedAt) - Date.parse(r.createdAt)) / 86400000) * 10) / 10 : '',
      r.department ?? '', r.clusterCount, r.confirmCount,
    ].map(csvCell).join(','));
    return { body: `\uFEFF${[head.map(csvCell).join(','), ...lines].join('\r\n')}`, contentType: 'text/csv; charset=utf-8', filename: `${name}.csv` };
  }

  // ── Tình nguyện viên ───────────────────────────────────────────────────────
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
    if (r.assignedVolunteerId && r.assignedVolunteerId !== u.id) throw badRequest('Nhiệm vụ đã có tình nguyện viên khác tiếp nhận.', 'task_taken');
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
      verdict, note, volunteerId: u.id, volunteerName: u.name, at: now,
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
    const volunteers = vols.map((v) => ({ name: v.name, wardCode: v.wardCode, unitCode: v.unitCode, hours: v.volunteerHours, points: v.points }))
      .sort((a, b) => b.points - a.points);
    const byWard = new Map<string, { hours: number; points: number; members: number }>();
    for (const v of vols) {
      if (!v.wardCode) continue;
      const e = byWard.get(v.wardCode) ?? { hours: 0, points: 0, members: 0 };
      e.hours += v.volunteerHours; e.points += v.points; e.members += 1;
      byWard.set(v.wardCode, e);
    }
    const wards = [...byWard.entries()].map(([wardCode, e]) => ({ wardCode, name: WARD_BY_CODE[wardCode]?.name ?? wardCode, ...e }))
      .sort((a, b) => b.points - a.points);
    return { volunteers, wards };
  }

  async logbook(u: UserRecord): Promise<AuditEntry[]> {
    const all = await this.repos.audit.all();
    return all.filter((e) => e.actorId === u.id && e.action.startsWith('volunteer.')).reverse().slice(0, 50);
  }
}
