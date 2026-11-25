import { Router } from 'express';
import { authMiddleware, asyncHandler } from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
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
  const meta = metaController(s, bootInfo);
  const h = asyncHandler;

  const root = Router();
  root.get('/healthz', h(meta.liveness));

  const api = Router();
  api.get('/health', h(meta.health));
  api.get('/wards', h(r.wards));
  api.get('/geo/reverse', h(r.reverseGeocode));
  api.get('/stats', h(r.stats));

  // Xác thực thật & Quản lý phiên (Citizen Email + Phone SMS +84 OTP + Firebase + Password + Staff + Rescue Team JWT)
  api.use('/auth', buildAuthRouter(s));
  api.get('/auth/otp/status', h(a.otpStatus));
  api.post('/auth/otp/request', limits.otp, validateBody(schemas.otpRequest), h(a.otpRequest));
  api.post('/auth/otp/verify', limits.login, validateBody(schemas.otpVerify), h(a.otpVerify));
  api.post('/auth/password/login', limits.login, validateBody(schemas.passwordLogin), h(a.passwordLogin));
  api.post('/auth/password/reset', limits.login, validateBody(schemas.passwordReset), h(a.passwordReset));
  api.post('/auth/staff/login', limits.login, validateBody(schemas.staffLogin), h(a.staffLogin));
  api.post('/auth/admin/login', limits.login, validateBody(schemas.staffLogin), h(a.staffLogin));
  api.post('/auth/rescue/login', limits.login, validateBody(schemas.rescueLogin), h(a.rescueLogin));
  api.post('/auth/refresh', limits.login, h(a.refresh));
  api.post('/auth/logout', h(a.logout));
  api.post('/auth/logout-all', auth.required, h(a.logoutAll));
  api.post('/auth/volunteer/register', auth.required, validateBody(schemas.volunteerRegister), h(a.registerVolunteer));
  api.get('/me', auth.required, h(a.me));
  api.patch('/me/profile', auth.required, validateBody(schemas.updateProfile), h(a.updateProfile));
  api.post('/me/notifications/read', auth.required, h(a.readNotifications));

  // Phản ánh hiện trường (Summary BBox + Cursor Pagination + OTHER category)
  api.get('/reports/summary', auth.optional, h(r.summary));
  api.get('/reports', auth.optional, h(r.list));
  api.get('/reports/lookup', auth.optional, h(r.lookup));
  api.get('/reports/mine', auth.required, h(r.mine));
  api.get('/reports/:id', auth.optional, h(r.get));
  api.post('/reports', auth.required, limits.reportBurst, validateBody(schemas.createReport), h(r.create));
  api.post('/reports/:id/confirm', auth.required, limits.confirm, h(r.confirm));
  api.post('/reports/:id/attach-photo', auth.required, limits.reportBurst, validateBody(schemas.attachPhoto), h(r.attachPhoto));
  api.post('/reports/:id/rate', auth.required, validateBody(schemas.rate), h(r.rate));

  // Tác vụ xác minh hiện trường (gộp về Cán bộ xử lý OFFICER & ADMIN)
  const vol = auth.requireRole('officer', 'admin');
  api.get('/volunteer/tasks', vol, h(v.tasks));
  api.post('/volunteer/tasks/:id/accept', vol, h(v.accept));
  api.post('/volunteer/tasks/:id/verify', vol, validateBody(schemas.volunteerVerify), h(v.verify));
  api.post('/volunteer/proxy-report', vol, limits.reportBurst, validateBody(schemas.createReport), h(v.proxyReport));
  api.get('/volunteer/leaderboard', auth.optional, h(v.leaderboard));
  api.get('/volunteer/logbook', vol, h(v.logbook));

  // Cổng Tác chiến Đội Cứu Hộ Hiện trường (RESCUE, OFFICER, ADMIN)
  const rescue = auth.requireRole('rescue', 'officer', 'admin');
  api.get('/rescue/missions', rescue, h(rc.missions));
  api.post('/rescue/missions/:id/accept', rescue, validateBody(schemas.rescueAccept), h(rc.accept));
  api.patch('/rescue/missions/:id/status', rescue, validateBody(schemas.rescueStatus), h(rc.updateStatus));
  api.post('/rescue/missions/:id/status', rescue, validateBody(schemas.rescueStatus), h(rc.updateStatus));
  api.post('/rescue/missions/:id/release', rescue, validateBody(schemas.rescueRelease), h(rc.release));
  api.patch('/rescue/missions/:id/location', rescue, validateBody(schemas.rescueLocation), h(rc.updateLocation));
  api.post('/rescue/missions/:id/complete', rescue, validateBody(schemas.rescueComplete), h(rc.complete));

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
  api.post('/admin/reports/:id/resolve', staff, validateBody(schemas.resolve), h(ad.resolve));
  api.get('/admin/audit', staff, h(ad.audit));
  api.get('/admin/audit-logs', admins, h(ad.audit));
  api.get('/admin/audit/verify', admins, h(ad.auditVerify));
  api.get('/admin/staff', admins, h(ad.staff));
  api.post('/admin/staff', admins, validateBody(schemas.createStaff), h(ad.createStaff));
  api.patch('/admin/staff/:id/revoke', admins, validateBody(schemas.revokeStaff), h(ad.revokeStaff));

  // Full RBAC User Management (4 Roles) & Dynamic Local AI Config
  api.get('/admin/users', admins, h(ad.listUsers));
  api.post('/admin/users', admins, validateBody(schemas.adminCreateUser), h(ad.createUser));
  api.patch('/admin/users/:id', admins, validateBody(schemas.adminUpdateUser), h(ad.updateUser));
  api.post('/admin/users/:id/reset-password', admins, validateBody(schemas.adminResetPassword), h(ad.resetUserPassword));
  api.delete('/admin/users/:id', admins, h(ad.deleteUser));
  api.get('/admin/ai-config', admins, h(ad.getAiConfig));
  api.patch('/admin/ai-config', admins, validateBody(schemas.adminUpdateAiConfig), h(ad.updateAiConfig));
  api.post('/admin/purge-demo', admins, h(ad.purgeDemo));
  api.post('/admin/maintenance/purge-seed', admins, h(ad.purgeDemo));
  api.use('/admin/api-keys', buildApiKeysRouter(s));
  api.get('/admin/export', staff, h(ad.export));

  // SmartCitizen AI Brain & Computer Vision
  api.post('/ai/analyze-image', limits.vision, validateBody(schemas.analyzeImage), h(ai.analyzeImage));
  api.post('/ai/verify-resolution', staffOrRescue, validateBody(schemas.verifyResolution), h(ai.verifyResolution));
  api.post('/ai/tactical-briefing', staffOrRescue, validateBody(schemas.tacticalBriefing), h(ai.tacticalBriefing));
  api.post('/ai/chat', auth.optional, limits.chat, validateBody(schemas.chat), h(ai.chat));

  return { api, root };
}
