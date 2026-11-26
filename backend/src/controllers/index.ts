import type { Request, Response } from 'express';
import { normalizeRole } from '../shared/constants';
import { normalizeCoordinates } from '../shared/coordinates';
import { DONG_NAI_WARDS } from '../shared/dongNaiWards';
import { toClientReport } from '../shared/report';
import type { ReportStatus } from '../shared/types';
import { purgeDemoData } from '../data/seedStore';
import {
  clearAuthCookies,
  extractClientMeta,
  readCookie,
  REFRESH_COOKIE,
  setAuthCookies,
} from '../middleware/auth';
import type { BoundingBoxQuery } from '../repositories/types';
import { isAdminRole, isRescueCapable, resolvePhotoInputFromRequest } from '../services/access';
import type { Services } from '../services/container';
import { isValidMediaId } from '../services/media.service';
import { registerSessionStream } from '../services/sessionEvents';
import { toProfile } from '../services/trust.service';
import { sha256 } from '../utils/crypto';
import { badRequest, forbidden } from '../utils/errors';
import type { CreateReportInput } from '../validation/schemas';
import { schemas } from '../validation/schemas';
import type { z } from 'zod';

const SCOPE_RE = /^(city|ward:DN-[A-Z]{2,4})$/;
const WARDS_ETAG = `"wards-95-${sha256(JSON.stringify(DONG_NAI_WARDS)).slice(0, 16)}"`;
const VALID_STATUSES: ReadonlySet<string> = new Set(['received', 'verifying', 'processing', 'resolved', 'quarantined', 'rejected']);

function scopeOf(req: Request): string {
  const s = typeof req.query.scope === 'string' ? req.query.scope : 'city';
  if (!SCOPE_RE.test(s)) throw badRequest('Phạm vi không hợp lệ.', 'invalid_scope');
  return s;
}

function parseBbox(raw: unknown): BoundingBoxQuery | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw badRequest('bbox phải có dạng minLng,minLat,maxLng,maxLat.', 'invalid_bbox');
  }
  const [minLng, minLat, maxLng, maxLat] = parts;
  if (minLng > maxLng || minLat > maxLat) {
    throw badRequest('bbox không hợp lệ (min > max).', 'invalid_bbox');
  }
  return { minLng, minLat, maxLng, maxLat };
}

function body<T extends keyof typeof schemas>(req: Request, _k: T): z.infer<(typeof schemas)[T]> {
  void _k;
  return req.body as z.infer<(typeof schemas)[T]>;
}

export function authController(s: Services) {
  return {
    otpRequest: async (req: Request, res: Response) => {
      const b = body(req, 'otpRequest');
      const target = (b.identifier ?? b.phone ?? '').trim();
      res.json(await s.auth.requestOtp(target, b.purpose));
    },
    otpVerify: async (req: Request, res: Response) => {
      const b = body(req, 'otpVerify');
      const target = (b.identifier ?? b.phone ?? '').trim();
      const meta = extractClientMeta(req);
      const issued = await s.auth.verifyOtp(target, b.code, {
        name: b.name,
        password: b.password,
        defaultWardCode: b.defaultWardCode,
        userAgent: meta.userAgent,
        meta,
      });
      setAuthCookies(res, issued.session.token, issued.refreshToken, issued.refreshMaxAgeMs);
      res.json(issued.session);
    },
    passwordLogin: async (req: Request, res: Response) => {
      const b = body(req, 'passwordLogin');
      const issued = await s.auth.passwordLogin(b.identifier, b.password, extractClientMeta(req));
      setAuthCookies(res, issued.session.token, issued.refreshToken, issued.refreshMaxAgeMs);
      res.json(issued.session);
    },
    passwordReset: async (req: Request, res: Response) => {
      const b = body(req, 'passwordReset');
      const issued = await s.auth.resetPassword(b.identifier, b.code, b.newPassword, extractClientMeta(req), {
        firebaseIdToken: b.firebaseIdToken,
      });
      setAuthCookies(res, issued.session.token, issued.refreshToken, issued.refreshMaxAgeMs);
      res.json(issued.session);
    },
    reauth: async (req: Request, res: Response) => {
      const b = body(req, 'reauth');
      const meta = extractClientMeta(req);
      res.json(
        await s.auth.issueReauthToken(req.user!, req.sessionId!, {
          currentPassword: b.currentPassword,
          otpCode: b.otpCode,
          ip: meta.ip,
        }),
      );
    },
    changePassword: async (req: Request, res: Response) => {
      const b = body(req, 'changePassword');
      const { issued, revokedOtherSessions } = await s.auth.changePassword(
        req.user!.id,
        req.sessionId!,
        b,
        extractClientMeta(req),
      );
      setAuthCookies(res, issued.session.token, issued.refreshToken, issued.refreshMaxAgeMs);
      res.json({ ...issued.session, revokedOtherSessions });
    },
    changeEmail: async (req: Request, res: Response) => {
      const b = body(req, 'changeEmail');
      const { issued, revokedOtherSessions } = await s.auth.changeEmail(
        req.user!.id,
        req.sessionId!,
        b,
        extractClientMeta(req),
      );
      setAuthCookies(res, issued.session.token, issued.refreshToken, issued.refreshMaxAgeMs);
      res.json({ ...issued.session, revokedOtherSessions });
    },
    changePhone: async (req: Request, res: Response) => {
      const b = body(req, 'changePhone');
      const { issued, revokedOtherSessions } = await s.auth.changePhone(
        req.user!.id,
        req.sessionId!,
        b,
        extractClientMeta(req),
      );
      setAuthCookies(res, issued.session.token, issued.refreshToken, issued.refreshMaxAgeMs);
      res.json({ ...issued.session, revokedOtherSessions });
    },
    sessionEvents: async (req: Request, res: Response) => {
      registerSessionStream(req.user!.id, req.sessionId!, res);
    },
    mySessions: async (req: Request, res: Response) => {
      res.json(await s.auth.listMySessions(req.user!.id, req.sessionId));
    },
    staffLogin: async (req: Request, res: Response) => {
      const b = body(req, 'staffLogin');
      const target = (b.staffCode ?? b.identifier ?? '').trim();
      const issued = await s.auth.staffLogin(target, b.password, b.unit, extractClientMeta(req));
      setAuthCookies(res, issued.session.token, issued.refreshToken, issued.refreshMaxAgeMs);
      res.json(issued.session);
    },
    rescueLogin: async (req: Request, res: Response) => {
      const { identifier, password } = body(req, 'rescueLogin');
      const issued = await s.auth.rescueLogin(identifier, password, extractClientMeta(req));
      setAuthCookies(res, issued.session.token, issued.refreshToken, issued.refreshMaxAgeMs);
      res.json(issued.session);
    },
    refresh: async (req: Request, res: Response) => {
      const token = readCookie(req, REFRESH_COOKIE);
      try {
        const issued = await s.auth.refreshSession(token, extractClientMeta(req));
        setAuthCookies(res, issued.session.token, issued.refreshToken, issued.refreshMaxAgeMs);
        res.json(issued.session);
      } catch (err) {
        clearAuthCookies(res);
        throw err;
      }
    },
    logout: async (req: Request, res: Response) => {
      await s.auth.logout(readCookie(req, REFRESH_COOKIE), req.sessionId, req.user?.id);
      clearAuthCookies(res);
      res.json({ ok: true });
    },
    logoutAll: async (req: Request, res: Response) => {
      await s.auth.logoutAll(req.user!.id);
      clearAuthCookies(res);
      res.json({ ok: true });
    },
    registerVolunteer: async (req: Request, res: Response) => {
      const { wardCode, unitCode } = body(req, 'volunteerRegister');
      const issued = await s.auth.registerVolunteer(req.user!.id, wardCode, unitCode, extractClientMeta(req));
      setAuthCookies(res, issued.session.token, issued.refreshToken, issued.refreshMaxAgeMs);
      res.json(issued.session);
    },
    me: async (req: Request, res: Response) => {
      res.json({ user: toProfile(req.user!) });
    },
    updateProfile: async (req: Request, res: Response) => {
      const b = body(req, 'updateProfile');
      const { user, issued } = await s.auth.updateProfile(req.user!.id, b, req.sessionId, extractClientMeta(req));
      if (issued) {
        setAuthCookies(res, issued.session.token, issued.refreshToken, issued.refreshMaxAgeMs);
        res.json({ user: toProfile(user), session: issued.session });
        return;
      }
      res.json({ user: toProfile(user) });
    },
    readNotifications: async (req: Request, res: Response) => {
      await s.auth.markNotificationsRead(req.user!.id);
      res.json({ ok: true });
    },
    otpStatus: async (_req: Request, res: Response) => {
      res.json(s.otpDelivery.status);
    },
  };
}

export function reportController(s: Services) {
  return {
    wards: async (req: Request, res: Response) => {
      res.set('ETag', WARDS_ETAG);
      res.set('Cache-Control', 'public, max-age=86400');
      if (req.headers['if-none-match'] === WARDS_ETAG) {
        res.status(304).end();
        return;
      }
      res.json(DONG_NAI_WARDS);
    },
    reverseGeocode: async (req: Request, res: Response) => {
      const norm = normalizeCoordinates(
        { lat: req.query.lat, lng: req.query.lng },
        { requireVietnam: false },
      );
      if (!norm.ok) {
        throw badRequest(norm.message, 'invalid_coords');
      }
      const result = await s.geo.reverseGeocode(norm.lat, norm.lng);
      res.set('Cache-Control', 'public, max-age=3600').json(result);
    },
    media: async (req: Request, res: Response) => {
      const id = String(req.params.id ?? '').trim();
      const variant = req.path.endsWith('/thumb') || req.query.variant === 'thumb' ? 'thumb' : 'display';
      if (!isValidMediaId(id)) {
        res.status(404).json({ error: { code: 'media_not_found', message: 'Không tìm thấy tệp ảnh.' } });
        return;
      }
      const item = await s.media.getMediaBinary(id, variant);
      if (!item) {
        res.status(404).json({ error: { code: 'media_not_found', message: 'Không tìm thấy tệp ảnh.' } });
        return;
      }
      res.set('Content-Type', item.mimeType);
      res.set('ETag', item.etag);
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.set('X-Content-Type-Options', 'nosniff');
      if (req.headers['if-none-match'] === item.etag) {
        res.status(304).end();
        return;
      }
      res.send(item.buffer);
    },
    stats: async (req: Request, res: Response) => {
      const scope = scopeOf(req);
      const cacheKey = `stats:${scope}`;
      let entry = s.cache.getReportCached(cacheKey);
      if (!entry) {
        entry = s.cache.setReportCached(cacheKey, await s.reports.stats(scope), 30_000);
      }
      res.set('ETag', entry.etag);
      res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
      if (req.headers['if-none-match'] === entry.etag) {
        res.status(304).end();
        return;
      }
      res.json(entry.body);
    },
    summary: async (req: Request, res: Response) => {
      const scope = scopeOf(req);
      const category = typeof req.query.category === 'string' && req.query.category ? req.query.category : undefined;
      const rawStatus = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
      const status = rawStatus && VALID_STATUSES.has(rawStatus) ? (rawStatus as ReportStatus) : undefined;
      const bbox = parseBbox(req.query.bbox);
      const limit = Math.min(Math.max(1, Number(req.query.limit) || 1500), 5000);
      const visKey = req.user
        ? isRescueCapable(req.user)
          ? `staff:${req.user.wardCode ?? 'all'}`
          : `u:${req.user.id}`
        : 'pub';
      const cacheKey = `summary:${visKey}:${scope}:${category ?? ''}:${status ?? ''}:${typeof req.query.bbox === 'string' ? req.query.bbox : ''}:${limit}`;
      let entry = s.cache.getReportCached(cacheKey);
      if (!entry) {
        const items = await s.reports.listSummary(req.user ?? null, { scope, bbox, category, status, limit });
        entry = s.cache.setReportCached(cacheKey, items, 20_000);
      }
      res.set('ETag', entry.etag);
      res.set('Cache-Control', 'public, max-age=10, stale-while-revalidate=30');
      if (req.headers['if-none-match'] === entry.etag) {
        res.status(304).end();
        return;
      }
      res.json(entry.body);
    },
    list: async (req: Request, res: Response) => {
      const category = typeof req.query.category === 'string' && req.query.category ? req.query.category : undefined;
      const cursor = typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : undefined;
      const scope = scopeOf(req);
      const paginated = req.query.paginated === '1' || cursor !== undefined || req.query.limit !== undefined;
      if (paginated) {
        const rawStatus = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
        const status = rawStatus && VALID_STATUSES.has(rawStatus) ? (rawStatus as ReportStatus) : undefined;
        const limit = Math.min(Math.max(1, Number(req.query.limit) || 20), 100);
        if (!req.user) {
          const cacheKey = `list_pag:pub:${scope}:${category ?? ''}:${status ?? ''}:${cursor ?? ''}:${limit}`;
          let entry = s.cache.getReportCached(cacheKey);
          if (!entry) {
            entry = s.cache.setReportCached(
              cacheKey,
              await s.reports.listPaginated(null, { scope, category, status, cursor, limit }),
              20_000,
            );
          }
          res.set('ETag', entry.etag);
          res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=45');
          if (req.headers['if-none-match'] === entry.etag) {
            res.status(304).end();
            return;
          }
          res.json(entry.body);
          return;
        }
        res.json(await s.reports.listPaginated(req.user, { scope, category, status, cursor, limit }));
        return;
      }
      if (!req.user) {
        const cacheKey = `list_all:pub:${scope}:${category ?? ''}`;
        let entry = s.cache.getReportCached(cacheKey);
        if (!entry) {
          entry = s.cache.setReportCached(cacheKey, await s.reports.list(null, scope, category), 20_000);
        }
        res.set('ETag', entry.etag);
        res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=45');
        if (req.headers['if-none-match'] === entry.etag) {
          res.status(304).end();
          return;
        }
        res.json(entry.body);
        return;
      }
      res.json(await s.reports.list(req.user, scope, category));
    },
    mine: async (req: Request, res: Response) => {
      res.json(await s.reports.mine(req.user!));
    },
    lookup: async (req: Request, res: Response) => {
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      res.json(await s.reports.lookup(req.user ?? null, q));
    },
    get: async (req: Request, res: Response) => {
      res.json(toClientReport(await s.reports.getVisible(req.user ?? null, String(req.params.id))));
    },
    create: async (req: Request, res: Response) => {
      const u = req.user!;
      if (normalizeRole(u.role) !== 'citizen') {
        throw forbidden('Tài khoản nội bộ (Quản trị / Cán bộ / Đội cứu hộ) không gửi phản ánh công dân trực tiếp.');
      }
      const b = body(req, 'createReport') as CreateReportInput;
      const photoInput = await resolvePhotoInputFromRequest(req, b.photo, b.dHash);
      const rateLimitKey = `rp:${req.ip ?? 'ip'}:${u.id}`;
      const result = await s.reports.create(u, { ...b, photoInput, rateLimitKey });
      res.status(result.outcome === 'duplicate_submit' ? 200 : 201).json(result);
    },
    confirm: async (req: Request, res: Response) => {
      res.json(await s.reports.confirm(req.user!, String(req.params.id)));
    },
    attachPhoto: async (req: Request, res: Response) => {
      const b = body(req, 'attachPhoto');
      const photoInput = await resolvePhotoInputFromRequest(req, b.photo, b.dHash);
      res.json(await s.reports.attachPhoto(req.user!, String(req.params.id), photoInput));
    },
    rate: async (req: Request, res: Response) => {
      const { stars, comment } = body(req, 'rate');
      res.json(await s.reports.rate(req.user!, String(req.params.id), stars, comment));
    },
  };
}

export function volunteerController(s: Services) {
  return {
    tasks: async (req: Request, res: Response) => {
      res.json(await s.staff.volunteerTasks(req.user!));
    },
    accept: async (req: Request, res: Response) => {
      res.json(await s.staff.acceptTask(req.user!, String(req.params.id)));
    },
    verify: async (req: Request, res: Response) => {
      const b = body(req, 'volunteerVerify');
      const hasPhoto = Boolean(req.uploadedImages?.displayBuffer || b.photo?.dataUrl);
      const photoInput = hasPhoto ? await resolvePhotoInputFromRequest(req, b.photo) : undefined;
      res.json(await s.staff.verifyTask(req.user!, String(req.params.id), b.verdict, b.note, photoInput));
    },
    proxyReport: async (req: Request, res: Response) => {
      const u = req.user!;
      const b = body(req, 'createReport') as CreateReportInput;
      const photoInput = await resolvePhotoInputFromRequest(req, b.photo, b.dHash);
      const rateLimitKey = `proxy:${req.ip ?? 'ip'}:${u.id}`;
      const result = await s.reports.create(u, { ...b, photoInput, rateLimitKey }, u.id);
      if (result.outcome !== 'duplicate_submit') await s.staff.awardProxyCredit(u);
      res.status(result.outcome === 'duplicate_submit' ? 200 : 201).json(result);
    },
    leaderboard: async (_req: Request, res: Response) => {
      res.json(await s.staff.leaderboard());
    },
    logbook: async (req: Request, res: Response) => {
      res.json(await s.staff.logbook(req.user!));
    },
  };
}

export function rescueController(s: Services) {
  return {
    missions: async (req: Request, res: Response) => {
      const lat = req.query.lat !== undefined ? Number(req.query.lat) : undefined;
      const lng = req.query.lng !== undefined ? Number(req.query.lng) : undefined;
      const radiusKm = req.query.radiusKm !== undefined ? Number(req.query.radiusKm) : undefined;
      const wardCode = typeof req.query.wardCode === 'string' && req.query.wardCode ? req.query.wardCode : undefined;
      const includeResolved = req.query.includeResolved === '1' || req.query.includeResolved === 'true';
      res.json(
        await s.staff.rescueMissions(req.user!, {
          lat,
          lng,
          radiusKm,
          wardCode,
          includeResolved,
        }),
      );
    },
    accept: async (req: Request, res: Response) => {
      const b = body(req, 'rescueAccept');
      res.json(await s.staff.acceptRescueMission(req.user!, String(req.params.id), b.lat, b.lng));
    },
    updateStatus: async (req: Request, res: Response) => {
      const b = body(req, 'rescueStatus');
      const rawStep = (b.status ?? b.step ?? 'en_route').toLowerCase();
      const normalizedStep = (rawStep === 'completed' ? 'resolved' : rawStep) as
        | 'accepted'
        | 'en_route'
        | 'arrived'
        | 'in_progress'
        | 'on_site'
        | 'resolved';
      const hasPhoto = Boolean(req.uploadedImages?.displayBuffer || b.afterPhoto?.dataUrl);
      const afterPhoto = hasPhoto ? await resolvePhotoInputFromRequest(req, b.afterPhoto) : undefined;
      res.json(
        await s.staff.updateRescueMissionStatus(
          req.user!,
          String(req.params.id),
          normalizedStep,
          b.note,
          b.lat,
          b.lng,
          afterPhoto,
          b.override,
          b.edge,
          b.exif,
          process.env.NODE_ENV === 'test' && Boolean(b.afterPhoto?.dataUrl),
        ),
      );
    },
    release: async (req: Request, res: Response) => {
      const b = body(req, 'rescueRelease');
      res.json(await s.staff.releaseRescueMission(req.user!, String(req.params.id), b.reason, b.lat, b.lng));
    },
    updateLocation: async (req: Request, res: Response) => {
      const b = body(req, 'rescueLocation');
      res.json(
        await s.staff.updateRescueMissionLocation(
          req.user!,
          String(req.params.id),
          b.lat,
          b.lng,
          b.heading ?? null,
          b.speed ?? null,
        ),
      );
    },
    complete: async (req: Request, res: Response) => {
      const b = body(req, 'rescueComplete');
      const afterPhoto = await resolvePhotoInputFromRequest(req, b.afterPhoto, b.dHash);
      res.json(
        await s.staff.completeRescueMission(
          req.user!,
          String(req.params.id),
          afterPhoto,
          b.note,
          b.override,
          b.edge,
          b.lat,
          b.lng,
          b.exif,
          process.env.NODE_ENV === 'test' && Boolean(b.afterPhoto?.dataUrl),
        ),
      );
    },
  };
}

export function adminController(s: Services) {
  const scope = (req: Request): string => {
    const q = typeof req.query.scope === 'string' ? req.query.scope : undefined;
    return s.staff.resolveScope(req.user!, q);
  };
  const reportSnap = (r: { id: string; status: string; severity?: number | string; wardCode: string; assignedTo?: unknown } | null) =>
    r ? { id: r.id, status: r.status, severity: r.severity, wardCode: r.wardCode, assignedTo: r.assignedTo ?? null } : null;
  const userSnap = (u: { id: string; role: string; name: string; wardCode: string | null; revoked?: boolean; trustScore: number; trustLevel?: string } | null) =>
    u
      ? {
          id: u.id,
          role: u.role,
          name: u.name,
          wardCode: u.wardCode,
          revoked: Boolean(u.revoked),
          trustScore: u.trustScore,
          trustLevel: u.trustLevel ?? 'normal',
        }
      : null;
  const secAudit = (
    req: Request,
    action: string,
    targetType: string,
    targetId: string,
    beforeState: unknown,
    afterState: unknown,
    metadata?: Record<string, unknown>,
  ): void => {
    const meta = extractClientMeta(req);
    void s.securityAudit
      .log({
        actorId: req.user?.id ?? 'unknown',
        actorName: req.user?.name ?? 'Unknown',
        actorRole: req.user?.role ?? 'unknown',
        action,
        targetType,
        targetId,
        ip: meta.ip,
        deviceHash: meta.deviceHash,
        userAgent: meta.userAgent,
        beforeState,
        afterState,
        metadata,
      })
      .catch(() => undefined);
  };
  return {
    overview: async (req: Request, res: Response) => {
      const resolvedScope = scope(req);
      const cacheKey = `admin_overview:${resolvedScope}:${req.user?.role ?? 'staff'}`;
      let entry = s.cache.getReportCached(cacheKey);
      if (!entry) {
        entry = s.cache.setReportCached(cacheKey, await s.staff.overview(req.user!, resolvedScope), 15_000);
      }
      res.set('ETag', entry.etag);
      res.set('Cache-Control', 'private, max-age=10');
      if (req.headers['if-none-match'] === entry.etag) {
        res.status(304).end();
        return;
      }
      res.json(entry.body);
    },
    queue: async (req: Request, res: Response) => {
      const tab = String(req.query.tab ?? 'open');
      if (!['emergency', 'high', 'open', 'quarantine'].includes(tab)) throw badRequest('Tab không hợp lệ.');
      res.json(await s.staff.queue(req.user!, scope(req), tab as 'emergency' | 'high' | 'open' | 'quarantine'));
    },
    assign: async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const b = body(req, 'assign');
      const before = await s.repos.reports.get(id);
      const out = await s.staff.assign(req.user!, id, b.department as never, b.slaHours);
      secAudit(req, 'admin.report_assign', 'report', id, reportSnap(before), b);
      res.json(out);
    },
    status: async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const b = body(req, 'status');
      const before = await s.repos.reports.get(id);
      const out = await s.staff.setStatus(req.user!, id, b.status);
      secAudit(req, 'admin.report_status', 'report', id, reportSnap(before), { status: b.status });
      res.json(out);
    },
    dispatch: async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const b = body(req, 'dispatch');
      const before = await s.repos.reports.get(id);
      const out = await s.staff.dispatch(req.user!, id, b.wardCodes, b.units as never, b.note);
      secAudit(req, 'admin.report_dispatch', 'report', id, reportSnap(before), { wardCodes: b.wardCodes, units: b.units, note: b.note });
      res.json(out);
    },
    transfer: async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const b = body(req, 'transferWard');
      const before = await s.repos.reports.get(id);
      const out = await s.staff.transferWard(req.user!, id, b.wardCode, b.note);
      secAudit(req, 'admin.report_transfer', 'report', id, reportSnap(before), { wardCode: b.wardCode, note: b.note });
      res.json(out);
    },
    restore: async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const before = await s.repos.reports.get(id);
      const out = await s.staff.restore(req.user!, id);
      secAudit(req, 'admin.report_restore', 'report', id, reportSnap(before), { restored: true });
      res.json(out);
    },
    spam: async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const reason = body(req, 'markSpam').reason;
      const before = await s.repos.reports.get(id);
      const out = await s.staff.markSpam(req.user!, id, reason);
      secAudit(req, 'admin.report_mark_spam', 'report', id, reportSnap(before), { reason });
      res.json(out);
    },
    resolve: async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const b = body(req, 'resolve');
      const before = await s.repos.reports.get(id);
      const afterPhoto = await resolvePhotoInputFromRequest(req, b.afterPhoto, b.dHash);
      const out = await s.staff.resolve(req.user!, id, afterPhoto, b.note, b.override, {
        lat: b.lat,
        lng: b.lng,
        edge: b.edge,
        exif: b.exif,
        allowTinyTestStub: process.env.NODE_ENV === 'test' && Boolean(b.afterPhoto?.dataUrl) && (b.afterPhoto?.dataUrl?.length ?? 0) < 900,
      });
      secAudit(req, 'admin.report_resolve', 'report', id, reportSnap(before), { note: b.note, override: Boolean(b.override) });
      res.json(out);
    },
    audit: async (req: Request, res: Response) => {
      const limit = Math.min(Number(req.query.limit) || 200, 1000);
      const action = typeof req.query.action === 'string' && req.query.action ? req.query.action : undefined;
      const actorId = typeof req.query.actorId === 'string' && req.query.actorId ? req.query.actorId : undefined;
      const targetId = typeof req.query.targetId === 'string' && req.query.targetId ? req.query.targetId : undefined;
      const q = typeof req.query.q === 'string' && req.query.q ? req.query.q : undefined;
      const rows = await s.staff.auditListFiltered({ limit, action, actorId, targetId, q });
      res.json(isAdminRole(req.user) ? rows : rows.filter((e) => e.actorId === req.user!.id));
    },
    auditExport: async (req: Request, res: Response) => {
      const format = req.query.format === 'json' ? 'json' : 'csv';
      const action = typeof req.query.action === 'string' && req.query.action ? req.query.action : undefined;
      const actorId = typeof req.query.actorId === 'string' && req.query.actorId ? req.query.actorId : undefined;
      const targetId = typeof req.query.targetId === 'string' && req.query.targetId ? req.query.targetId : undefined;
      const q = typeof req.query.q === 'string' && req.query.q ? req.query.q : undefined;
      const out = await s.staff.auditExport(req.user!, { action, actorId, targetId, q }, format);
      res.set({ 'Content-Type': out.contentType, 'Content-Disposition': `attachment; filename="${out.filename}"` }).send(out.body);
    },
    auditVerify: async (_req: Request, res: Response) => {
      res.json(await s.audit.verifyChain());
    },
    securityAuditLogs: async (req: Request, res: Response) => {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      const action = typeof req.query.action === 'string' && req.query.action ? req.query.action : undefined;
      const actorId = typeof req.query.actorId === 'string' && req.query.actorId ? req.query.actorId : undefined;
      res.json(await s.securityAudit.listRecent({ limit, action, actorId }));
    },
    moderationQueue: async (req: Request, res: Response) => {
      res.json(await s.staff.moderationQueue(req.user!, scope(req)));
    },
    moderationDecide: async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const b = body(req, 'adminModerationDecision');
      const before = await s.repos.reports.get(id);
      const out = await s.staff.decideModeration(req.user!, id, b, req.ip);
      secAudit(req, 'admin.moderation_decide', 'report', id, reportSnap(before), b);
      res.json(out);
    },
    listSessions: async (req: Request, res: Response) => {
      const userId = typeof req.query.userId === 'string' && req.query.userId ? req.query.userId : undefined;
      const includeRevoked = req.query.includeRevoked === 'true';
      res.json(await s.staff.listSessions(req.user!, { userId, includeRevoked }));
    },
    revokeSession: async (req: Request, res: Response) => {
      const sessionId = String(req.params.sessionId);
      const out = await s.staff.revokeSessionById(req.user!, sessionId, req.ip);
      secAudit(req, 'admin.session_revoke', 'session', sessionId, null, out);
      res.json(out);
    },
    forceLogoutUser: async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const before = await s.repos.users.get(id);
      const out = await s.staff.forceLogoutUser(req.user!, id, req.ip);
      secAudit(req, 'admin.user_force_logout', 'user', id, userSnap(before), out);
      res.json(out);
    },
    forceLogoutAll: async (req: Request, res: Response) => {
      const out = await s.staff.forceLogoutAllSystem(req.user!, req.sessionId!, req.ip);
      secAudit(req, 'admin.force_logout_all', 'system', 'sessions', null, out);
      res.json(out);
    },
    userViolations: async (req: Request, res: Response) => {
      res.json(await s.staff.getUserViolations(req.user!, String(req.params.id)));
    },
    flagUserTrust: async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const b = body(req, 'adminTrustFlag');
      const before = await s.repos.users.get(id);
      const out = await s.staff.flagUserTrust(req.user!, id, b, req.ip);
      secAudit(req, 'admin.user_trust_flag', 'user', id, userSnap(before), b);
      res.json(out);
    },
    staff: async (_req: Request, res: Response) => {
      res.json(await s.staff.staffList());
    },
    createStaff: async (req: Request, res: Response) => {
      const b = body(req, 'createStaff');
      const out = await s.staff.createOfficer(req.user!, b);
      secAudit(req, 'admin.staff_create', 'user', b.staffCode, null, { staffCode: b.staffCode, wardCode: b.wardCode ?? null });
      res.status(201).json(out);
    },
    revokeStaff: async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const b = body(req, 'revokeStaff');
      const before = await s.repos.users.get(id);
      const out = await s.staff.setStaffRevoked(req.user!, id, b.revoked);
      secAudit(req, 'admin.staff_revoke', 'user', id, userSnap(before), { revoked: b.revoked });
      res.json(out);
    },
    // Super Admin & Admin User CRUD + AI Config
    listUsers: async (req: Request, res: Response) => {
      const role = typeof req.query.role === 'string' && req.query.role ? req.query.role : undefined;
      const wardCode = typeof req.query.wardCode === 'string' && req.query.wardCode ? req.query.wardCode : undefined;
      const isActive =
        req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : undefined;
      const q = typeof req.query.q === 'string' ? req.query.q : undefined;
      res.json(await s.staff.listUsers(req.user!, { role, wardCode, isActive, q }));
    },
    createUser: async (req: Request, res: Response) => {
      const b = body(req, 'adminCreateUser');
      const out = await s.staff.createUser(req.user!, b);
      secAudit(req, 'admin.user_create', 'user', String((out as { id?: string }).id ?? b.email ?? b.phone ?? 'new'), null, {
        role: b.role,
        wardCode: b.wardCode ?? null,
      });
      res.status(201).json(out);
    },
    updateUser: async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const b = body(req, 'adminUpdateUser');
      const before = await s.repos.users.get(id);
      const out = await s.staff.updateUser(req.user!, id, b);
      secAudit(req, 'admin.user_update', 'user', id, userSnap(before), b);
      res.json(out);
    },
    resetUserPassword: async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const b = body(req, 'adminResetPassword');
      const out = await s.staff.resetUserPassword(req.user!, id, b.newPassword);
      secAudit(req, 'admin.user_reset_password', 'user', id, null, { reset: true });
      res.json(out);
    },
    deleteUser: async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const before = await s.repos.users.get(id);
      const out = await s.staff.deleteUser(req.user!, id);
      secAudit(req, 'admin.user_delete', 'user', id, userSnap(before), { deleted: true });
      res.json(out);
    },
    getAiConfig: async (_req: Request, res: Response) => {
      const [config, cv, llm, dbStats, recentEvaluations] = await Promise.all([
        s.cvEngine.getConfig(),
        s.cvEngine.health(),
        s.gemini.checkLocalLlmHealth(),
        s.repos.healthStats(),
        s.repos.evaluations.recent(25),
      ]);
      res.json({
        config,
        engines: {
          cvEngine: cv,
          localLlm: llm,
          ragDocs: s.rag.documentCount,
          db: { mode: s.repos.mode, ...dbStats },
        },
        recentEvaluations,
      });
    },
    updateAiConfig: async (req: Request, res: Response) => {
      const b = body(req, 'adminUpdateAiConfig');
      const prev = await s.cvEngine.getConfig();
      const next = await s.cvEngine.updateConfig(b, req.user!.id);
      await s.audit.log(
        { id: req.user!.id, name: req.user!.name, role: req.user!.role },
        'admin.ai_config_update',
        'ai_config',
        prev,
        next,
      );
      secAudit(req, 'admin.ai_config_update', 'ai_config', 'singleton', prev, next);
      res.json(next);
    },
    purgeDemo: async (req: Request, res: Response) => {
      const summary = await purgeDemoData(s.repos, s.audit, req.user!);
      secAudit(req, 'admin.purge_demo', 'system', 'demo_seed', null, summary);
      res.json(summary);
    },
    export: async (req: Request, res: Response) => {
      const format = req.query.format === 'json' ? 'json' : 'csv';
      const month = typeof req.query.month === 'string' ? req.query.month : '2026-11';
      const out = await s.staff.export(req.user!, scope(req), month, format);
      res.set({ 'Content-Type': out.contentType, 'Content-Disposition': `attachment; filename="${out.filename}"` }).send(out.body);
    },
  };
}

export function metaController(
  s: Services,
  bootInfo: { fallbackReason: string | null; dbState?: string; lastError?: string | null },
) {
  async function buildHealthPayload() {
    const [dbStats, cv, llm] = await Promise.all([
      s.repos.healthStats(),
      s.cvEngine.health(),
      s.gemini.checkLocalLlmHealth(),
    ]);
    const ai = s.gemini.status;
    const otp = s.otpDelivery.status;
    const aiMode = llm.online
      ? 'ollama'
      : ai.configured && !ai.circuitOpen
        ? 'gemini'
        : 'fallback';
    const dbState = bootInfo.dbState ?? (dbStats.ok ? 'connected' : 'reconnecting');
    const status = dbStats.ok
      ? cv.online || llm.online || (ai.configured && !ai.circuitOpen)
        ? 'ok'
        : 'degraded'
      : dbState === 'connecting' || dbState === 'reconnecting'
        ? 'connecting'
        : 'down';
    return {
      ok: dbStats.ok,
      body: {
        status,
        time: new Date().toISOString(),
        uptimeSec: Math.round(process.uptime()),
        db: {
          mode: s.repos.mode,
          state: dbState,
          ok: dbStats.ok,
          latencyMs: dbStats.latencyMs,
          counts: dbStats.counts,
          note: bootInfo.fallbackReason,
          lastError: bootInfo.lastError ?? null,
        },
        cvEngine: cv,
        localLlm: llm,
        rag: { indexedDocuments: s.rag.documentCount },
        ai: { ...ai, mode: aiMode },
        otp,
        wardsCount: DONG_NAI_WARDS.length,
      },
    };
  }

  return {
    /** Liveness probe cho Render (`/healthz`): trả về trong <2ms hoàn toàn từ bộ nhớ trong, không truy vấn DB nặng. */
    liveness: async (_req: Request, res: Response) => {
      const ai = s.gemini.status;
      const aiMode = ai.configured && !ai.circuitOpen ? 'gemini' : 'fallback';
      const dbState = bootInfo.dbState ?? (s.repos.mode === 'mongodb' ? 'connected' : 'reconnecting');
      res.status(200).json({
        status: 'ok',
        time: new Date().toISOString(),
        uptimeSec: Math.round(process.uptime()),
        db: {
          mode: s.repos.mode,
          state: dbState,
          ok: true,
          latencyMs: 0,
          note: bootInfo.fallbackReason,
          lastError: bootInfo.lastError ?? null,
        },
        ai: { ...ai, mode: aiMode },
        wardsCount: DONG_NAI_WARDS.length,
      });
    },
    /** Readiness & Diagnostics (`/api/health`): trả 200 khi DB sẵn sàng, 503 khi DB đang kết nối lại hoặc lỗi. */
    health: async (_req: Request, res: Response) => {
      const { ok, body } = await buildHealthPayload();
      res.status(ok ? 200 : 503).json(body);
    },
  };
}
