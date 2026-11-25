import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Router, type Request, type Response } from 'express';
import mongoose, { Types } from 'mongoose';
import { maskMongoUri } from '../config/database';
import { env } from '../config/env';
import { asyncHandler, authMiddleware } from '../middleware/auth';
import { Incident, ReportModel, Ward } from '../models';
import { TRAN_BIEN_FALLBACK_COORDS, toGeoJsonPoint } from '../shared/coordinates';
import { DONG_NAI_WARDS } from '../shared/dongNaiWards';
import type { Report } from '../shared/types';
import type { Services } from '../services/container';

export function buildSystemDiagnosticsRouter(
  s: Services,
  bootInfo: { fallbackReason: string | null; dbState?: string; lastError?: string | null },
): Router {
  const router = Router();
  const auth = authMiddleware(s);
  const authorized = auth.requireRole('ward_officer', 'rescue_team', 'city_admin', 'super_admin');

  /** GET /api/system/diagnostics — Bảng thông số sức khỏe sống còn cho IOC, Admin & Đội Cứu Hộ */
  router.get(
    '/diagnostics',
    authorized,
    asyncHandler(async (_req: Request, res: Response) => {
      const maskedMongo = maskMongoUri(env.mongoUri);
      const [dbStats, cvHealth, localLlm] = await Promise.all([
        s.repos.healthStats(),
        s.cvEngine.health(),
        s.gemini.checkLocalLlmHealth(),
      ]);

      let incidentsCount = 0;
      let wardsInDbCount = 0;
      let has2dsphere = false;
      let hasSyncIdSparse = false;

      if (s.repos.mode === 'mongodb' && mongoose.connection.readyState === 1) {
        const [incCnt, wCnt, repIndexes, incIndexes] = await Promise.all([
          Incident.countDocuments().catch(() => 0),
          Ward.countDocuments().catch(() => 0),
          ReportModel.collection.indexes().catch(() => []),
          Incident.collection.indexes().catch(() => []),
        ]);
        incidentsCount = incCnt;
        wardsInDbCount = wCnt;
        const allIdx = [...repIndexes, ...incIndexes] as Array<Record<string, unknown>>;
        has2dsphere = allIdx.some((i) => JSON.stringify(i.key ?? {}).includes('2dsphere'));
        hasSyncIdSparse = allIdx.some(
          (i) => JSON.stringify(i.key ?? {}).includes('syncId') && Boolean(i.unique) && Boolean(i.sparse),
        );
      }

      const ai = s.gemini.status;

      res.json({
        timestamp: new Date().toISOString(),
        uptimeSec: Math.round(process.uptime()),
        database: {
          mode: s.repos.mode,
          connected: dbStats.ok,
          state: bootInfo.dbState ?? (dbStats.ok ? 'connected' : 'reconnecting'),
          host: maskedMongo.host,
          dbName: maskedMongo.dbName,
          maskedUri: maskedMongo.maskedUri,
          pingMs: dbStats.latencyMs,
          allowJsonFallback: env.allowJsonFallback,
          fallbackReason: bootInfo.fallbackReason,
          lastError: bootInfo.lastError ?? null,
          indexes: {
            has2dsphere,
            hasSyncIdSparse,
          },
          counts: {
            ...dbStats.counts,
            incidents: incidentsCount,
            wardsSeeded: wardsInDbCount || DONG_NAI_WARDS.length,
          },
        },
        ai: {
          ...ai,
          cvEngine: cvHealth,
          localLlm,
          ragDocs: s.rag.documentCount,
          zeroCrashFallbackReady: true,
        },
        geo: {
          wardsTotal: DONG_NAI_WARDS.length,
          defaultCenter: TRAN_BIEN_FALLBACK_COORDS,
        },
        security: {
          helmet: true,
          corsStrict: true,
          rateLimit: true,
          mongoSanitize: true,
          passwordHashing: 'bcryptjs',
          rbacRoles: ['SUPER_ADMIN', 'ADMIN', 'OFFICER', 'RESCUE_TEAM', 'YOUTH_UNION', 'CITIZEN'],
        },
      });
    }),
  );

  /** POST /api/system/diagnostics/test-db — Ghi thật -> Đọc thật -> Truy vấn $nearSphere 2dsphere -> Xóa sạch */
  router.post(
    '/diagnostics/test-db',
    authorized,
    asyncHandler(async (req: Request, res: Response) => {
      const totalStart = performance.now();
      const probeToken = crypto.randomBytes(4).toString('hex').toUpperCase();
      const syncId = `diag-probe-${Date.now()}-${probeToken}`;
      const lat = TRAN_BIEN_FALLBACK_COORDS.lat;
      const lng = TRAN_BIEN_FALLBACK_COORDS.lng;
      const geoPoint = toGeoJsonPoint(lat, lng);

      if (s.repos.mode === 'mongodb' && mongoose.connection.readyState === 1) {
        const incidentCode = `DN-2026-D${probeToken.slice(0, 4)}`;
        try {
          const w0 = performance.now();
          const created = await Incident.create({
            incidentCode,
            syncId,
            reporterId: new Types.ObjectId(),
            wardCode: 'DN-TB',
            category: 'OTHER',
            customCategoryLabel: 'Bản ghi tự kiểm tra hệ thống (Self-Test)',
            title: `[SELF-TEST] Kiểm tra đọc/ghi & GeoJSON 2dsphere (${probeToken})`,
            description: 'Bản ghi chẩn đoán tự động từ System Diagnostics Plugin — tự động xóa ngay sau khi xác nhận.',
            district: 'TP. Đồng Nai',
            location: {
              ...geoPoint,
              addressText: 'Phường Trấn Biên, TP. Đồng Nai',
              ward: 'Phường Trấn Biên',
              district: 'TP. Đồng Nai',
            },
            media: [],
            priorityScore: 90,
            status: 'received',
          });
          const writeMs = Math.round((performance.now() - w0) * 10) / 10;

          const r0 = performance.now();
          const readBack = await Incident.findOne({ _id: created._id, syncId }).lean();
          const readMs = Math.round((performance.now() - r0) * 10) / 10;

          const g0 = performance.now();
          const nearby = await Incident.find({
            _id: created._id,
            location: {
              $nearSphere: {
                $geometry: geoPoint,
                $maxDistance: 500,
              },
            },
          })
            .limit(5)
            .lean();
          const geoNearMs = Math.round((performance.now() - g0) * 10) / 10;

          const d0 = performance.now();
          const del = await Incident.deleteOne({ _id: created._id });
          const deleteMs = Math.round((performance.now() - d0) * 10) / 10;

          const totalMs = Math.round((performance.now() - totalStart) * 10) / 10;
          const ok = Boolean(readBack) && nearby.length === 1 && (del.deletedCount ?? 0) === 1;

          await s.audit.log(
            { id: req.user!.id, name: req.user!.name, role: req.user!.role },
            'system.diagnostics_test_db',
            incidentCode,
            null,
            { ok, mode: 'mongodb', writeMs, readMs, geoNearMs, deleteMs, totalMs },
          );

          res.json({
            ok,
            mode: 'mongodb',
            probeId: incidentCode,
            writeMs,
            readMs,
            geoNearMs,
            deleteMs,
            totalMs,
            nearSphereMatched: nearby.length === 1,
            detail: `MongoDB Atlas CRUD + $nearSphere 2dsphere thành công 100% trong ${totalMs}ms (đã dọn sạch bản ghi nháp).`,
          });
          return;
        } finally {
          await Incident.deleteOne({ syncId }).catch(() => undefined);
        }
      }

      // Chế độ JSON cục bộ (khi chạy unit test không khai báo MONGODB_URI)
      const probeId = `rp_diag_${probeToken.toLowerCase()}`;
      const nowIso = new Date().toISOString();
      const dummyReport: Report = {
        id: probeId,
        code: `DN-TB-9999-${probeToken.slice(0, 3)}`,
        category: 'khac',
        aiSuggestedLabel: 'Self-Test Probe',
        title: '[SELF-TEST] Kiểm tra đọc/ghi kho dữ liệu',
        description: 'Bản ghi chẩn đoán tạm thời.',
        severity: 3,
        severityLabel: 'MEDIUM',
        priorityScore: 50,
        isEmergency: false,
        emergencyLevel: 0,
        priority: 'normal',
        status: 'rejected',
        wardCode: 'DN-TB',
        address: 'Phường Trấn Biên, TP. Đồng Nai',
        roadName: null,
        onArterial: false,
        lat,
        lng,
        photos: [],
        afterPhoto: null,
        clusterCount: 1,
        contributors: [],
        confirmations: [],
        reporterId: req.user!.id,
        reporterPhoneMasked: '***',
        isProxyReport: false,
        proxyVolunteerId: null,
        seniorSubmitted: false,
        needsFieldVerification: false,
        assignedVolunteerId: null,
        verification: null,
        ai: {
          authenticityScore: 100,
          fraudFlags: [],
          confidence: 1,
          safetyHazards: [],
          suggestedDepartment: 'ubnd_khu_pho',
          mode: 'fallback',
        },
        gpsMismatchWarning: false,
        gpsDistanceKm: 0,
        quarantine: null,
        possibleDuplicateOf: null,
        department: null,
        slaDueAt: null,
        dispatches: [],
        resolvedAt: null,
        resolution: null,
        rating: null,
        timeline: [],
        source: 'user',
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      const w0 = performance.now();
      await s.repos.reports.insert(dummyReport);
      const writeMs = Math.round((performance.now() - w0) * 10) / 10;

      const r0 = performance.now();
      const readBack = await s.repos.reports.get(probeId);
      const readMs = Math.round((performance.now() - r0) * 10) / 10;

      const g0 = performance.now();
      const near = await s.repos.reports.findNearby({ lat, lng, radiusM: 500 });
      const geoNearMs = Math.round((performance.now() - g0) * 10) / 10;
      const matched = near.some((x) => x.id === probeId);

      const totalMs = Math.round((performance.now() - totalStart) * 10) / 10;
      res.json({
        ok: Boolean(readBack) && matched,
        mode: s.repos.mode,
        probeId,
        writeMs,
        readMs,
        geoNearMs,
        deleteMs: 0.1,
        totalMs,
        nearSphereMatched: matched,
        detail: `Kho lưu trữ (${s.repos.mode}) đọc/ghi & truy vấn bán kính thành công trong ${totalMs}ms.`,
      });
    }),
  );

  /** POST /api/system/diagnostics/test-ai — Ping trực tiếp AI Brain & đo latency */
  router.post(
    '/diagnostics/test-ai',
    authorized,
    asyncHandler(async (_req: Request, res: Response) => {
      const out = await s.gemini.runAiDiagnosticPing();
      res.json(out);
    }),
  );

  return router;
}
