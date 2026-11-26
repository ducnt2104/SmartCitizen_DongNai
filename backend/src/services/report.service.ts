import mongoose from 'mongoose';
import {
  CLUSTER_RADIUS_M,
  computeSosPriorityScore,
  DEPARTMENT_BY_CATEGORY,
  DUPLICATE_WINDOW_MS,
  GPS_WARN_M,
  normalizeCategoryInput,
  toSeverityLabel,
} from '../shared/constants';
import { normalizeCoordinates } from '../shared/coordinates';
import { hammingDistance } from '../shared/dhash';
import { WARD_BY_CODE } from '../shared/dongNaiWards';
import { haversineMeters, inDongNaiBBox, matchArterial, maskPhone, nearestWard } from '../shared/geo';
import { computeStats, toClientReport, toReportSummary } from '../shared/report';
import { CATEGORIES, type Category, type ClientReport, type Department, type DispatchOrder, type PaginatedReports, type Photo, type Report, type ReportStatus, type ReportSummary, type ScopeStats, type TimelineEvent } from '../shared/types';
import { ReportModel } from '../models';
import { expandMongoStatuses, reportFromDoc } from '../repositories/mongoRepositories';
import type { BoundingBoxQuery, Repositories, UserRecord } from '../repositories/types';
import { env } from '../config/env';
import type { CreateReportInput } from '../validation/schemas';
import { badRequest, forbidden, HttpError, notFound, tooMany } from '../utils/errors';
import { newId } from '../utils/crypto';
import { canSee, isOwner, parsePhotoDataUrl, type PhotoInput } from './access';
import type { Stage2PostProcessorService } from './ai';
import type { AlertsAndWardsService } from './alertsAndWards.service';
import { SYSTEM_ACTOR, type AuditService } from './audit.service';
import type { CacheService } from './cache.service';
import type { CvEngineService } from './cvEngine.service';
import type { GeminiService } from './gemini.service';
import type { MediaService } from './media.service';
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

async function persistPhoto(
  media: MediaService | undefined,
  p: PhotoInput,
  kind: Photo['kind'],
  by: string,
  reportId?: string,
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
    private readonly cache?: CacheService,
    private readonly media?: MediaService,
    private readonly stage2?: Stage2PostProcessorService,
    private readonly alerts?: AlertsAndWardsService,
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
    const normCat = opts.category ? (normalizeCategoryInput(opts.category) ?? opts.category) : undefined;
    const publicVisibleStatuses: ReportStatus[] = ['received', 'verifying', 'processing', 'resolved'];

    // Đẩy cursor + limit + status xuống tầng DB/Index khi truy vấn công khai hoặc đã chỉ định status
    const dbStatuses: ReportStatus[] | undefined = opts.status
      ? [opts.status]
      : user === null
        ? publicVisibleStatuses
        : undefined;

    if (dbStatuses !== undefined) {
      if (user === null && this.repos.mode === 'mongodb' && mongoose.connection.readyState === 1) {
        const expanded = expandMongoStatuses(dbStatuses);
        const matchFilter: Record<string, unknown> = {
          status: expanded.length === 1 ? expanded[0] : { $in: expanded },
        };
        if (wardCodes?.length) {
          matchFilter.wardCode = wardCodes.length === 1 ? wardCodes[0] : { $in: wardCodes };
        }
        if (normCat) matchFilter.category = String(normCat);

        const [agg] = await ReportModel.aggregate<{
          total: Array<{ n: number }>;
          items: Array<Record<string, unknown>>;
        }>([
          { $match: matchFilter },
          {
            $facet: {
              total: [{ $count: 'n' }],
              items: [
                ...(opts.cursor ? [{ $match: { createdAt: { $lt: String(opts.cursor) } } }] : []),
                { $sort: { createdAt: -1 } },
                { $limit: opts.limit + 1 },
                { $project: { _id: 0, location: 0, imageHash: 0, syncId: 0, customCategoryLabel: 0 } },
              ],
            },
          },
        ]);
        const docs = (agg?.items ?? [])
          .map((d) => reportFromDoc(d))
          .filter((r): r is Report => Boolean(r));
        const slice = docs.slice(0, opts.limit).map(toClientReport);
        const hasMore = docs.length > opts.limit;
        return {
          items: slice,
          nextCursor: hasMore && slice.length > 0 ? slice[slice.length - 1].createdAt : null,
          hasMore,
          total: agg?.total?.[0]?.n ?? 0,
        };
      }

      const fetchLimit = user === null || opts.status ? opts.limit + 1 : undefined;
      const [pageCandidates, countCandidates] = await Promise.all([
        this.repos.reports.list({
          wardCodes,
          category: normCat,
          statuses: dbStatuses,
          cursor: opts.cursor,
          ...(fetchLimit ? { limit: fetchLimit } : {}),
        }),
        this.repos.reports.list({
          wardCodes,
          category: normCat,
          statuses: dbStatuses,
          projection: 'stats',
        }),
      ]);
      const visiblePage = user === null ? pageCandidates : pageCandidates.filter((r) => canSee(user, r));
      const slice = visiblePage.slice(0, opts.limit);
      const hasMore = visiblePage.length > opts.limit;
      const visibleTotal = user === null ? countCandidates.length : countCandidates.filter((r) => canSee(user, r)).length;
      return {
        items: slice.map(toClientReport),
        nextCursor: hasMore && slice.length > 0 ? slice[slice.length - 1].createdAt : null,
        hasMore,
        total: visibleTotal,
      };
    }

    const allVisible = (await this.repos.reports.list({ wardCodes, category: normCat })).filter((r) =>
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
      projection: 'summary',
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
    if (this.repos.mode === 'mongodb' && mongoose.connection.readyState === 1) {
      const nowDate = new Date();
      const matchStage: Record<string, unknown> = wardCodes?.length
        ? { wardCode: wardCodes.length === 1 ? wardCodes[0] : { $in: wardCodes } }
        : {};
      const [agg] = await ReportModel.aggregate<{
        byCategory: Array<{ _id: string; count: number }>;
        summary: Array<{
          total: number;
          resolved: number;
          emergency: number;
          quarantined: number;
          slaOverdue: number;
          sumMs: number;
        }>;
      }>([
        { $match: matchStage },
        {
          $addFields: {
            normStatus: {
              $switch: {
                branches: [
                  { case: { $eq: ['$status', 'PENDING'] }, then: 'received' },
                  { case: { $eq: ['$status', 'VERIFIED'] }, then: 'verifying' },
                  { case: { $in: ['$status', ['DISPATCHED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS']] }, then: 'processing' },
                  { case: { $eq: ['$status', 'RESOLVED'] }, then: 'resolved' },
                ],
                default: '$status',
              },
            },
          },
        },
        {
          $facet: {
            byCategory: [{ $group: { _id: '$category', count: { $sum: 1 } } }],
            summary: [
              {
                $group: {
                  _id: null,
                  total: { $sum: 1 },
                  resolved: {
                    $sum: {
                      $cond: [
                        { $and: [{ $eq: ['$normStatus', 'resolved'] }, { $ifNull: ['$resolvedAt', false] }] },
                        1,
                        0,
                      ],
                    },
                  },
                  quarantined: { $sum: { $cond: [{ $eq: ['$normStatus', 'quarantined'] }, 1, 0] } },
                  emergency: {
                    $sum: {
                      $cond: [
                        {
                          $and: [
                            { $not: [{ $in: ['$normStatus', ['resolved', 'quarantined', 'rejected']] }] },
                            { $eq: ['$isEmergency', true] },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  slaOverdue: {
                    $sum: {
                      $cond: [
                        {
                          $and: [
                            { $not: [{ $in: ['$normStatus', ['resolved', 'quarantined', 'rejected']] }] },
                            { $ifNull: ['$slaDueAt', false] },
                            {
                              $lt: [
                                { $dateFromString: { dateString: '$slaDueAt', onError: nowDate, onNull: nowDate } },
                                nowDate,
                              ],
                            },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  sumMs: {
                    $sum: {
                      $cond: [
                        { $and: [{ $eq: ['$normStatus', 'resolved'] }, { $ifNull: ['$resolvedAt', false] }] },
                        {
                          $subtract: [
                            { $toLong: { $dateFromString: { dateString: '$resolvedAt', onError: nowDate, onNull: nowDate } } },
                            { $toLong: { $dateFromString: { dateString: '$createdAt', onError: nowDate, onNull: nowDate } } },
                          ],
                        },
                        0,
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      ]);

      const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
      for (const row of agg?.byCategory ?? []) {
        if (row._id in byCategory) {
          byCategory[row._id as Category] = row.count;
        }
      }
      const sm = agg?.summary?.[0];
      const total = sm?.total ?? 0;
      const resolved = sm?.resolved ?? 0;
      const sumMs = sm?.sumMs ?? 0;
      return {
        scope,
        total,
        resolved,
        open: total - resolved,
        resolvedPct: total === 0 ? 0 : Math.round((resolved / total) * 1000) / 10,
        avgDays: resolved === 0 ? 0 : Math.round((sumMs / resolved / 86400000) * 10) / 10,
        byCategory,
        emergency: sm?.emergency ?? 0,
        quarantined: sm?.quarantined ?? 0,
        slaOverdue: sm?.slaOverdue ?? 0,
      };
    }

    const rows = await this.repos.reports.list({ wardCodes, projection: 'stats' });
    return computeStats(rows, scope);
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

  // ── Tạo mới + 3-Stage AI Cascade + Crop/ORB Dedup + Binary WebP Storage ───
  async create(
    user: UserRecord,
    input: CreateReportInput & { photoInput?: PhotoInput; rateLimitKey?: string },
    proxyVolunteerId: string | null = null,
  ): Promise<CreateResult> {
    const id = `rp_${input.idempotencyKey}`;
    const existing = await this.repos.reports.get(id);
    if (existing && existing.reporterId === user.id) {
      return { outcome: 'duplicate_submit', messageCode: 'duplicate_submit', report: toClientReport(existing) };
    }

    const isProxy = proxyVolunteerId !== null;
    const limit = isProxy ? Math.max(env.reportsPerHour, 10) : env.reportsPerHour;
    const recentCount = await this.repos.reports.countByReporterSince(user.id, new Date(Date.now() - HOUR).toISOString());
    if (recentCount >= limit) {
      throw tooMany(`Bạn đã gửi tối đa ${limit} phản ánh trong 1 giờ. Vui lòng thử lại sau.`, 'report_rate_limited', {
        retryAfter: 60,
        retryAfterSec: 60,
      });
    }

    const normPin = normalizeCoordinates({ lat: input.lat, lng: input.lng });
    if (!normPin.ok) {
      throw badRequest(normPin.message, 'invalid_coords');
    }
    const pinLat = normPin.lat;
    const pinLng = normPin.lng;
    if (!normPin.inDongNai || !inDongNaiBBox(pinLat, pinLng)) {
      throw badRequest('Vị trí nằm ngoài địa bàn Thành phố Đồng Nai.', 'out_of_bounds');
    }

    let resolvedPhoto: PhotoInput;
    let isLegacyJsonStub = false;
    if (input.photoInput) {
      resolvedPhoto = input.photoInput;
      const bufLen = (resolvedPhoto.aiBuffer ?? resolvedPhoto.buffer)?.byteLength ?? 0;
      isLegacyJsonStub = Boolean(resolvedPhoto.dataUrl) && bufLen < 600;
    } else if (input.photo?.dataUrl) {
      const parsed = parsePhotoDataUrl(input.photo.dataUrl);
      resolvedPhoto = {
        dataUrl: input.photo.dataUrl,
        buffer: parsed.buffer,
        dHash: input.photo.dHash ?? input.dHash ?? '0000000000000000',
      };
      isLegacyJsonStub = parsed.buffer.byteLength < 600;
    } else {
      throw badRequest('Thiếu ảnh hiện trường (multipart binary hoặc dataUrl).', 'invalid_photo');
    }

    const aiBuf = resolvedPhoto.aiBuffer ?? resolvedPhoto.buffer;
    const base64ForCv = aiBuf ? aiBuf.toString('base64') : '';
    const legacyParsed = resolvedPhoto.dataUrl ? parsePhotoDataUrl(resolvedPhoto.dataUrl) : null;
    const mime = resolvedPhoto.aiMimeType ?? (resolvedPhoto.aiBuffer ? 'image/webp' : legacyParsed?.mime ?? 'image/webp');

    const category = normalizeCategoryInput(input.category) ?? 'khac';
    const ward = (input.wardCode && WARD_BY_CODE[input.wardCode]) || nearestWard(pinLat, pinLng);
    const arterial = matchArterial(pinLat, pinLng);
    const pendingPhotoId = newId('ph');

    const dynCfg = this.cvEngine ? await this.cvEngine.getConfig() : null;

    // Chạy song song: (A) 3-Stage AI Cascade, (B) Quét ảnh cắt / trùng lặp ORB + RANSAC trong bán kính 200m
    const [analysis, rustDup] = await Promise.all([
      this.gemini.analyzeImage({
        imageBuffer: aiBuf,
        imageBase64: base64ForCv,
        mimeType: mime,
        dHash: resolvedPhoto.dHash,
        hintCategory: category,
        hintText: `${input.title}. ${input.description}`,
        edge: input.edge,
        exif: input.exif ?? input.photo?.exif,
        lat: pinLat,
        lng: pinLng,
        reportId: id,
        onArterial: arterial !== null,
        wardCode: ward.wardCode,
        rateLimitKey: input.rateLimitKey ?? `rp_user:${user.id}`,
        trustScore: user.trustScore,
        reportsRepo: this.repos.reports,
        allowTinyTestStub: process.env.NODE_ENV === 'test' && isLegacyJsonStub,
        skipCache: true,
      }),
      this.cvEngine
        ? this.cvEngine.checkAndRegisterDuplicate({
            imageBase64: base64ForCv,
            dHash: resolvedPhoto.dHash,
            reportId: id,
            photoId: pendingPhotoId,
            wardCode: ward.wardCode,
            category,
            lat: pinLat,
            lng: pinLng,
            registerOnPass: false,
          })
        : Promise.resolve(null),
    ]);

    const exempt = input.leftScene || isProxy || input.isProxyReport;
    const normDevice =
      input.deviceLat !== undefined && input.deviceLng !== undefined
        ? normalizeCoordinates({ lat: input.deviceLat, lng: input.deviceLng })
        : null;
    const gpsDistM = normDevice?.ok ? haversineMeters(pinLat, pinLng, normDevice.lat, normDevice.lng) : null;
    const gpsWarn = !exempt && gpsDistM !== null && gpsDistM > GPS_WARN_M;

    const nowIso = new Date().toISOString();
    const recent = (await this.repos.reports.findSince(new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString(), 'dedup')).map(known);
    const nearby = (
      await this.repos.reports.findNearby({ lat: pinLat, lng: pinLng, radiusM: CLUSTER_RADIUS_M, category, projection: 'dedup' })
    )
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
      photoHash: resolvedPhoto.dHash,
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

    const isTinyTest = process.env.NODE_ENV === 'test' && isLegacyJsonStub;
    // Chỉ chặn cứng (HTTP 422) khi vi phạm nội dung thực sự (spam/quấy rối/tiêu chuẩn cộng đồng), KHÔNG chặn nghi ngờ AI/CV/EXIF ảnh
    const isHardContentViolation =
      analysis.status === 'REJECTED_PREFILTER' ||
      (analysis.abuseRisk === 'HIGH' && !analysis.degraded);

    if (isHardContentViolation) {
      const fFlags = Array.from(new Set([...(analysis.forensicFlags ?? []), ...analysis.fraudFlags]));
      let errorCode = 'ABUSIVE_CONTENT_REJECTED';
      if (fFlags.some((f) => /promo|url|spam/i.test(f))) {
        errorCode = 'SPAM_TEXT_REJECTED';
      } else if (fFlags.some((f) => /profanity/i.test(f))) {
        errorCode = 'PROFANITY_REJECTED';
      } else if (fFlags.some((f) => /gibberish/i.test(f))) {
        errorCode = 'GIBBERISH_TEXT_REJECTED';
      }
      const reasonMsg =
        analysis.citizenFeedback ||
        'Nội dung phản ánh không hợp lệ (nghi spam, ký tự vô nghĩa hoặc vi phạm chuẩn mực cộng đồng). Vui lòng mô tả rõ sự cố.';

      await Promise.allSettled([
        this.trust.penalizeSpam(user.id),
        this.audit.log(
          { id: user.id, name: user.name, role: user.role },
          'report.rejected_gatekeeper',
          id,
          null,
          {
            reasonCode: errorCode,
            authenticityScore: analysis.authenticityScore,
            forensicFlags: fFlags,
            relatedReportId: null,
          },
        ),
      ]);

      throw new HttpError(422, reasonMsg, errorCode, {
        authenticityScore: analysis.authenticityScore,
        forensicFlags: fFlags,
        forensics: analysis.forensics ?? null,
        relatedReportId: null,
      });
    }

    const softFlagsSet = new Set<string>([
      ...(analysis.softFlags ?? []),
      ...(analysis.forensicFlags ?? []),
      ...analysis.fraudFlags,
    ]);
    if (rustDup?.is_duplicate) {
      softFlagsSet.add(`duplicate_${rustDup.match_type || 'perceptual'}`);
    }
    if (decision.action === 'quarantine' && (decision.reason === 'duplicate_image' || decision.reason === 'low_authenticity')) {
      softFlagsSet.add(decision.reason);
    }
    if (analysis.degraded || analysis.errorCode) {
      softFlagsSet.add(analysis.errorCode || 'ai_cloud_fallback_manual_review');
    }
    const softFlags = Array.from(softFlagsSet);
    const hasCvSoftFlag =
      softFlags.length > 0 ||
      Boolean(analysis.isScreenCaptureOrFake) ||
      Boolean(rustDup?.is_duplicate) ||
      Boolean(analysis.needsManualReview) ||
      Boolean(analysis.degraded) ||
      analysis.authenticityScore < 65 ||
      (decision.action === 'quarantine' && (decision.reason === 'duplicate_image' || decision.reason === 'low_authenticity'));
    const computedAiFlag =
      analysis.aiFlag ??
      (softFlags.some((f) => /(screenshot|moire|high_flat_ui)/i.test(f))
        ? 'suspected_screenshot'
        : softFlags.some((f) => /(c2pa|ai_signature|ai_smooth|ela_tamper|editing_software)/i.test(f))
          ? 'suspected_ai_or_edited'
          : softFlags.some((f) => /duplicate/i.test(f)) || rustDup?.is_duplicate
            ? 'suspected_duplicate_crop'
            : softFlags.some((f) => /blurry|severe_blur|bad_exposure|extreme_exposure/i.test(f))
              ? 'low_image_clarity'
              : analysis.degraded || analysis.errorCode
                ? 'ai_fallback_manual_review'
                : hasCvSoftFlag
                  ? 'manual_review_recommended'
                  : null);

    const phoneMasked = user.phone ? maskPhone(user.phone) : user.email ? `${user.email.slice(0, 2)}***` : '***';
    const actor = { id: user.id, name: user.name, role: user.role };
    void isTinyTest;

    // Gộp Hồ sơ Mẹ (đa góc chụp)
    if (decision.action === 'merge') {
      const mother = (await this.repos.reports.get(decision.motherId))!;
      const before = { clusterCount: mother.clusterCount, priority: mother.priority, severity: mother.severity };
      mother.photos.push(await persistPhoto(this.media, resolvedPhoto, 'angle', user.id, mother.id));
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
      this.cache?.invalidateReports();
      await this.audit.log(SYSTEM_ACTOR, 'report.cluster_merge', mother.id, before, {
        clusterCount: mother.clusterCount,
        priority: mother.priority,
        byUser: user.id,
      });
      if (this.alerts) {
        await this.alerts.checkAndEscalateGeoCluster(mother).catch(() => undefined);
      }
      return { outcome: 'merged', messageCode: 'merged', report: toClientReport(mother) };
    }

    const firstPhoto = await persistPhoto(this.media, resolvedPhoto, 'before', user.id, id);

    const emergency = Boolean(analysis.isEmergency || input.isEmergency);
    const level1 = emergency && arterial !== null;
    const effectiveSeverityBase =
      typeof input.severity === 'number'
        ? Math.max(analysis.severity, Math.min(5, Math.max(1, input.severity)))
        : analysis.severity;
    const priority: Report['priority'] = level1 ? 'emergency' : emergency || effectiveSeverityBase >= 4 ? 'high' : 'normal';
    // Chỉ cách ly đối với GPS bất thường > 5km hoặc tài khoản giám sát; nghi ngờ ảnh AI/CV chuyển sang Soft Flag cho IOC duyệt
    const quarantined =
      decision.action === 'quarantine' &&
      decision.reason !== 'duplicate_image' &&
      decision.reason !== 'low_authenticity';
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

    const finalSeverity = (level1 ? 5 : effectiveSeverityBase) as Report['severity'];
    const finalSeverityLabel = analysis.severityLabel ?? toSeverityLabel(finalSeverity, emergency || level1);
    const finalPriorityScore =
      analysis.priorityScore ??
      computeSosPriorityScore({
        severity: finalSeverity,
        isEmergency: emergency || level1,
        onArterial: arterial !== null,
      });
    const tacticalBriefing =
      analysis.tacticalBriefing ??
      this.gemini.deterministicTacticalBriefing({
        reportId: id,
        category,
        title: input.title,
        description: input.description || analysis.description,
        severity: finalSeverity,
        isEmergency: emergency || level1,
        wardCode: ward.wardCode,
        address: input.address ?? `${ward.name}, TP. Đồng Nai`,
        roadName: arterial?.name ?? null,
        onArterial: arterial !== null,
        safetyHazards: analysis.safetyHazards,
      });

    const report: Report = {
      id,
      code: await this.nextCode(ward.wardCode),
      category,
      aiSuggestedLabel,
      title: input.title,
      description: input.description || analysis.description,
      severity: finalSeverity,
      severityLabel: finalSeverityLabel,
      priorityScore: finalPriorityScore,
      isEmergency: emergency,
      emergencyLevel: level1 && !quarantined ? 1 : 0,
      priority: quarantined ? 'normal' : priority,
      status,
      wardCode: ward.wardCode,
      address: input.address ?? `${ward.name}, TP. Đồng Nai`,
      roadName: arterial?.name ?? null,
      onArterial: arterial !== null,
      lat: pinLat,
      lng: pinLng,
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
      needsFieldVerification: (quarantined && decision.needsFieldVerification) || hasCvSoftFlag,
      assignedVolunteerId: null,
      verification: null,
      aiFlag: computedAiFlag,
      needsManualReview: hasCvSoftFlag,
      ai: {
        authenticityScore: analysis.authenticityScore,
        fraudFlags: softFlags,
        confidence: analysis.confidence,
        safetyHazards: analysis.safetyHazards,
        suggestedDepartment: dept,
        aiSuggestedLabel,
        priorityScore: finalPriorityScore,
        severityLabel: finalSeverityLabel,
        tacticalBriefing,
        isDuplicateCrop: Boolean(rustDup?.is_duplicate),
        duplicateSimilarity: rustDup?.similarity_score ?? null,
        inlierCount: rustDup?.inlier_count ?? null,
        relevanceScore: analysis.relevanceScore,
        abuseRisk: analysis.abuseRisk,
        isScreenCaptureOrFake: analysis.isScreenCaptureOrFake,
        forensicFlags: softFlags,
        forensics: analysis.forensics ?? null,
        keyEvidenceTags: analysis.keyEvidenceTags,
        moderationDecision: hasCvSoftFlag ? 'HUMAN_REVIEW' : (analysis.decision ?? 'AUTO_APPROVE'),
        decision: hasCvSoftFlag ? 'HUMAN_REVIEW' : (analysis.decision ?? 'AUTO_APPROVE'),
        aiFlag: computedAiFlag,
        needsManualReview: hasCvSoftFlag,
        softFlags,
        citizenFeedback: null,
        officerReviewNotes:
          analysis.officerReviewNotes ||
          (hasCvSoftFlag
            ? `Cần Cán bộ IOC kiểm tra ảnh (soft flag: ${computedAiFlag ?? 'manual_review'}).`
            : null),
        latencyMs: analysis.latencyMs,
        mode: analysis.mode,
      },
      gpsMismatchWarning: gpsWarn,
      gpsDistanceKm: gpsDistM === null ? null : Math.round(gpsDistM / 100) / 10,
      quarantine: quarantined
        ? { reason: decision.reason, detail: decision.detail, at: nowIso, relatedReportId: decision.relatedReportId }
        : null,
      possibleDuplicateOf:
        decision.action === 'accept'
          ? decision.possibleDuplicateOf
          : decision.action === 'quarantine' && decision.reason === 'duplicate_image'
            ? decision.relatedReportId
            : (rustDup?.matched_incident_id ?? null),
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
    this.cache?.invalidateReports();
    this.stage2?.schedulePostProcess({
      userId: user.id,
      reportId: report.id,
      decision: hasCvSoftFlag ? 'HUMAN_REVIEW' : (analysis.decision ?? 'AUTO_APPROVE'),
      authenticityScore: analysis.authenticityScore,
      fraudFlags: softFlags,
      engineMode: analysis.mode,
      latencyMs: analysis.latencyMs ?? 0,
      summary: analysis.officerReviewNotes || analysis.description,
    });
    const postWriteTasks: Array<Promise<unknown>> = [
      this.audit.log(actor, 'report.create', report.id, null, {
        code: report.code,
        category: report.category,
        status: report.status,
        priority: report.priority,
        quarantine: report.quarantine?.reason ?? null,
        aiFlag: report.aiFlag ?? null,
        needsManualReview: Boolean(report.needsManualReview),
      }),
    ];
    if (report.dispatches.length) {
      postWriteTasks.push(this.audit.log(SYSTEM_ACTOR, 'dispatch.auto', report.id, null, report.dispatches[0]));
    }
    if (!quarantined && this.cvEngine) {
      postWriteTasks.push(
        this.cvEngine.checkAndRegisterDuplicate({
          imageBase64: base64ForCv,
          dHash: resolvedPhoto.dHash,
          reportId: report.id,
          photoId: pendingPhotoId,
          wardCode: ward.wardCode,
          category,
          lat: pinLat,
          lng: pinLng,
          registerOnPass: true,
        }),
      );
    }
    if (!quarantined && this.alerts) {
      postWriteTasks.push(this.alerts.checkAndEscalateGeoCluster(report));
    }
    await Promise.allSettled(postWriteTasks);

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
    const prefix = `${wardCode}-2611-`;
    if (this.repos.mode === 'mongodb' && mongoose.connection.readyState === 1) {
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const latest = (await ReportModel.findOne({ wardCode, code: new RegExp(`^${escaped}`) })
        .sort({ code: -1 })
        .select('-_id code')
        .lean()) as { code?: string } | null;
      const max = latest?.code?.startsWith(prefix) ? parseInt(latest.code.slice(prefix.length), 10) || 0 : 0;
      return `${prefix}${String(max + 1).padStart(3, '0')}`;
    }
    const all = await this.repos.reports.list({ wardCodes: [wardCode], projection: 'code_only' });
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
    this.cache?.invalidateReports();
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
    if (!photo.buffer && photo.dataUrl) parsePhotoDataUrl(photo.dataUrl);
    if (r.photos.length >= 8) throw badRequest('Hồ sơ đã đủ số ảnh tối đa (8).', 'photo_limit');
    const min = r.photos.reduce((m, p) => Math.min(m, hammingDistance(photo.dHash, p.dHash)), 64);
    if (min <= 5) throw badRequest(`Ảnh này trùng với ảnh đã có (dHash distance = ${min}). Hãy chụp từ góc khác.`, 'duplicate_photo');
    const newPerson = !isOwner(user, r);
    const nowIso = new Date().toISOString();
    r.photos.push(await persistPhoto(this.media, photo, 'angle', user.id, r.id));
    if (newPerson) {
      r.contributors.push({ userId: user.id, phoneMasked: user.phone ? maskPhone(user.phone) : '***', at: nowIso });
      r.clusterCount += 1;
      if (r.priority === 'normal') r.priority = 'high';
      r.timeline.push({ stage: 'escalated', at: nowIso, note: `Thêm góc ảnh mới từ người dân thứ ${r.clusterCount}` });
    }
    r.updatedAt = nowIso;
    await this.repos.reports.update(r);
    this.cache?.invalidateReports();
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
    this.cache?.invalidateReports();
    await this.audit.log({ id: user.id, name: user.name, role: user.role }, 'report.rate', r.id, null, r.rating);
    return toClientReport(r);
  }
}
