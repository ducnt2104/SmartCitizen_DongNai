import type { Request, Response } from 'express';
import { normalizeRole } from '../shared/constants';
import { normalizeCoordinates } from '../shared/coordinates';
import { DONG_NAI_WARDS } from '../shared/dongNaiWards';
import { toClientReport } from '../shared/report';
import type { ReportStatus } from '../shared/types';
import { purgeDemoData } from '../data/seedStore';
import { clearAuthCookies, readCookie, REFRESH_COOKIE, setAuthCookies } from '../middleware/auth';
import type { BoundingBoxQuery } from '../repositories/types';
import { isAdminRole } from '../services/access';
import type { Services } from '../services/container';
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
      const issued = await s.auth.verifyOtp(target, b.code, {
        name: b.name,
        password: b.password,
        defaultWardCode: b.defaultWardCode,
        userAgent: req.get('user-agent') ?? '',
      });
      setAuthCookies(res, issued.session.token, issued.refreshToken, issued.refreshMaxAgeMs);
      res.json(issued.session);
    },
    passwordLogin: async (req: Request, res: Response) => {
      const b = body(req, 'passwordLogin');
      const issued = await s.auth.passwordLogin(b.identifier, b.password, req.get('user-agent') ?? '');
      setAuthCookies(res, issued.session.token, issued.refreshToken, issued.refreshMaxAgeMs);
      res.json(issued.session);
    },
    passwordReset: async (req: Request, res: Response) => {
      const b = body(req, 'passwordReset');
      const issued = await s.auth.resetPassword(b.identifier, b.code, b.newPassword, req.get('user-agent') ?? '');
      setAuthCookies(res, issued.session.token, issued.refreshToken, issued.refreshMaxAgeMs);
      res.json(issued.session);
    },
    staffLogin: async (req: Request, res: Response) => {
      const b = body(req, 'staffLogin');
      const target = (b.staffCode ?? b.identifier ?? '').trim();
      const issued = await s.auth.staffLogin(target, b.password, b.unit, req.get('user-agent') ?? '');
      setAuthCookies(res, issued.session.token, issued.refreshToken, issued.refreshMaxAgeMs);
      res.json(issued.session);
    },
    rescueLogin: async (req: Request, res: Response) => {
      const { identifier, password } = body(req, 'rescueLogin');
      const issued = await s.auth.rescueLogin(identifier, password, req.get('user-agent') ?? '');
      setAuthCookies(res, issued.session.token, issued.refreshToken, issued.refreshMaxAgeMs);
      res.json(issued.session);
    },
    refresh: async (req: Request, res: Response) => {
      const token = readCookie(req, REFRESH_COOKIE);
      try {
        const issued = await s.auth.refreshSession(token, req.get('user-agent') ?? '');
        setAuthCookies(res, issued.session.token, issued.refreshToken, issued.refreshMaxAgeMs);
        res.json(issued.session);
      } catch (err) {
        clearAuthCookies(res);
        throw err;
      }
    },
    logout: async (req: Request, res: Response) => {
      await s.auth.logout(readCookie(req, REFRESH_COOKIE));
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
      const issued = await s.auth.registerVolunteer(req.user!.id, wardCode, unitCode);
      setAuthCookies(res, issued.session.token, issued.refreshToken, issued.refreshMaxAgeMs);
      res.json(issued.session);
    },
    me: async (req: Request, res: Response) => {
      res.json({ user: toProfile(req.user!) });
    },
    updateProfile: async (req: Request, res: Response) => {
      const b = body(req, 'updateProfile');
      const updated = await s.auth.updateProfile(req.user!.id, b);
      res.json({ user: toProfile(updated) });
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
    stats: async (req: Request, res: Response) => {
      res.json(await s.reports.stats(scopeOf(req)));
    },
    summary: async (req: Request, res: Response) => {
      const category = typeof req.query.category === 'string' && req.query.category ? req.query.category : undefined;
      const rawStatus = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
      const status = rawStatus && VALID_STATUSES.has(rawStatus) ? (rawStatus as ReportStatus) : undefined;
      const bbox = parseBbox(req.query.bbox);
      const limit = Math.min(Math.max(1, Number(req.query.limit) || 1500), 5000);
      res.json(await s.reports.listSummary(req.user ?? null, { scope: scopeOf(req), bbox, category, status, limit }));
    },
    list: async (req: Request, res: Response) => {
      const category = typeof req.query.category === 'string' && req.query.category ? req.query.category : undefined;
      const cursor = typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : undefined;
      const paginated = req.query.paginated === '1' || cursor !== undefined || req.query.limit !== undefined;
      if (paginated) {
        const rawStatus = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
        const status = rawStatus && VALID_STATUSES.has(rawStatus) ? (rawStatus as ReportStatus) : undefined;
        const limit = Math.min(Math.max(1, Number(req.query.limit) || 20), 100);
        res.json(await s.reports.listPaginated(req.user ?? null, { scope: scopeOf(req), category, status, cursor, limit }));
        return;
      }
      res.json(await s.reports.list(req.user ?? null, scopeOf(req), category));
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
      const result = await s.reports.create(u, body(req, 'createReport') as CreateReportInput);
      res.status(result.outcome === 'duplicate_submit' ? 200 : 201).json(result);
    },
    confirm: async (req: Request, res: Response) => {
      res.json(await s.reports.confirm(req.user!, String(req.params.id)));
    },
    attachPhoto: async (req: Request, res: Response) => {
      res.json(await s.reports.attachPhoto(req.user!, String(req.params.id), body(req, 'attachPhoto').photo));
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
      res.json(await s.staff.verifyTask(req.user!, String(req.params.id), b.verdict, b.note, b.photo));
    },
    proxyReport: async (req: Request, res: Response) => {
      const u = req.user!;
      const result = await s.reports.create(u, body(req, 'createReport') as CreateReportInput, u.id);
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
      res.json(
        await s.staff.updateRescueMissionStatus(
          req.user!,
          String(req.params.id),
          normalizedStep,
          b.note,
          b.lat,
          b.lng,
          b.afterPhoto,
          b.override,
          b.edge,
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
      res.json(
        await s.staff.completeRescueMission(
          req.user!,
          String(req.params.id),
          b.afterPhoto,
          b.note,
          b.override,
          b.edge,
          b.lat,
          b.lng,
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
  return {
    overview: async (req: Request, res: Response) => {
      res.json(await s.staff.overview(req.user!, scope(req)));
    },
    queue: async (req: Request, res: Response) => {
      const tab = String(req.query.tab ?? 'open');
      if (!['emergency', 'high', 'open', 'quarantine'].includes(tab)) throw badRequest('Tab không hợp lệ.');
      res.json(await s.staff.queue(req.user!, scope(req), tab as 'emergency' | 'high' | 'open' | 'quarantine'));
    },
    assign: async (req: Request, res: Response) => {
      const b = body(req, 'assign');
      res.json(await s.staff.assign(req.user!, String(req.params.id), b.department as never, b.slaHours));
    },
    status: async (req: Request, res: Response) => {
      res.json(await s.staff.setStatus(req.user!, String(req.params.id), body(req, 'status').status));
    },
    dispatch: async (req: Request, res: Response) => {
      const b = body(req, 'dispatch');
      res.json(await s.staff.dispatch(req.user!, String(req.params.id), b.wardCodes, b.units as never, b.note));
    },
    transfer: async (req: Request, res: Response) => {
      const b = body(req, 'transferWard');
      res.json(await s.staff.transferWard(req.user!, String(req.params.id), b.wardCode, b.note));
    },
    restore: async (req: Request, res: Response) => {
      res.json(await s.staff.restore(req.user!, String(req.params.id)));
    },
    spam: async (req: Request, res: Response) => {
      res.json(await s.staff.markSpam(req.user!, String(req.params.id), body(req, 'markSpam').reason));
    },
    resolve: async (req: Request, res: Response) => {
      const b = body(req, 'resolve');
      res.json(await s.staff.resolve(req.user!, String(req.params.id), b.afterPhoto, b.note, b.override));
    },
    audit: async (req: Request, res: Response) => {
      const limit = Math.min(Number(req.query.limit) || 200, 1000);
      const rows = await s.staff.auditList(limit);
      res.json(isAdminRole(req.user) ? rows : rows.filter((e) => e.actorId === req.user!.id));
    },
    auditVerify: async (_req: Request, res: Response) => {
      res.json(await s.audit.verifyChain());
    },
    staff: async (_req: Request, res: Response) => {
      res.json(await s.staff.staffList());
    },
    createStaff: async (req: Request, res: Response) => {
      const b = body(req, 'createStaff');
      res.status(201).json(await s.staff.createOfficer(req.user!, b));
    },
    revokeStaff: async (req: Request, res: Response) => {
      const b = body(req, 'revokeStaff');
      res.json(await s.staff.setStaffRevoked(req.user!, String(req.params.id), b.revoked));
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
      res.status(201).json(await s.staff.createUser(req.user!, b));
    },
    updateUser: async (req: Request, res: Response) => {
      const b = body(req, 'adminUpdateUser');
      res.json(await s.staff.updateUser(req.user!, String(req.params.id), b));
    },
    resetUserPassword: async (req: Request, res: Response) => {
      const b = body(req, 'adminResetPassword');
      res.json(await s.staff.resetUserPassword(req.user!, String(req.params.id), b.newPassword));
    },
    deleteUser: async (req: Request, res: Response) => {
      res.json(await s.staff.deleteUser(req.user!, String(req.params.id)));
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
      res.json(next);
    },
    purgeDemo: async (req: Request, res: Response) => {
      const summary = await purgeDemoData(s.repos, s.audit, req.user!);
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
    /** Liveness probe cho Render (`/healthz`): luôn trả HTTP 200 khi HTTP server sống để tránh container bị kill lúc DB cold-start. */
    liveness: async (_req: Request, res: Response) => {
      const { body } = await buildHealthPayload();
      res.status(200).json(body);
    },
    /** Readiness & Diagnostics (`/api/health`): trả 200 khi DB sẵn sàng, 503 khi DB đang kết nối lại hoặc lỗi. */
    health: async (_req: Request, res: Response) => {
      const { ok, body } = await buildHealthPayload();
      res.status(ok ? 200 : 503).json(body);
    },
  };
}
