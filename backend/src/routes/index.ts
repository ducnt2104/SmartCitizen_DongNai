import { Router } from 'express';
import { authMiddleware, asyncHandler } from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
import { issuePowChallengeHandler, securityMiddleware } from '../middleware/security';
import { parseMultipartOrJson } from '../middleware/upload';
import { validateBody } from '../middleware/validate';
import {
  adminController,
  authController,
  metaController,
  reportController,
  rescueController,
  volunteerController,
} from '../controllers';
import { aiController } from '../controllers/ai.controller';
import { alertsController } from '../controllers/alerts.controller';
import type { Services } from '../services/container';
import { schemas } from '../validation/schemas';
import { buildApiKeysRouter } from './apiKeys';
import { buildAuthRouter } from './auth';

export function buildRouter(
  s: Services,
  bootInfo: { fallbackReason: string | null; dbState?: string; lastError?: string | null },
): { api: Router; root: Router } {
  const auth = authMiddleware(s);
  const a = authController(s);
  const r = reportController(s);
  const v = volunteerController(s);
  const rc = rescueController(s);
  const ad = adminController(s);
  const ai = aiController(s);
  const al = alertsController(s);
  const meta = metaController(s, bootInfo);
  const sec = securityMiddleware(s);
  const h = asyncHandler;

  const root = Router();
  root.get('/healthz', h(meta.liveness));

  const api = Router();
  api.get('/security/challenge', limits.publicRead, issuePowChallengeHandler);
  api.get('/health/ping', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, ts: Date.now() });
  });
  api.get('/health', limits.publicRead, h(meta.health));
  api.get('/media/:id/thumb', limits.publicRead, h(r.media));
  api.get('/media/:id', limits.publicRead, h(r.media));
  api.get('/wards', limits.publicRead, h(r.wards));
  api.get('/wards/:wardId/overview', limits.publicRead, auth.optional, h(al.wardOverview));
  api.get('/weather', limits.publicRead, h(al.listWeather));
  api.get('/bulletins', limits.publicRead, h(al.listBulletins));
  api.get('/alerts', limits.publicRead, h(al.listAlerts));
  api.get('/alerts/route-check', limits.publicRead, h(al.routeCheck));
  api.get('/ai/daily-digest', limits.publicRead, h(al.dailyDigest));
  api.get('/geo/reverse', limits.publicRead, h(r.reverseGeocode));
  api.get('/stats', limits.publicRead, h(r.stats));
  api.get('/incidents/map', limits.publicRead, auth.optional, h(r.summary));

  // Xác thực thật & Quản lý phiên (Strict Single-Session + Re-auth + Rotation + SSE Live Kick)
  api.use('/auth', buildAuthRouter(s));
  api.get('/auth/otp/status', limits.publicRead, h(a.otpStatus));
  api.post('/auth/otp/request', limits.otp, sec.requirePow, sec.botTrapCheck, validateBody(schemas.otpRequest), h(a.otpRequest));
  api.post('/auth/otp/verify', limits.login, sec.requirePow, sec.botTrapCheck, validateBody(schemas.otpVerify), h(a.otpVerify));
  api.post('/auth/password/login', limits.login, validateBody(schemas.passwordLogin), h(a.passwordLogin));
  api.post('/auth/password/reset', limits.login, validateBody(schemas.passwordReset), h(a.passwordReset));
  api.post('/auth/staff/login', limits.login, validateBody(schemas.staffLogin), h(a.staffLogin));
  api.post('/auth/admin/login', limits.login, validateBody(schemas.staffLogin), h(a.staffLogin));
  api.post('/auth/rescue/login', limits.login, validateBody(schemas.rescueLogin), h(a.rescueLogin));
  api.post('/auth/reauth', auth.required, limits.login, validateBody(schemas.reauth), h(a.reauth));
  api.post('/auth/change-password', auth.required, limits.login, validateBody(schemas.changePassword), h(a.changePassword));
  api.post('/auth/change-email', auth.required, limits.login, validateBody(schemas.changeEmail), h(a.changeEmail));
  api.post('/auth/change-phone', auth.required, limits.login, validateBody(schemas.changePhone), h(a.changePhone));
  api.get('/auth/session-events', auth.required, h(a.sessionEvents));
  api.post('/auth/refresh', limits.login, h(a.refresh));
  api.post('/auth/logout', auth.optional, h(a.logout));
  api.post('/auth/logout-all', auth.required, h(a.logoutAll));
  api.post('/auth/volunteer/register', auth.required, validateBody(schemas.volunteerRegister), h(a.registerVolunteer));
  api.get('/me', auth.required, h(a.me));
  api.get('/me/sessions', auth.required, h(a.mySessions));
  api.patch('/me/profile', auth.required, validateBody(schemas.updateProfile), h(a.updateProfile));
  api.patch('/me/followed-wards', auth.required, validateBody(schemas.updateFollowedWards), h(al.updateFollowedWards));
  api.post('/me/notifications/read', auth.required, h(a.readNotifications));

  // Phản ánh hiện trường (Summary BBox + Cursor Pagination + OTHER category + Multipart Binary Upload)
  api.get('/reports/summary', limits.publicRead, auth.optional, h(r.summary));
  api.get('/reports', limits.publicRead, auth.optional, h(r.list));
  api.get('/reports/lookup', limits.publicRead, auth.optional, h(r.lookup));
  api.get('/reports/mine', auth.required, h(r.mine));
  api.get('/reports/:id', limits.publicRead, auth.optional, h(r.get));
  api.post('/reports', auth.required, limits.reportBurst, parseMultipartOrJson, sec.requirePow, sec.botTrapCheck, validateBody(schemas.createReport), h(r.create));
  api.post('/reports/:id/confirm', auth.required, limits.confirm, h(r.confirm));
  api.post('/reports/:id/attach-photo', auth.required, limits.reportBurst, parseMultipartOrJson, validateBody(schemas.attachPhoto), h(r.attachPhoto));
  api.post('/reports/:id/rate', auth.required, validateBody(schemas.rate), h(r.rate));
  api.post(
    '/alerts/community',
    auth.required,
    limits.confirm,
    sec.requirePow,
    sec.botTrapCheck,
    validateBody(schemas.createCommunityAlert),
    h(al.createCommunityAlert),
  );
  api.post('/alerts/:id/confirm', auth.required, limits.confirm, sec.requirePow, h(al.confirmAlert));

  // Tác vụ xác minh hiện trường (gộp về Cán bộ xử lý OFFICER & ADMIN)
  const vol = auth.requireRole('officer', 'admin');
  api.get('/volunteer/tasks', vol, h(v.tasks));
  api.post('/volunteer/tasks/:id/accept', vol, h(v.accept));
  api.post('/volunteer/tasks/:id/verify', vol, parseMultipartOrJson, validateBody(schemas.volunteerVerify), h(v.verify));
  api.post('/volunteer/proxy-report', vol, limits.reportBurst, parseMultipartOrJson, validateBody(schemas.createReport), h(v.proxyReport));
  api.get('/volunteer/leaderboard', limits.publicRead, auth.optional, h(v.leaderboard));
  api.get('/volunteer/logbook', vol, h(v.logbook));

  // Cổng Tác chiến Đội Cứu Hộ Hiện trường (RESCUE, OFFICER, ADMIN)
  const rescue = auth.requireRole('rescue', 'officer', 'admin');
  api.get('/rescue/missions', rescue, h(rc.missions));
  api.post('/rescue/missions/:id/accept', rescue, validateBody(schemas.rescueAccept), h(rc.accept));
  api.patch('/rescue/missions/:id/status', rescue, parseMultipartOrJson, validateBody(schemas.rescueStatus), h(rc.updateStatus));
  api.post('/rescue/missions/:id/status', rescue, parseMultipartOrJson, validateBody(schemas.rescueStatus), h(rc.updateStatus));
  api.post('/rescue/missions/:id/release', rescue, validateBody(schemas.rescueRelease), h(rc.release));
  api.patch('/rescue/missions/:id/location', rescue, validateBody(schemas.rescueLocation), h(rc.updateLocation));
  api.post('/rescue/missions/:id/complete', rescue, parseMultipartOrJson, validateBody(schemas.rescueComplete), h(rc.complete));

  // IOC Cán bộ xử lý & Quản trị Hệ thống (ADMIN, OFFICER)
  const staff = auth.requireRole('officer', 'admin');
  const staffOrRescue = auth.requireRole('rescue', 'officer', 'admin');
  const admins = auth.requireRole('admin');

  api.get('/admin/overview', staff, h(ad.overview));
  api.get('/admin/queue', staff, h(ad.queue));
  api.post('/admin/reports/:id/assign', staff, validateBody(schemas.assign), h(ad.assign));
  api.post('/admin/reports/:id/status', staff, validateBody(schemas.status), h(ad.status));
  api.post('/admin/reports/:id/dispatch', staff, validateBody(schemas.dispatch), h(ad.dispatch));
  api.post('/admin/reports/:id/transfer', staff, validateBody(schemas.transferWard), h(ad.transfer));
  api.post('/admin/reports/:id/restore', staff, h(ad.restore));
  api.post('/admin/reports/:id/spam', staff, validateBody(schemas.markSpam), h(ad.spam));
  api.post('/admin/reports/:id/resolve', staff, parseMultipartOrJson, validateBody(schemas.resolve), h(ad.resolve));
  api.get('/admin/audit', staff, h(ad.audit));
  api.get('/admin/audit-logs', admins, h(ad.audit));
  api.get('/admin/security-audit-logs', admins, h(ad.securityAuditLogs));
  api.get('/admin/audit/export', admins, h(ad.auditExport));
  api.get('/admin/audit/verify', admins, h(ad.auditVerify));
  api.get('/admin/moderation-queue', staff, h(ad.moderationQueue));
  api.post('/admin/moderation-queue/:id/decide', staff, validateBody(schemas.adminModerationDecision), h(ad.moderationDecide));
  api.get('/admin/staff', admins, h(ad.staff));
  api.post('/admin/staff', admins, validateBody(schemas.createStaff), h(ad.createStaff));
  api.patch('/admin/staff/:id/revoke', admins, auth.requireReauth, validateBody(schemas.revokeStaff), h(ad.revokeStaff));

  // Admin Command Center: Sessions, Trust Flagging, Violations, RBAC Users & AI Config
  api.get('/admin/sessions', admins, h(ad.listSessions));
  api.post('/admin/sessions/:sessionId/revoke', admins, h(ad.revokeSession));
  api.post('/admin/sessions/force-logout-all', admins, auth.requireReauth, h(ad.forceLogoutAll));
  api.post('/admin/users/:id/force-logout', admins, h(ad.forceLogoutUser));
  api.get('/admin/users/:id/violations', admins, h(ad.userViolations));
  api.patch('/admin/users/:id/trust-flag', admins, validateBody(schemas.adminTrustFlag), h(ad.flagUserTrust));
  api.get('/admin/users', admins, h(ad.listUsers));
  api.post('/admin/users', admins, validateBody(schemas.adminCreateUser), h(ad.createUser));
  api.patch('/admin/users/:id', admins, auth.requireReauth, validateBody(schemas.adminUpdateUser), h(ad.updateUser));
  api.post('/admin/users/:id/reset-password', admins, auth.requireReauth, validateBody(schemas.adminResetPassword), h(ad.resetUserPassword));
  api.delete('/admin/users/:id', admins, auth.requireReauth, h(ad.deleteUser));
  api.get('/admin/ai-config', admins, h(ad.getAiConfig));
  api.patch('/admin/ai-config', admins, auth.requireReauth, validateBody(schemas.adminUpdateAiConfig), h(ad.updateAiConfig));
  api.post('/admin/purge-demo', admins, auth.requireReauth, h(ad.purgeDemo));
  api.post('/admin/maintenance/purge-seed', admins, auth.requireReauth, h(ad.purgeDemo));
  api.use('/admin/api-keys', buildApiKeysRouter(s));
  api.get('/admin/export', staff, h(ad.export));
  api.post('/admin/alerts', staffOrRescue, validateBody(schemas.createAlert), h(al.adminCreateAlert));
  api.patch('/admin/alerts/:id', staffOrRescue, validateBody(schemas.updateAlert), h(al.adminUpdateAlert));
  api.delete('/admin/alerts/:id', admins, auth.requireReauth, h(al.adminDeleteAlert));
  api.post('/admin/aggregator/sync', admins, h(al.adminTriggerSync));
  api.post('/internal/aggregator/sync', h(al.internalTriggerSync));

  // SmartCitizen AI Brain & Computer Vision (3-Stage Cascade + Multipart Binary WebP)
  api.post('/ai/analyze-image', limits.vision, parseMultipartOrJson, validateBody(schemas.analyzeImage), h(ai.analyzeImage));
  api.post('/ai/verify-resolution', staffOrRescue, parseMultipartOrJson, validateBody(schemas.verifyResolution), h(ai.verifyResolution));
  api.post('/ai/tactical-briefing', staffOrRescue, validateBody(schemas.tacticalBriefing), h(ai.tacticalBriefing));
  api.post('/ai/chat', auth.optional, limits.chat, validateBody(schemas.chat), h(ai.chat));

  return { api, root };
}
