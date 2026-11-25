import {
  CLUSTER_RADIUS_M, DEPARTMENT_BY_CATEGORY, DUPLICATE_WINDOW_MS, GPS_WARN_M, normalizeCategoryInput,
} from '../shared/constants';
import { hammingDistance } from '../shared/dhash';
import { WARD_BY_CODE } from '../shared/dongNaiWards';
import { haversineMeters, inDongNaiBBox, matchArterial, maskPhone, nearestWard } from '../shared/geo';
import { computeStats, toClientReport, toReportSummary } from '../shared/report';
import type {
  Category, ClientReport, Department, DispatchOrder, PaginatedReports, Photo, Report, ReportStatus, ReportSummary, ScopeStats, TimelineEvent,
} from '../shared/types';
import type { BoundingBoxQuery, Repositories, UserRecord } from '../repositories/types';
import { env } from '../config/env';
import type { CreateReportInput } from '../validation/schemas';
import { badRequest, forbidden, notFound, tooMany } from '../utils/errors';
import { newId } from '../utils/crypto';
import { canSee, isOwner, parsePhotoDataUrl, type PhotoInput } from './access';
import { SYSTEM_ACTOR, type AuditService } from './audit.service';
import type { CvEngineService } from './cvEngine.service';
import type { GeminiService } from './gemini.service';
import { decideTriage, type KnownReport } from './triage.service';
import type { TrustService } from './trust.service';

export type CreateOutcome = 'created' | 'merged' | 'quarantined' | 'duplicate_submit';

export interface CreateResult {
  outcome: CreateOutcome;
  messageCode: string;
  report: ClientReport;
}

const HOUR = 3600000;

export function slaHoursFor(priority: Report['priority']): number {
  return priority === 'emergency' ? 2 : priority === 'high' ? 24 : 72;
}

function unitsFor(category: Category, hazards: string[]): Department[] {
  const units = new Set<Department>(['csgt']);
  const text = hazards.join(' ').toLowerCase();
  if (category === 'den_duong' || /điện|dây/.test(text)) units.add('dien_luc');
  if (category === 'rac_thai') units.add('moi_truong');
  if (category === 'ngap_nuoc' || category === 'khac') units.add('ubnd_khu_pho');
  if (category === 'mat_duong') units.add('giao_thong');
  return [...units];
}

function mkPhoto(p: PhotoInput, kind: Photo['kind'], by: string): Photo {
  return { id: newId('ph'), url: p.dataUrl, dHash: p.dHash, kind, takenBy: by, createdAt: new Date().toISOString() };
}

function known(r: Report): KnownReport {
  return {
    id: r.id,
    category: r.category,
    status: r.status,
    hashes: r.photos.map((p) => p.dHash),
    contributorIds: r.contributors.map((c) => c.userId),
  };
}

export class ReportService {
  constructor(
    private readonly repos: Repositories,
    private readonly gemini: GeminiService,
    private readonly trust: TrustService,
    private readonly audit: AuditService,
    private readonly cvEngine?: CvEngineService,
  ) {}

  async list(user: UserRecord | null, scope: string, category?: string): Promise<ClientReport[]> {
    const wardCodes = scope.startsWith('ward:') ? [scope.slice(5)] : undefined;
    const normCat = category ? (normalizeCategoryInput(category) ?? category) : undefined;
    const rows = await this.repos.reports.list({ wardCodes, category: normCat });
    return rows.filter((r) => canSee(user, r)).map(toClientReport);
  }

  async listPaginated(
    user: UserRecord | null,
    opts: { scope: string; category?: string; status?: ReportStatus; cursor?: string; limit: number },
  ): Promise<PaginatedReports> {
    const wardCodes = opts.scope.startsWith('ward:') ? [opts.scope.slice(5)] : undefined;
    const statuses = opts.status ? [opts.status] : undefined;
    const normCat = opts.category ? (normalizeCategoryInput(opts.category) ?? opts.category) : undefined;
    const allVisible = (await this.repos.reports.list({ wardCodes, category: normCat, statuses })).filter((r) =>
      canSee(user, r),
    );
    const total = allVisible.length;
    const pagePool = opts.cursor ? allVisible.filter((r) => r.createdAt < opts.cursor!) : allVisible;
    const slice = pagePool.slice(0, opts.limit);
    const hasMore = pagePool.length > opts.limit;
    return {
      items: slice.map(toClientReport),
      nextCursor: hasMore && slice.length > 0 ? slice[slice.length - 1].createdAt : null,
      hasMore,
      total,
    };
  }

  async listSummary(
    user: UserRecord | null,
    opts: { scope: string; bbox?: BoundingBoxQuery; category?: string; status?: ReportStatus; limit?: number },
  ): Promise<ReportSummary[]> {
    const wardCodes = opts.scope.startsWith('ward:') ? [opts.scope.slice(5)] : undefined;
    const statuses = opts.status ? [opts.status] : undefined;
    const normCat = opts.category ? (normalizeCategoryInput(opts.category) ?? opts.category) : undefined;
    const rows = await this.repos.reports.list({
      wardCodes,
      category: normCat,
      statuses,
      bbox: opts.bbox,
      limit: opts.limit ?? 1500,
    });
    return rows.filter((r) => canSee(user, r)).map(toReportSummary);
  }

  async getVisible(user: UserRecord | null, id: string): Promise<Report> {
    const r = await this.repos.reports.get(id);
    if (!r || !canSee(user, r)) throw notFound('Không tìm thấy hồ sơ.');
    return r;
  }

  async stats(scope: string): Promise<ScopeStats> {
    const wardCodes = scope.startsWith('ward:') ? [scope.slice(5)] : undefined;
    const rows = await this.repos.reports.list({ wardCodes });
    return computeStats(rows.map(toClientReport), scope);
  }

  async mine(user: UserRecord): Promise<ClientReport[]> {
    const rows = await this.repos.reports.list({ reporterId: user.id });
    return rows.map(toClientReport);
  }

  async lookup(user: UserRecord | null, q: string): Promise<ClientReport[]> {
    const term = q.trim();
    if (/^0\d{9}$|^\+?84\d{9}$/.test(term.replace(/[\s.]/g, ''))) {
      if (!user?.phone) throw forbidden('Tra cứu theo SĐT yêu cầu đăng nhập OTP bằng chính số điện thoại đó.');
      const digits = term.replace(/[\s.]/g, '').replace(/^\+?84/, '0');
      if (digits !== user.phone) throw forbidden('Chỉ được tra cứu bằng số điện thoại đã xác thực của bạn.');
      return this.mine(user);
    }
    if (term.length < 4) throw badRequest('Nhập mã hồ sơ (ví dụ DN-TB-2611-001) hoặc SĐT.');
    const r = await this.repos.reports.getByCode(term);
    return r && canSee(user, r) ? [toClientReport(r)] : [];
  }

  // ── Tạo mới + Rust CV Forensics + Crop/ORB Dedup + AI Triage ───────────────
  async create(user: UserRecord, input: CreateReportInput, proxyVolunteerId: string | null = null): Promise<CreateResult> {
    const id = `rp_${input.idempotencyKey}`;
    const existing = await this.repos.reports.get(id);
    if (existing && existing.reporterId === user.id) {
      return { outcome: 'duplicate_submit', messageCode: 'duplicate_submit', report: toClientReport(existing) };
    }

    const isProxy = proxyVolunteerId !== null;
    const limit = isProxy ? Math.max(env.reportsPerHour, 10) : env.reportsPerHour;
    const recentCount = await this.repos.reports.countByReporterSince(user.id, new Date(Date.now() - HOUR).toISOString());
    if (recentCount >= limit) {
      throw tooMany(`Bạn đã gửi tối đa ${limit} phản ánh trong 1 giờ. Vui lòng thử lại sau.`, 'report_rate_limited');
    }

    if (!inDongNaiBBox(input.lat, input.lng)) {
      throw badRequest('Vị trí nằm ngoài địa bàn Thành phố Đồng Nai.', 'out_of_bounds');
    }
    const { mime, base64 } = parsePhotoDataUrl(input.photo.dataUrl);
    const category = normalizeCategoryInput(input.category) ?? 'khac';
    const ward = (input.wardCode && WARD_BY_CODE[input.wardCode]) || nearestWard(input.lat, input.lng);
    const arterial = matchArterial(input.lat, input.lng);
    const firstPhoto = mkPhoto(input.photo, 'before', user.id);

    const dynCfg = this.cvEngine ? await this.cvEngine.getConfig() : null;

    // Chạy song song: (A) Phân tích Vision + Authenticity 3 tầng, (B) Quét ảnh cắt / trùng lặp ORB + RANSAC trong bán kính 200m
    const [analysis, rustDup] = await Promise.all([
      this.gemini.analyzeImage({
        imageBase64: base64,
        mimeType: mime,
        dHash: input.photo.dHash,
        hintCategory: category,
        hintText: `${input.title}. ${input.description}`,
        edge: input.edge,
        reportId: id,
      }),
      this.cvEngine
        ? this.cvEngine.checkAndRegisterDuplicate({
            imageBase64: base64,
            dHash: input.photo.dHash,
            reportId: id,
            photoId: firstPhoto.id,
            wardCode: ward.wardCode,
            category,
            lat: input.lat,
            lng: input.lng,
            registerOnPass: true,
          })
        : Promise.resolve(null),
    ]);

    const exempt = input.leftScene || isProxy || input.isProxyReport;
    const gpsDistM =
      input.deviceLat !== undefined && input.deviceLng !== undefined
        ? haversineMeters(input.lat, input.lng, input.deviceLat, input.deviceLng)
        : null;
    const gpsWarn = !exempt && gpsDistM !== null && gpsDistM > GPS_WARN_M;

    const nowIso = new Date().toISOString();
    const recent = (await this.repos.reports.findSince(new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString())).map(known);
    const nearby = (await this.repos.reports.findNearby({ lat: input.lat, lng: input.lng, radiusM: CLUSTER_RADIUS_M, category }))
      .filter((r) => ['received', 'verifying', 'processing'].includes(r.status))
      .map(known);

    const decision = decideTriage({
      userId: user.id,
      trustSupervised: this.trust.isSupervised(user),
      authenticityScore: analysis.authenticityScore,
      isAuthenticOverride: analysis.isAuthentic,
      authenticityReason:
        analysis.isAuthentic === false && analysis.fraudFlags.length
          ? `Hệ thống CV chặn ảnh nghi chụp màn hình / giả mạo (${analysis.fraudFlags.join(', ')})`
          : undefined,
      photoHash: input.photo.dHash,
      recent,
      nearby,
      gpsDistanceM: gpsDistM,
      gpsExempt: exempt,
      authenticityThreshold: dynCfg?.screenshotThreshold,
      duplicateThreshold: dynCfg?.duplicateThreshold,
      cropDuplicate:
        rustDup && rustDup.is_duplicate && rustDup.matched_incident_id
          ? {
              matchedIncidentId: rustDup.matched_incident_id,
              matchType: rustDup.match_type,
              inlierCount: rustDup.inlier_count,
              similarityScore: rustDup.similarity_score,
            }
          : null,
    });

    const phoneMasked = user.phone ? maskPhone(user.phone) : user.email ? `${user.email.slice(0, 2)}***` : '***';
    const actor = { id: user.id, name: user.name, role: user.role };

    // Gộp Hồ sơ Mẹ (đa góc chụp)
    if (decision.action === 'merge') {
      const mother = (await this.repos.reports.get(decision.motherId))!;
      const before = { clusterCount: mother.clusterCount, priority: mother.priority, severity: mother.severity };
      mother.photos.push(mkPhoto(input.photo, 'angle', user.id));
      mother.contributors.push({ userId: user.id, phoneMasked, at: nowIso });
      mother.clusterCount += 1;
      if (mother.priority === 'normal') mother.priority = 'high';
      if (mother.clusterCount >= 4 && mother.severity < 4) mother.severity = 4;
      if (mother.priority !== 'emergency') {
        mother.slaDueAt = new Date(Date.parse(mother.createdAt) + slaHoursFor(mother.priority) * HOUR).toISOString();
      }
      mother.timeline.push({
        stage: 'escalated',
        at: nowIso,
        note: `AI gom thêm 1 phản ánh góc ảnh mới (dHash distance = ${decision.minDistance}) — cụm ${mother.clusterCount} người, Ưu tiên ${mother.priority === 'emergency' ? 'Khẩn cấp' : 'Cao'}`,
      });
      mother.updatedAt = nowIso;
      await this.repos.reports.update(mother);
      await this.audit.log(SYSTEM_ACTOR, 'report.cluster_merge', mother.id, before, {
        clusterCount: mother.clusterCount,
        priority: mother.priority,
        byUser: user.id,
      });
      return { outcome: 'merged', messageCode: 'merged', report: toClientReport(mother) };
    }

    const emergency = analysis.isEmergency;
    const level1 = emergency && arterial !== null;
    const priority: Report['priority'] = level1 ? 'emergency' : emergency || analysis.severity >= 4 ? 'high' : 'normal';
    const quarantined = decision.action === 'quarantine';
    const status: Report['status'] = quarantined ? 'quarantined' : 'received';
    const dept = analysis.suggestedDepartment ?? DEPARTMENT_BY_CATEGORY[category];
    const aiSuggestedLabel =
      category === 'khac'
        ? (input.aiSuggestedLabel?.trim() || analysis.aiSuggestedLabel || 'Sự cố hạ tầng / trật tự khác')
        : null;

    const timeline: TimelineEvent[] = [
      { stage: 'received', at: nowIso, note: isProxy ? 'Tình nguyện viên báo cáo hộ người cao tuổi' : 'Hệ thống tiếp nhận phản ánh' },
    ];
    if (quarantined) timeline.push({ stage: 'quarantined', at: nowIso, note: decision.detail });
    if (level1) timeline.push({ stage: 'escalated', at: nowIso, note: `AI gắn KHẨN CẤP CẤP ĐỘ 1 — trục huyết mạch ${arterial!.name}` });

    const report: Report = {
      id,
      code: await this.nextCode(ward.wardCode),
      category,
      aiSuggestedLabel,
      title: input.title,
      description: input.description || analysis.description,
      severity: level1 ? 5 : analysis.severity,
      isEmergency: emergency,
      emergencyLevel: level1 && !quarantined ? 1 : 0,
      priority: quarantined ? 'normal' : priority,
      status,
      wardCode: ward.wardCode,
      address: input.address ?? `${ward.name}, TP. Đồng Nai`,
      roadName: arterial?.name ?? null,
      onArterial: arterial !== null,
      lat: input.lat,
      lng: input.lng,
      photos: [firstPhoto],
      afterPhoto: null,
      clusterCount: 1,
      contributors: [{ userId: user.id, phoneMasked, at: nowIso }],
      confirmations: [],
      reporterId: user.id,
      reporterPhoneMasked: phoneMasked,
      isProxyReport: isProxy || input.isProxyReport,
      proxyVolunteerId,
      seniorSubmitted: input.seniorSubmitted || isProxy,
      needsFieldVerification: quarantined && decision.needsFieldVerification,
      assignedVolunteerId: null,
      verification: null,
      ai: {
        authenticityScore: analysis.authenticityScore,
        fraudFlags: analysis.fraudFlags,
        confidence: analysis.confidence,
        safetyHazards: analysis.safetyHazards,
        suggestedDepartment: dept,
        aiSuggestedLabel,
        isDuplicateCrop: Boolean(rustDup?.is_duplicate),
        duplicateSimilarity: rustDup?.similarity_score ?? null,
        inlierCount: rustDup?.inlier_count ?? null,
        mode: analysis.mode,
      },
      gpsMismatchWarning: gpsWarn,
      gpsDistanceKm: gpsDistM === null ? null : Math.round(gpsDistM / 100) / 10,
      quarantine: quarantined
        ? { reason: decision.reason, detail: decision.detail, at: nowIso, relatedReportId: decision.relatedReportId }
        : null,
      possibleDuplicateOf: decision.action === 'accept' ? decision.possibleDuplicateOf : null,
      department: null,
      slaDueAt: new Date(Date.now() + slaHoursFor(quarantined ? 'normal' : priority) * HOUR).toISOString(),
      dispatches: [],
      resolvedAt: null,
      resolution: null,
      rating: null,
      timeline,
      source: 'user',
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    if (report.emergencyLevel === 1) {
      const order: DispatchOrder = {
        id: newId('dp'),
        fromWardCode: ward.wardCode,
        toWardCodes: ward.adjacentWardCodes.slice(0, 2),
        units: unitsFor(category, analysis.safetyHazards),
        issuedAt: nowIso,
        issuedBy: 'system',
        auto: true,
        note: `Tự động: khẩn cấp cấp 1 trên ${arterial!.name} — chi viện liên phường/xã.`,
      };
      report.dispatches.push(order);
      report.department = order.units.includes('dien_luc') ? 'dien_luc' : dept;
      report.status = 'processing';
      report.timeline.push({ stage: 'dispatched', at: nowIso, note: `Phát lệnh chi viện sang ${order.toWardCodes.join(', ')} + ${order.units.join(', ')}` });
    }

    await this.repos.reports.insert(report);
    await this.audit.log(actor, 'report.create', report.id, null, {
      code: report.code,
      category: report.category,
      status: report.status,
      priority: report.priority,
      quarantine: report.quarantine?.reason ?? null,
    });
    if (report.dispatches.length) await this.audit.log(SYSTEM_ACTOR, 'dispatch.auto', report.id, null, report.dispatches[0]);

    const messageCode = quarantined
      ? decision.reason === 'duplicate_image'
        ? 'quarantine_duplicate'
        : decision.reason === 'low_authenticity'
          ? 'quarantine_fake'
          : decision.reason === 'gps_anomaly'
            ? 'quarantine_gps'
            : 'quarantine_trust'
      : report.emergencyLevel === 1
        ? 'emergency'
        : 'created';
    return { outcome: quarantined ? 'quarantined' : 'created', messageCode, report: toClientReport(report) };
  }

  private async nextCode(wardCode: string): Promise<string> {
    const all = await this.repos.reports.list({ wardCodes: [wardCode] });
    const prefix = `${wardCode}-2611-`;
    const max = all.reduce((m, r) => (r.code.startsWith(prefix) ? Math.max(m, parseInt(r.code.slice(prefix.length), 10) || 0) : m), 0);
    return `${prefix}${String(max + 1).padStart(3, '0')}`;
  }

  async confirm(user: UserRecord, id: string): Promise<ClientReport> {
    const r = await this.getVisible(user, id);
    if (r.status === 'resolved' || r.status === 'quarantined' || r.status === 'rejected') {
      throw badRequest('Hồ sơ này không còn nhận xác nhận.', 'not_confirmable');
    }
    if (isOwner(user, r)) throw badRequest('Bạn là người gửi hồ sơ này.', 'own_report');
    if (r.confirmations.includes(user.id)) throw badRequest('Bạn đã xác nhận hồ sơ này rồi (mỗi SĐT chỉ 1 lần).', 'already_confirmed');
    const before = { confirmCount: r.confirmations.length, priority: r.priority };
    r.confirmations.push(user.id);
    if (r.confirmations.length >= 3 && r.priority === 'normal') {
      r.priority = 'high';
      r.timeline.push({ stage: 'escalated', at: new Date().toISOString(), note: `${r.confirmations.length} người dân xác nhận — nâng Ưu tiên Cao` });
    }
    r.updatedAt = new Date().toISOString();
    await this.repos.reports.update(r);
    await this.audit.log({ id: user.id, name: user.name, role: user.role }, 'report.confirm', r.id, before, {
      confirmCount: r.confirmations.length,
      priority: r.priority,
    });
    return toClientReport(r);
  }

  async attachPhoto(user: UserRecord, id: string, photo: PhotoInput): Promise<ClientReport> {
    const r = await this.getVisible(user, id);
    if (r.status === 'resolved' || r.status === 'quarantined' || r.status === 'rejected') {
      throw badRequest('Hồ sơ này không nhận thêm ảnh.', 'not_attachable');
    }
    parsePhotoDataUrl(photo.dataUrl);
    if (r.photos.length >= 8) throw badRequest('Hồ sơ đã đủ số ảnh tối đa (8).', 'photo_limit');
    const min = r.photos.reduce((m, p) => Math.min(m, hammingDistance(photo.dHash, p.dHash)), 64);
    if (min <= 5) throw badRequest(`Ảnh này trùng với ảnh đã có (dHash distance = ${min}). Hãy chụp từ góc khác.`, 'duplicate_photo');
    const newPerson = !isOwner(user, r);
    const nowIso = new Date().toISOString();
    r.photos.push(mkPhoto(photo, 'angle', user.id));
    if (newPerson) {
      r.contributors.push({ userId: user.id, phoneMasked: user.phone ? maskPhone(user.phone) : '***', at: nowIso });
      r.clusterCount += 1;
      if (r.priority === 'normal') r.priority = 'high';
      r.timeline.push({ stage: 'escalated', at: nowIso, note: `Thêm góc ảnh mới từ người dân thứ ${r.clusterCount}` });
    }
    r.updatedAt = nowIso;
    await this.repos.reports.update(r);
    await this.audit.log({ id: user.id, name: user.name, role: user.role }, 'report.attach_photo', r.id, null, {
      photos: r.photos.length,
      clusterCount: r.clusterCount,
    });
    return toClientReport(r);
  }

  async rate(user: UserRecord, id: string, stars: number, comment: string): Promise<ClientReport> {
    const r = await this.getVisible(user, id);
    if (r.status !== 'resolved') throw badRequest('Chỉ đánh giá được hồ sơ đã hoàn thành.', 'not_resolved');
    if (!isOwner(user, r)) throw forbidden('Chỉ người dân trong cụm phản ánh mới được đánh giá.');
    if (r.rating) throw badRequest('Hồ sơ đã được đánh giá.', 'already_rated');
    r.rating = { stars: stars as 1 | 2 | 3 | 4 | 5, comment, at: new Date().toISOString() };
    r.updatedAt = r.rating.at;
    await this.repos.reports.update(r);
    await this.audit.log({ id: user.id, name: user.name, role: user.role }, 'report.rate', r.id, null, r.rating);
    return toClientReport(r);
  }
}
