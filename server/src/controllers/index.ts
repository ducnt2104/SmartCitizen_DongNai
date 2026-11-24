import type { Request, Response } from 'express';
import { DONG_NAI_WARDS } from '../../../shared/dongNaiWards';
import { toClientReport } from '../../../shared/report';
import { badRequest, forbidden } from '../utils/errors';
import type { Services } from '../services/container';
import { toProfile } from '../services/trust.service';
import { env } from '../config/env';
import type { CreateReportInput } from '../validation/schemas';
import { schemas } from '../validation/schemas';
import type { z } from 'zod';

const SCOPE_RE = /^(city|ward:DN-[A-Z]{2,4})$/;

function scopeOf(req: Request): string {
  const s = typeof req.query.scope === 'string' ? req.query.scope : 'city';
  if (!SCOPE_RE.test(s)) throw badRequest('Phạm vi không hợp lệ.', 'invalid_scope');
  return s;
}

function body<T extends keyof typeof schemas>(req: Request, _k: T): z.infer<(typeof schemas)[T]> {
  void _k;
  return req.body as z.infer<(typeof schemas)[T]>;
}

export function authController(s: Services) {
  return {
    otpRequest: async (req: Request, res: Response) => {
      const { phone } = body(req, 'otpRequest');
      res.json(await s.auth.requestOtp(phone));
    },
    otpVerify: async (req: Request, res: Response) => {
      const { phone, code } = body(req, 'otpVerify');
      res.json(await s.auth.verifyOtp(phone, code));
    },
    googleMock: async (req: Request, res: Response) => {
      const { name, email } = body(req, 'googleMock');
      res.json(await s.auth.googleMock(name, email));
    },
    staffLogin: async (req: Request, res: Response) => {
      const { staffCode, password, unit } = body(req, 'staffLogin');
      res.json(await s.auth.staffLogin(staffCode, password, unit));
    },
    demo: async (req: Request, res: Response) => {
      const { kind } = body(req, 'demoLogin');
      res.json(await s.auth.demoLogin(kind));
    },
    registerVolunteer: async (req: Request, res: Response) => {
      const { wardCode, unitCode } = body(req, 'volunteerRegister');
      res.json(await s.auth.registerVolunteer(req.user!.id, wardCode, unitCode));
    },
    me: async (req: Request, res: Response) => {
      res.json({ user: toProfile(req.user!) });
    },
    readNotifications: async (req: Request, res: Response) => {
      await s.auth.markNotificationsRead(req.user!.id);
      res.json({ ok: true });
    },
  };
}

export function reportController(s: Services) {
  return {
    wards: async (_req: Request, res: Response) => {
      res.set('Cache-Control', 'public, max-age=86400').json(DONG_NAI_WARDS);
    },
    stats: async (req: Request, res: Response) => {
      res.json(await s.reports.stats(scopeOf(req)));
    },
    list: async (req: Request, res: Response) => {
      const category = typeof req.query.category === 'string' ? req.query.category : undefined;
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
      if (u.role !== 'citizen' && u.role !== 'volunteer') throw forbidden('Tài khoản cán bộ không gửi phản ánh trực tiếp.');
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
      res.json(req.user!.role === 'city_admin' ? rows : rows.filter((e) => e.actorId === req.user!.id));
    },
    auditVerify: async (_req: Request, res: Response) => {
      res.json(await s.audit.verifyChain());
    },
    staff: async (_req: Request, res: Response) => {
      res.json(await s.staff.staffList());
    },
    export: async (req: Request, res: Response) => {
      const format = req.query.format === 'json' ? 'json' : 'csv';
      const month = typeof req.query.month === 'string' ? req.query.month : '2026-11';
      const out = await s.staff.export(req.user!, scope(req), month, format);
      res.set({ 'Content-Type': out.contentType, 'Content-Disposition': `attachment; filename="${out.filename}"` }).send(out.body);
    },
  };
}

export function metaController(s: Services, bootInfo: { fallbackReason: string | null }) {
  return {
    health: async (_req: Request, res: Response) => {
      const dbOk = await s.repos.ping().catch(() => false);
      const ai = s.gemini.status;
      const body = {
        status: dbOk ? (ai.configured && !ai.circuitOpen ? 'ok' : 'degraded') : 'down',
        time: new Date().toISOString(),
        uptimeSec: Math.round(process.uptime()),
        db: { mode: s.repos.mode, ok: dbOk, note: bootInfo.fallbackReason },
        ai: { ...ai, mode: ai.configured && !ai.circuitOpen ? 'gemini' : 'fallback' },
        demo: { otp: env.demoOtp, auth: env.enableDemoAuth },
      };
      res.status(dbOk ? 200 : 503).json(body);
    },
  };
}
