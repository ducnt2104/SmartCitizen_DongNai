import type { Request, Response } from 'express';
import type { z } from 'zod';
import { env } from '../config/env';
import { extractClientMeta } from '../middleware/auth';
import type { Services } from '../services/container';
import type { AlertCategory, AlertSeverity } from '../shared/types';
import { safeFetchOfficial } from '../services/ssrfGuard';
import { safeEqualHex, sha256 } from '../utils/crypto';
import { badRequest, unauthorized } from '../utils/errors';
import type { schemas } from '../validation/schemas';

const VALID_ALERT_CATS = new Set<AlertCategory>(['disaster', 'traffic', 'utility', 'official_notice']);

export function alertsController(s: Services) {
  const secAudit = (
    req: Request,
    action: string,
    targetType: string,
    targetId: string,
    beforeState: unknown,
    afterState: unknown,
  ) => {
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
      })
      .catch(() => undefined);
  };

  const sendAlertCached = async (
    req: Request,
    res: Response,
    cacheKey: string,
    ttlMs: number,
    cacheControl: string,
    loader: () => Promise<unknown>,
  ) => {
    let entry = s.cache.getAlertCached(cacheKey);
    if (!entry) {
      entry = s.cache.setAlertCached(cacheKey, await loader(), ttlMs);
    }
    res.set('ETag', entry.etag);
    res.set('Cache-Control', cacheControl);
    if (req.headers['if-none-match'] === entry.etag) {
      res.status(304).end();
      return;
    }
    res.json(entry.body);
  };

  return {
    wardOverview: async (req: Request, res: Response) => {
      const wardId = String(req.params.wardId || '').trim();
      const rawFilter = typeof req.query.status === 'string' ? req.query.status : 'all';
      const statusFilter = rawFilter === 'open' || rawFilter === 'resolved' ? rawFilter : 'all';
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(Math.max(1, Number(req.query.pageSize) || 20), 60);
      await sendAlertCached(
        req,
        res,
        `ward_overview:${wardId.toUpperCase()}:${statusFilter}:${page}:${pageSize}`,
        30_000,
        'public, max-age=15, stale-while-revalidate=30',
        () => s.alerts.getWardOverview(wardId, { statusFilter, page, pageSize }),
      );
    },

    listWeather: async (req: Request, res: Response) => {
      res.set('Cache-Control', 'no-store');
      await sendAlertCached(
        req,
        res,
        'weather:latest',
        0,
        'no-store',
        async () => {
          let items = await s.alerts.getLatestWeatherSnapshots();
          const newestMs = items[0]?.fetchedAt ? new Date(items[0].fetchedAt).getTime() : 0;
          if (items.length === 0 || !Number.isFinite(newestMs) || Date.now() - newestMs > 20 * 60_000) {
            try {
              const synced = await s.aggregator.syncWeatherSnapshots();
              if (synced.snapshots.length > 0) {
                items = synced.snapshots;
              }
            } catch {
              // Giữ snapshot gần nhất nếu mạng ngoài tạm gián đoạn
            }
          }
          return {
            items,
            lastSyncAt: items[0]?.fetchedAt ?? s.aggregator.status.lastSyncSummary?.finishedAt ?? null,
            source: 'Open-Meteo API',
          };
        },
      );
    },

    forecastByCoords: async (req: Request, res: Response) => {
      const lat = Number(req.query.lat);
      const lng = Number(req.query.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        throw badRequest('Tọa độ lat/lng không hợp lệ.');
      }
      const headerWeatherKey =
        typeof req.headers['x-weather-api-key'] === 'string' ? req.headers['x-weather-api-key'].trim() : '';
      const weatherApiKey = (process.env.WEATHERAPI_KEY?.trim() || headerWeatherKey).trim();
      const lang = req.query.lang === 'en' ? 'en' : 'vi';

      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.set('Pragma', 'no-cache');

      const omParams =
        `latitude=${lat.toFixed(5)}&longitude=${lng.toFixed(5)}` +
        '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,weather_code,cloud_cover,surface_pressure,wind_speed_10m,wind_gusts_10m' +
        '&hourly=temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,rain,uv_index,weather_code,is_day' +
        '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_sum,precipitation_probability_max' +
        '&timezone=Asia%2FHo_Chi_Minh&forecast_days=7';
      const ecmwfUrl = `https://api.open-meteo.com/v1/forecast?${omParams}&models=ecmwf_ifs025`;
      const fallbackOmUrl = `https://api.open-meteo.com/v1/forecast?${omParams}`;

      const fetchOpenMeteoBest = async () => {
        const resEcmwf = await safeFetchOfficial(ecmwfUrl, { timeoutMs: 8000 });
        if (resEcmwf.ok) return resEcmwf.json();
        const resFallback = await safeFetchOfficial(fallbackOmUrl, { timeoutMs: 8000 });
        if (!resFallback.ok) throw badRequest(`Open-Meteo trả về HTTP ${resFallback.status}`);
        return resFallback.json();
      };

      if (weatherApiKey) {
        const wapiUrl =
          `https://api.weatherapi.com/v1/forecast.json?key=${encodeURIComponent(weatherApiKey)}` +
          `&q=${lat.toFixed(5)},${lng.toFixed(5)}&days=7&aqi=yes&alerts=yes&lang=${lang}`;
        const [wapiRes, omRes] = await Promise.allSettled([
          safeFetchOfficial(wapiUrl, { timeoutMs: 8000 }),
          fetchOpenMeteoBest(),
        ]);
        if (wapiRes.status === 'fulfilled' && wapiRes.value.ok) {
          const weatherApi = await wapiRes.value.json();
          const openMeteo = omRes.status === 'fulfilled' ? omRes.value : null;
          res.json({ provider: 'weatherapi', weatherApi, openMeteo });
          return;
        }
      }

      const omPayload = await fetchOpenMeteoBest();
      res.json(omPayload);
    },

    listBulletins: async (req: Request, res: Response) => {
      const wardId = typeof req.query.wardId === 'string' && req.query.wardId ? req.query.wardId : undefined;
      const rawCat = typeof req.query.category === 'string' ? (req.query.category as AlertCategory) : undefined;
      const category = rawCat && VALID_ALERT_CATS.has(rawCat) ? rawCat : undefined;
      const limit = Math.min(Math.max(1, Number(req.query.limit) || 30), 100);
      await s.aggregator.ensureFreshBulletins();
      await sendAlertCached(
        req,
        res,
        `bulletins:${wardId ?? ''}:${category ?? ''}:${limit}`,
        120_000,
        'public, max-age=60, stale-while-revalidate=120',
        async () => ({ items: await s.alerts.listBulletins({ wardId, category, limit }) }),
      );
    },

    listAlerts: async (req: Request, res: Response) => {
      const wardId = typeof req.query.wardId === 'string' && req.query.wardId ? req.query.wardId : undefined;
      const rawCat = typeof req.query.category === 'string' ? (req.query.category as AlertCategory) : undefined;
      const category = rawCat && VALID_ALERT_CATS.has(rawCat) ? rawCat : undefined;
      const rawSev = Number(req.query.severity);
      const severity = [1, 2, 3].includes(rawSev) ? (rawSev as AlertSeverity) : undefined;
      const rawStatus = typeof req.query.status === 'string' ? req.query.status : 'active';
      const status = rawStatus === 'resolved' || rawStatus === 'all' ? rawStatus : 'active';
      const limit = Math.min(Math.max(1, Number(req.query.limit) || 80), 200);
      await sendAlertCached(
        req,
        res,
        `alerts:${wardId ?? ''}:${category ?? ''}:${severity ?? ''}:${status}:${limit}`,
        30_000,
        'public, max-age=15, stale-while-revalidate=30',
        async () => ({ items: await s.alerts.listAlerts({ wardId, category, severity, status, limit }) }),
      );
    },

    routeCheck: async (req: Request, res: Response) => {
      const road = typeof req.query.road === 'string' ? req.query.road : '';
      if (!road.trim()) {
        throw badRequest('Thiếu tham số tên tuyến đường (?road=...).');
      }
      await sendAlertCached(
        req,
        res,
        `route_check:${road.trim().toLowerCase()}`,
        30_000,
        'public, max-age=15, stale-while-revalidate=30',
        () => s.alerts.checkRouteSafety(road),
      );
    },

    dailyDigest: async (req: Request, res: Response) => {
      const cacheKey = 'ai:daily_digest';
      let entry = s.cache.getAlertCached(cacheKey);
      if (!entry) {
        const digest = await s.aggregator.getDailyDigest();
        const stored = s.cache.setAlertCached(cacheKey, { ...digest, cached: true }, 300_000);
        res.set('ETag', stored.etag);
        res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=300');
        res.json(digest);
        return;
      }
      res.set('ETag', entry.etag);
      res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=300');
      if (req.headers['if-none-match'] === entry.etag) {
        res.status(304).end();
        return;
      }
      res.json(entry.body);
    },

    createCommunityAlert: async (req: Request, res: Response) => {
      const b = req.body as z.infer<typeof schemas.createCommunityAlert>;
      const created = await s.alerts.createCommunityAlert(req.user!, b);
      s.cache.invalidateAlerts();
      res.status(201).json(created);
    },

    confirmAlert: async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const updated = await s.alerts.confirmAlert(req.user!.id, id);
      s.cache.invalidateAlerts();
      res.json(updated);
    },

    adminCreateAlert: async (req: Request, res: Response) => {
      const b = req.body as z.infer<typeof schemas.createAlert>;
      const created = await s.alerts.createAdminOrRescueAlert(req.user!, b);
      s.cache.invalidateAlerts();
      secAudit(req, 'admin.alert_create', 'alert', created.id, null, {
        title: created.title,
        category: created.category,
        severity: created.severity,
        wardIds: created.wardIds,
        geometryType: created.geometryType,
      });
      res.status(201).json(created);
    },

    adminUpdateAlert: async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const b = req.body as z.infer<typeof schemas.updateAlert>;
      const { before, after } = await s.alerts.updateAlert(id, b);
      s.cache.invalidateAlerts();
      secAudit(
        req,
        'admin.alert_update',
        'alert',
        id,
        { status: before.status, severity: before.severity, title: before.title },
        { status: after.status, severity: after.severity, title: after.title },
      );
      res.json(after);
    },

    adminDeleteAlert: async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const before = await s.alerts.deleteAlert(id);
      s.cache.invalidateAlerts();
      secAudit(req, 'admin.alert_delete', 'alert', id, { title: before.title, status: before.status }, { deleted: true });
      res.json({ ok: true, id });
    },

    adminTriggerSync: async (req: Request, res: Response) => {
      const out = await s.aggregator.syncAll();
      s.cache.invalidateAlerts();
      secAudit(req, 'admin.aggregator_sync', 'aggregator', 'manual', null, out);
      res.json(out);
    },

    internalTriggerSync: async (req: Request, res: Response) => {
      const rawSecret = typeof req.headers['x-cron-secret'] === 'string' ? req.headers['x-cron-secret'].trim() : '';
      if (!rawSecret || !safeEqualHex(sha256(rawSecret), sha256(env.cronSecret))) {
        throw unauthorized('Thiếu hoặc sai X-Cron-Secret cho tác vụ nội bộ.', 'invalid_cron_secret');
      }
      const out = await s.aggregator.syncAll();
      s.cache.invalidateAlerts();
      res.json(out);
    },

    updateFollowedWards: async (req: Request, res: Response) => {
      const b = req.body as z.infer<typeof schemas.updateFollowedWards>;
      const { user } = await s.auth.updateProfile(req.user!.id, { followedWardCodes: b.wardCodes }, req.sessionId);
      res.json({ followedWardCodes: user.followedWardCodes ?? [] });
    },
  };
}
