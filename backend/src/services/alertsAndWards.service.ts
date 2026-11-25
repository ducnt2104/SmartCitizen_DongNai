import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import {
  DONG_NAI_WARDS,
  WARD_BY_CODE,
} from '../shared/dongNaiWards';
import { haversineMeters, nearestWard } from '../shared/geo';
import type {
  AlertCategory,
  AlertGeometryType,
  AlertSeverity,
  AlertSourceType,
  CivicAlertItem,
  OfficialBulletinItem,
  Report,
  RouteCheckResponse,
  WardOverviewResponse,
  WardOverviewStatus,
  WeatherSnapshotItem,
} from '../shared/types';
import { env } from '../config/env';
import { Alert, Bulletin, ReportModel, WeatherSnapshot } from '../models';
import { reportFromDoc } from '../repositories/mongoRepositories';
import type { Repositories, UserRecord } from '../repositories/types';
import { newId, sha256 } from '../utils/crypto';
import { badRequest, notFound } from '../utils/errors';

const DAY_MS = 24 * 3600 * 1000;
const CLUSTER_RADIUS_M = 500;
const CLUSTER_WINDOW_MS = 30 * 60 * 1000;
const CLUSTER_MIN_DISTINCT_USERS = 3;

export function stripVnDiacritics(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function normalizeRoadAliases(query: string): string[] {
  const norm = stripVnDiacritics(query).replace(/\s+/g, ' ').trim();
  if (!norm) return [];
  const aliases = new Set<string>([norm]);
  if (/\b(ql1a|ql\s*1a|quoc lo 1a|quoc lo 1)\b/.test(norm)) {
    aliases.add('quoc lo 1a');
    aliases.add('ql1a');
    aliases.add('ql 1a');
  }
  if (/\b(ql51|ql\s*51|quoc lo 51)\b/.test(norm)) {
    aliases.add('quoc lo 51');
    aliases.add('ql51');
  }
  if (/\b(ql20|ql\s*20|quoc lo 20)\b/.test(norm)) {
    aliases.add('quoc lo 20');
    aliases.add('ql20');
  }
  if (/\b(ql56|ql\s*56|quoc lo 56)\b/.test(norm)) {
    aliases.add('quoc lo 56');
    aliases.add('ql56');
  }
  if (/\b(dt768|dt\s*768|tinh lo 768)\b/.test(norm)) {
    aliases.add('dt 768');
    aliases.add('dt768');
    aliases.add('tinh lo 768');
  }
  if (/\b(dt769|dt\s*769|tinh lo 769)\b/.test(norm)) {
    aliases.add('dt 769');
    aliases.add('dt769');
    aliases.add('tinh lo 769');
  }
  return Array.from(aliases);
}

function mapAlertDoc(doc: Record<string, unknown>): CivicAlertItem {
  const rawPoly = Array.isArray(doc.polyline) ? doc.polyline : undefined;
  const polyline = rawPoly
    ?.map((pt) => (Array.isArray(pt) && pt.length >= 2 ? [Number(pt[0]), Number(pt[1])] as [number, number] : null))
    .filter((pt): pt is [number, number] => pt !== null && Number.isFinite(pt[0]) && Number.isFinite(pt[1]));
  const createdAtVal = doc.createdAt instanceof Date ? doc.createdAt.toISOString() : String(doc.createdAt ?? new Date().toISOString());
  const updatedAtVal = doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : String(doc.updatedAt ?? createdAtVal);

  return {
    id: String(doc.id),
    title: String(doc.title ?? ''),
    description: String(doc.description ?? ''),
    category: (doc.category as AlertCategory) ?? 'official_notice',
    severity: ([1, 2, 3].includes(Number(doc.severity)) ? Number(doc.severity) : 1) as AlertSeverity,
    sourceType: (doc.sourceType as AlertSourceType) ?? 'official_rss',
    sourceLabel: String(doc.sourceLabel ?? 'Nguồn chính thống'),
    sourceUrl: typeof doc.sourceUrl === 'string' ? doc.sourceUrl : null,
    sourceUrlHash: typeof doc.sourceUrlHash === 'string' ? doc.sourceUrlHash : null,
    wardIds: Array.isArray(doc.wardIds) ? doc.wardIds.map(String) : ['ALL_DONG_NAI'],
    affectedRoads: Array.isArray(doc.affectedRoads) ? doc.affectedRoads.map(String) : [],
    detourNote: typeof doc.detourNote === 'string' ? doc.detourNote : null,
    geometryType: (doc.geometryType as AlertGeometryType) ?? 'point',
    lat: Number(doc.lat ?? 10.9465),
    lng: Number(doc.lng ?? 106.8243),
    radiusM: doc.radiusM !== null && doc.radiusM !== undefined ? Number(doc.radiusM) : null,
    polyline: polyline && polyline.length >= 2 ? polyline : undefined,
    status: doc.status === 'resolved' ? 'resolved' : 'active',
    isVerifiedOfficial: Boolean(doc.isVerifiedOfficial),
    confirmCount: Number(doc.confirmCount ?? 0),
    confirmedByUserIds: Array.isArray(doc.confirmedByUserIds) ? doc.confirmedByUserIds.map(String) : [],
    clusterReportCount: doc.clusterReportCount !== null && doc.clusterReportCount !== undefined ? Number(doc.clusterReportCount) : null,
    clusterDistinctUsers: doc.clusterDistinctUsers !== null && doc.clusterDistinctUsers !== undefined ? Number(doc.clusterDistinctUsers) : null,
    createdById: typeof doc.createdById === 'string' ? doc.createdById : null,
    createdByName: typeof doc.createdByName === 'string' ? doc.createdByName : null,
    startsAt: typeof doc.startsAt === 'string' ? doc.startsAt : null,
    expiresAt: typeof doc.expiresAt === 'string' ? doc.expiresAt : null,
    createdAt: createdAtVal,
    updatedAt: updatedAtVal,
  };
}

function mapBulletinDoc(doc: Record<string, unknown>): OfficialBulletinItem {
  const pubVal = doc.publishedAt instanceof Date ? doc.publishedAt.toISOString() : String(doc.publishedAt ?? new Date().toISOString());
  const fetchVal = doc.fetchedAt instanceof Date ? doc.fetchedAt.toISOString() : String(doc.fetchedAt ?? pubVal);
  return {
    id: String(doc.id),
    title: String(doc.title ?? ''),
    cleanSummary: String(doc.cleanSummary ?? ''),
    category: (doc.category as AlertCategory) ?? 'official_notice',
    severity: ([1, 2, 3].includes(Number(doc.severity)) ? Number(doc.severity) : 1) as AlertSeverity,
    wardIds: Array.isArray(doc.wardIds) ? doc.wardIds.map(String) : ['ALL_DONG_NAI'],
    affectedRoads: Array.isArray(doc.affectedRoads) ? doc.affectedRoads.map(String) : [],
    sourceName: String(doc.sourceName ?? 'Nguồn chính thống'),
    sourceUrl: String(doc.sourceUrl ?? ''),
    sourceUrlHash: String(doc.sourceUrlHash ?? ''),
    publishedAt: pubVal,
    fetchedAt: fetchVal,
  };
}

function mapWeatherDoc(doc: Record<string, unknown>): WeatherSnapshotItem {
  const fetchedVal = doc.fetchedAt instanceof Date ? doc.fetchedAt.toISOString() : String(doc.fetchedAt ?? new Date().toISOString());
  return {
    id: String(doc.id),
    regionKey: String(doc.regionKey ?? ''),
    regionName: String(doc.regionName ?? ''),
    wardCode: String(doc.wardCode ?? 'DN-TB'),
    lat: Number(doc.lat ?? 10.9465),
    lng: Number(doc.lng ?? 106.8243),
    temperatureC: Number(doc.temperatureC ?? 0),
    humidityPct: Number(doc.humidityPct ?? 0),
    precipitationMm: Number(doc.precipitationMm ?? 0),
    precipitation24hMm: Number(doc.precipitation24hMm ?? 0),
    precipitationProbabilityPct: Number(doc.precipitationProbabilityPct ?? 0),
    windGustsKmh: Number(doc.windGustsKmh ?? 0),
    weatherCode: Number(doc.weatherCode ?? 0),
    weatherLabel: String(doc.weatherLabel ?? 'Ổn định'),
    riskLevel: (doc.riskLevel as WeatherSnapshotItem['riskLevel']) ?? 'normal',
    isHazard: Boolean(doc.isHazard),
    source: String(doc.source ?? 'Dữ liệu khí tượng Open-Meteo'),
    observedAt: String(doc.observedAt ?? fetchedVal),
    fetchedAt: fetchedVal,
  };
}

export interface UpsertExternalAlertInput {
  title: string;
  description: string;
  category: AlertCategory;
  severity: AlertSeverity;
  sourceType: AlertSourceType;
  sourceLabel: string;
  sourceUrl?: string | null;
  sourceUrlHash: string;
  wardIds: string[];
  affectedRoads: string[];
  detourNote?: string | null;
  geometryType: AlertGeometryType;
  lat: number;
  lng: number;
  radiusM?: number | null;
  polyline?: Array<[number, number]>;
  isVerifiedOfficial: boolean;
  expiresAt?: string | null;
  clusterReportCount?: number | null;
  clusterDistinctUsers?: number | null;
}

export class AlertsAndWardsService {
  private readonly fallbackAlertsFile: string;
  private readonly fallbackWeatherFile: string;
  private readonly fallbackBulletinsFile: string;

  constructor(
    private readonly repos: Repositories,
    dataDir = env.dataDir,
  ) {
    const dir = path.join(dataDir, 'aggregator');
    this.fallbackAlertsFile = path.join(dir, 'alerts.json');
    this.fallbackWeatherFile = path.join(dir, 'weather_snapshots.json');
    this.fallbackBulletinsFile = path.join(dir, 'bulletins.json');
  }

  private readFallbackArray<T>(filePath: string): T[] {
    try {
      if (!fs.existsSync(filePath)) return [];
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }

  private writeFallbackArray<T>(filePath: string, items: T[]): void {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(items), 'utf8');
    } catch (err) {
      console.warn('[alerts-wards] Không ghi được fallback file:', err instanceof Error ? err.message : String(err));
    }
  }

  async hasAlertHash(sourceUrlHash: string): Promise<boolean> {
    if (mongoose.connection.readyState === 1) {
      const hit = await Alert.exists({ sourceUrlHash });
      if (hit) return true;
    }
    const local = this.readFallbackArray<CivicAlertItem>(this.fallbackAlertsFile);
    return local.some((a) => a.sourceUrlHash === sourceUrlHash);
  }

  async upsertExternalAlert(input: UpsertExternalAlertInput): Promise<CivicAlertItem> {
    const nowIso = new Date().toISOString();
    if (mongoose.connection.readyState === 1) {
      const existing = (await Alert.findOne({ sourceUrlHash: input.sourceUrlHash }).lean()) as Record<string, unknown> | null;
      if (existing) {
        const updated = (await Alert.findOneAndUpdate(
          { id: String(existing.id) },
          {
            $set: {
              title: input.title,
              description: input.description,
              category: input.category,
              severity: Math.max(Number(existing.severity ?? 1), input.severity),
              wardIds: input.wardIds,
              affectedRoads: input.affectedRoads,
              detourNote: input.detourNote ?? null,
              expiresAt: input.expiresAt ?? null,
              status: 'active',
              ...(input.clusterReportCount !== undefined ? { clusterReportCount: input.clusterReportCount } : {}),
              ...(input.clusterDistinctUsers !== undefined ? { clusterDistinctUsers: input.clusterDistinctUsers } : {}),
            },
          },
          { new: true, lean: true },
        )) as Record<string, unknown> | null;
        if (updated) return mapAlertDoc(updated);
      }

      const id = newId('alt');
      const created = await Alert.create({
        id,
        title: input.title,
        description: input.description,
        category: input.category,
        severity: input.severity,
        sourceType: input.sourceType,
        sourceLabel: input.sourceLabel,
        sourceUrl: input.sourceUrl ?? null,
        sourceUrlHash: input.sourceUrlHash,
        wardIds: input.wardIds.length ? input.wardIds : ['ALL_DONG_NAI'],
        affectedRoads: input.affectedRoads,
        detourNote: input.detourNote ?? null,
        geometryType: input.geometryType,
        lat: input.lat,
        lng: input.lng,
        location: { type: 'Point', coordinates: [input.lng, input.lat] },
        radiusM: input.radiusM ?? null,
        polyline: input.polyline,
        status: 'active',
        isVerifiedOfficial: input.isVerifiedOfficial,
        confirmCount: input.isVerifiedOfficial ? 1 : 0,
        confirmedByUserIds: [],
        clusterReportCount: input.clusterReportCount ?? null,
        clusterDistinctUsers: input.clusterDistinctUsers ?? null,
        startsAt: nowIso,
        expiresAt: input.expiresAt ?? null,
      });
      return mapAlertDoc(created.toObject() as unknown as Record<string, unknown>);
    }

    const items = this.readFallbackArray<CivicAlertItem>(this.fallbackAlertsFile);
    const idx = items.findIndex((a) => a.sourceUrlHash === input.sourceUrlHash);
    if (idx >= 0) {
      const prev = items[idx];
      const next: CivicAlertItem = {
        ...prev,
        title: input.title,
        description: input.description,
        category: input.category,
        severity: Math.max(prev.severity, input.severity) as AlertSeverity,
        wardIds: input.wardIds.length ? input.wardIds : ['ALL_DONG_NAI'],
        affectedRoads: input.affectedRoads,
        detourNote: input.detourNote ?? prev.detourNote ?? null,
        expiresAt: input.expiresAt ?? prev.expiresAt ?? null,
        clusterReportCount: input.clusterReportCount ?? prev.clusterReportCount ?? null,
        clusterDistinctUsers: input.clusterDistinctUsers ?? prev.clusterDistinctUsers ?? null,
        status: 'active',
        updatedAt: nowIso,
      };
      items[idx] = next;
      this.writeFallbackArray(this.fallbackAlertsFile, items.slice(0, 400));
      return next;
    }

    const created: CivicAlertItem = {
      id: newId('alt'),
      title: input.title,
      description: input.description,
      category: input.category,
      severity: input.severity,
      sourceType: input.sourceType,
      sourceLabel: input.sourceLabel,
      sourceUrl: input.sourceUrl ?? null,
      sourceUrlHash: input.sourceUrlHash,
      wardIds: input.wardIds.length ? input.wardIds : ['ALL_DONG_NAI'],
      affectedRoads: input.affectedRoads,
      detourNote: input.detourNote ?? null,
      geometryType: input.geometryType,
      lat: input.lat,
      lng: input.lng,
      radiusM: input.radiusM ?? null,
      polyline: input.polyline,
      status: 'active',
      isVerifiedOfficial: input.isVerifiedOfficial,
      confirmCount: input.isVerifiedOfficial ? 1 : 0,
      confirmedByUserIds: [],
      clusterReportCount: input.clusterReportCount ?? null,
      clusterDistinctUsers: input.clusterDistinctUsers ?? null,
      startsAt: nowIso,
      expiresAt: input.expiresAt ?? null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.writeFallbackArray(this.fallbackAlertsFile, [created, ...items].slice(0, 400));
    return created;
  }

  async listAlerts(opts: {
    category?: AlertCategory;
    severity?: AlertSeverity;
    wardId?: string;
    status?: 'active' | 'resolved' | 'all';
    limit?: number;
  } = {}): Promise<CivicAlertItem[]> {
    const limit = Math.min(Math.max(1, opts.limit ?? 80), 200);
    const statusTarget = opts.status ?? 'active';
    const nowIso = new Date().toISOString();

    let rows: CivicAlertItem[];
    if (mongoose.connection.readyState === 1) {
      const filter: Record<string, unknown> = {};
      if (statusTarget !== 'all') filter.status = statusTarget;
      if (opts.category) filter.category = opts.category;
      if (opts.severity) filter.severity = opts.severity;
      if (opts.wardId) filter.wardIds = { $in: [opts.wardId, 'ALL_DONG_NAI'] };
      const docs = (await Alert.find(filter)
        .sort({ severity: -1, createdAt: -1 })
        .limit(limit)
        .lean()) as Array<Record<string, unknown>>;
      rows = docs.map(mapAlertDoc);
    } else {
      rows = this.readFallbackArray<CivicAlertItem>(this.fallbackAlertsFile).filter((a) => {
        if (statusTarget !== 'all' && a.status !== statusTarget) return false;
        if (opts.category && a.category !== opts.category) return false;
        if (opts.severity && a.severity !== opts.severity) return false;
        if (opts.wardId && !a.wardIds.includes(opts.wardId) && !a.wardIds.includes('ALL_DONG_NAI')) return false;
        return true;
      });
      rows.sort((a, b) => b.severity - a.severity || b.createdAt.localeCompare(a.createdAt));
      rows = rows.slice(0, limit);
    }

    return rows.filter((a) => !a.expiresAt || statusTarget === 'all' || a.expiresAt > nowIso);
  }

  async getAlertById(id: string): Promise<CivicAlertItem | null> {
    if (mongoose.connection.readyState === 1) {
      const doc = (await Alert.findOne({ id }).lean()) as Record<string, unknown> | null;
      return doc ? mapAlertDoc(doc) : null;
    }
    return this.readFallbackArray<CivicAlertItem>(this.fallbackAlertsFile).find((a) => a.id === id) ?? null;
  }

  async createAdminOrRescueAlert(
    actor: UserRecord,
    input: {
      title: string;
      description: string;
      category: AlertCategory;
      severity: AlertSeverity;
      wardIds: string[];
      affectedRoads: string[];
      detourNote?: string;
      geometryType: AlertGeometryType;
      lat: number;
      lng: number;
      radiusM?: number;
      polyline?: Array<[number, number]>;
      expiresAt?: string;
      sourceUrl?: string;
    },
  ): Promise<CivicAlertItem> {
    const nowIso = new Date().toISOString();
    const id = newId('alt');
    const sourceLabel = actor.role === 'rescue' ? 'Đội ứng cứu' : 'Trung tâm Điều hành Đồng Nai';
    const docPayload = {
      id,
      title: input.title,
      description: input.description,
      category: input.category,
      severity: input.severity,
      sourceType: 'rescue_admin' as const,
      sourceLabel,
      sourceUrl: input.sourceUrl ?? null,
      wardIds: input.wardIds,
      affectedRoads: input.affectedRoads,
      detourNote: input.detourNote ?? null,
      geometryType: input.geometryType,
      lat: input.lat,
      lng: input.lng,
      location: { type: 'Point' as const, coordinates: [input.lng, input.lat] as [number, number] },
      radiusM: input.geometryType === 'circle' ? input.radiusM ?? 500 : input.radiusM ?? null,
      polyline: input.geometryType === 'polyline' ? input.polyline : undefined,
      status: 'active' as const,
      isVerifiedOfficial: true,
      confirmCount: 1,
      confirmedByUserIds: [actor.id],
      createdById: actor.id,
      createdByName: actor.name,
      startsAt: nowIso,
      expiresAt: input.expiresAt ?? null,
    };

    if (mongoose.connection.readyState === 1) {
      const created = await Alert.create(docPayload);
      return mapAlertDoc(created.toObject() as unknown as Record<string, unknown>);
    }

    const item: CivicAlertItem = {
      ...docPayload,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const items = this.readFallbackArray<CivicAlertItem>(this.fallbackAlertsFile);
    this.writeFallbackArray(this.fallbackAlertsFile, [item, ...items].slice(0, 400));
    return item;
  }

  async updateAlert(
    id: string,
    patch: {
      status?: 'active' | 'resolved';
      severity?: AlertSeverity;
      title?: string;
      description?: string;
      detourNote?: string | null;
      isVerifiedOfficial?: boolean;
    },
  ): Promise<{ before: CivicAlertItem; after: CivicAlertItem }> {
    const before = await this.getAlertById(id);
    if (!before) throw notFound('Không tìm thấy bản ghi cảnh báo.');
    const nowIso = new Date().toISOString();

    if (mongoose.connection.readyState === 1) {
      const updated = (await Alert.findOneAndUpdate(
        { id },
        { $set: { ...patch } },
        { new: true, lean: true },
      )) as Record<string, unknown> | null;
      if (!updated) throw notFound('Không tìm thấy bản ghi cảnh báo.');
      return { before, after: mapAlertDoc(updated) };
    }

    const items = this.readFallbackArray<CivicAlertItem>(this.fallbackAlertsFile);
    const idx = items.findIndex((a) => a.id === id);
    if (idx < 0) throw notFound('Không tìm thấy bản ghi cảnh báo.');
    const after: CivicAlertItem = { ...items[idx], ...patch, updatedAt: nowIso };
    items[idx] = after;
    this.writeFallbackArray(this.fallbackAlertsFile, items);
    return { before, after };
  }

  async deleteAlert(id: string): Promise<CivicAlertItem> {
    const before = await this.getAlertById(id);
    if (!before) throw notFound('Không tìm thấy bản ghi cảnh báo.');

    if (mongoose.connection.readyState === 1) {
      await Alert.deleteOne({ id });
      return before;
    }

    const items = this.readFallbackArray<CivicAlertItem>(this.fallbackAlertsFile).filter((a) => a.id !== id);
    this.writeFallbackArray(this.fallbackAlertsFile, items);
    return before;
  }

  async createCommunityAlert(
    actor: UserRecord,
    input: {
      title: string;
      description: string;
      category: AlertCategory;
      severity: 1 | 2;
      wardCode?: string;
      lat: number;
      lng: number;
      affectedRoads: string[];
    },
  ): Promise<CivicAlertItem> {
    const nowIso = new Date().toISOString();
    const id = newId('alt');
    const resolvedWard = input.wardCode && WARD_BY_CODE[input.wardCode]
      ? WARD_BY_CODE[input.wardCode]
      : nearestWard(input.lat, input.lng);

    const payload = {
      id,
      title: input.title,
      description: input.description,
      category: input.category,
      severity: input.severity,
      sourceType: 'community_user' as const,
      sourceLabel: 'Cảnh báo cộng đồng (Đang chờ xác minh chính thức)',
      wardIds: [resolvedWard.wardCode],
      affectedRoads: input.affectedRoads,
      geometryType: 'circle' as const,
      lat: input.lat,
      lng: input.lng,
      location: { type: 'Point' as const, coordinates: [input.lng, input.lat] as [number, number] },
      radiusM: 400,
      status: 'active' as const,
      isVerifiedOfficial: false,
      confirmCount: 1,
      confirmedByUserIds: [actor.id],
      createdById: actor.id,
      createdByName: actor.name,
      startsAt: nowIso,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    };

    if (mongoose.connection.readyState === 1) {
      const created = await Alert.create(payload);
      return mapAlertDoc(created.toObject() as unknown as Record<string, unknown>);
    }

    const created: CivicAlertItem = { ...payload, createdAt: nowIso, updatedAt: nowIso };
    const items = this.readFallbackArray<CivicAlertItem>(this.fallbackAlertsFile);
    this.writeFallbackArray(this.fallbackAlertsFile, [created, ...items].slice(0, 400));
    return created;
  }

  async confirmAlert(userId: string, alertId: string): Promise<CivicAlertItem> {
    const alert = await this.getAlertById(alertId);
    if (!alert) throw notFound('Không tìm thấy cảnh báo cần xác nhận.');
    const already = new Set(alert.confirmedByUserIds ?? []);
    if (already.has(userId)) {
      return alert;
    }

    const nextConfirmCount = (alert.confirmCount ?? 0) + 1;
    const nextSeverity: AlertSeverity = nextConfirmCount >= 5 && alert.severity === 1 ? 2 : alert.severity;

    if (mongoose.connection.readyState === 1) {
      const updated = (await Alert.findOneAndUpdate(
        { id: alertId, confirmedByUserIds: { $ne: userId } },
        {
          $addToSet: { confirmedByUserIds: userId },
          $inc: { confirmCount: 1 },
          $set: { severity: nextSeverity },
        },
        { new: true, lean: true },
      )) as Record<string, unknown> | null;
      return updated ? mapAlertDoc(updated) : alert;
    }

    const items = this.readFallbackArray<CivicAlertItem>(this.fallbackAlertsFile);
    const idx = items.findIndex((a) => a.id === alertId);
    if (idx < 0) return alert;
    const next: CivicAlertItem = {
      ...items[idx],
      confirmCount: nextConfirmCount,
      confirmedByUserIds: [...already, userId],
      severity: nextSeverity,
      updatedAt: new Date().toISOString(),
    };
    items[idx] = next;
    this.writeFallbackArray(this.fallbackAlertsFile, items);
    return next;
  }

  /**
   * Geo-Clustering Auto-Escalation:
   * Khi có >= 3 người dân khác nhau phản ánh sự cố trong bán kính 500m & khung thời gian 30 phút,
   * tự động phát cảnh báo cộng đồng trên `/alerts` (dùng `$nearSphere` trên MongoDB Atlas).
   */
  async checkAndEscalateGeoCluster(report: Report): Promise<CivicAlertItem | null> {
    if (report.status === 'quarantined' || report.status === 'rejected') return null;

    const sinceIso = new Date(Date.now() - CLUSTER_WINDOW_MS).toISOString();
    const nearby = await this.repos.reports.findNearby({
      lat: report.lat,
      lng: report.lng,
      radiusM: CLUSTER_RADIUS_M,
      sinceIso,
      limit: 40,
      projection: 'full',
    });

    const validNearby = nearby.filter((r) => r.status !== 'quarantined' && r.status !== 'rejected');
    if (!validNearby.some((r) => r.id === report.id)) {
      validNearby.push(report);
    }

    const distinctUsers = new Set<string>();
    for (const r of validNearby) {
      if (r.reporterId) distinctUsers.add(r.reporterId);
      for (const c of r.contributors ?? []) {
        if (c.userId) distinctUsers.add(c.userId);
      }
    }

    if (distinctUsers.size < CLUSTER_MIN_DISTINCT_USERS) {
      return null;
    }

    const wardName = WARD_BY_CODE[report.wardCode]?.name ?? report.wardCode;
    const severity: AlertSeverity =
      distinctUsers.size >= 5 || report.priority === 'emergency' || report.category === 'ngap_nuoc' ? 3 : 2;
    const alertCategory: AlertCategory = report.category === 'ngap_nuoc' ? 'disaster' : 'traffic';

    // Tránh tạo trùng lặp cảnh báo cụm trong vòng 60 phút & bán kính 600m
    const existingActive = await this.listAlerts({ status: 'active', limit: 100 });
    const recentSameCluster = existingActive.find(
      (a) =>
        a.sourceType === 'community_cluster' &&
        Date.now() - Date.parse(a.createdAt) <= 60 * 60 * 1000 &&
        haversineMeters(a.lat, a.lng, report.lat, report.lng) <= 600,
    );

    const clusterHash =
      recentSameCluster?.sourceUrlHash ??
      sha256(`cluster:${report.wardCode}:${Math.round(report.lat * 200)}:${Math.round(report.lng * 200)}:${Math.floor(Date.now() / (60 * 60 * 1000))}`);

    const roads = Array.from(
      new Set(validNearby.map((r) => r.roadName).filter((x): x is string => typeof x === 'string' && x.trim().length > 0)),
    ).slice(0, 5);

    return this.upsertExternalAlert({
      title: `Phát hiện cụm sự cố (${distinctUsers.size} người báo) tại ${wardName}`,
      description: `Hệ thống ghi nhận ${validNearby.length} phản ánh từ ${distinctUsers.size} người dân khác nhau trong bán kính 500m / 30 phút quanh ${report.address || wardName}. Sự cố gần nhất: ${report.title}.`,
      category: alertCategory,
      severity,
      sourceType: 'community_cluster',
      sourceLabel: 'Cảnh báo cộng đồng (Đang chờ xác minh chính thức)',
      sourceUrlHash: clusterHash,
      wardIds: [report.wardCode],
      affectedRoads: roads,
      geometryType: 'circle',
      lat: report.lat,
      lng: report.lng,
      radiusM: CLUSTER_RADIUS_M,
      isVerifiedOfficial: false,
      clusterReportCount: validNearby.length,
      clusterDistinctUsers: distinctUsers.size,
      expiresAt: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
    });
  }

  async getLatestWeatherSnapshots(): Promise<WeatherSnapshotItem[]> {
    if (mongoose.connection.readyState === 1) {
      const latestDocs = (await WeatherSnapshot.aggregate([
        { $sort: { fetchedAt: -1 } },
        { $group: { _id: '$regionKey', doc: { $first: '$$ROOT' } } },
        { $replaceRoot: { newRoot: '$doc' } },
      ])) as Array<Record<string, unknown>>;
      if (latestDocs.length > 0) {
        return latestDocs.map(mapWeatherDoc);
      }
    }
    return this.readFallbackArray<WeatherSnapshotItem>(this.fallbackWeatherFile);
  }

  async listBulletins(opts: { wardId?: string; category?: AlertCategory; limit?: number } = {}): Promise<OfficialBulletinItem[]> {
    const limit = Math.min(Math.max(1, opts.limit ?? 30), 100);
    if (mongoose.connection.readyState === 1) {
      const filter: Record<string, unknown> = {};
      if (opts.category) filter.category = opts.category;
      if (opts.wardId) filter.wardIds = { $in: [opts.wardId, 'ALL_DONG_NAI'] };
      const docs = (await Bulletin.find(filter)
        .sort({ publishedAt: -1 })
        .limit(limit)
        .lean()) as Array<Record<string, unknown>>;
      if (docs.length > 0) return docs.map(mapBulletinDoc);
    }
    return this.readFallbackArray<OfficialBulletinItem>(this.fallbackBulletinsFile)
      .filter((b) => {
        if (opts.category && b.category !== opts.category) return false;
        if (opts.wardId && !b.wardIds.includes(opts.wardId) && !b.wardIds.includes('ALL_DONG_NAI')) return false;
        return true;
      })
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .slice(0, limit);
  }

  /**
   * Hồ sơ Tổng quan Xã/Phường (`GET /api/wards/:wardId/overview`):
   * Toàn bộ số liệu 30 ngày, heatmap, danh sách sự cố và cảnh báo đều tính 100% từ dữ liệu thật.
   */
  async getWardOverview(
    wardIdRaw: string,
    opts: { statusFilter?: 'all' | 'open' | 'resolved'; page?: number; pageSize?: number } = {},
  ): Promise<WardOverviewResponse> {
    const wardId = wardIdRaw.trim().toUpperCase();
    const ward = WARD_BY_CODE[wardId] ?? DONG_NAI_WARDS.find((w) => w.wardCode === wardId);
    if (!ward) {
      throw notFound(`Không tìm thấy xã/phường mã "${wardIdRaw}" trong danh sách 95 ĐVHC Đồng Nai.`);
    }

    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(Math.max(1, opts.pageSize ?? 20), 60);
    const statusFilter = opts.statusFilter ?? 'all';
    const since30dMs = Date.now() - 30 * DAY_MS;
    const since30dIso = new Date(since30dMs).toISOString();

    if (this.repos.mode === 'mongodb' && mongoose.connection.readyState === 1) {
      const incidentStatusStage = {
        $match:
          statusFilter === 'open'
            ? { normStatus: { $ne: 'resolved' } }
            : statusFilter === 'resolved'
              ? { normStatus: 'resolved' }
              : {},
      };
      const [aggRows, alerts, bulletins, weatherSnapshots] = await Promise.all([
        ReportModel.aggregate<{
          statsSummary: Array<{
            totalReports: number;
            resolvedReports: number;
            openReports: number;
            emergencyReports: number;
          }>;
          resolvedDurations: Array<{ createdAt: string; resolvedAt?: string; updatedAt: string }>;
          heatmapRows: Array<{ lat: number; lng: number; severity?: number; normStatus: string }>;
          totalCount: Array<{ n: number }>;
          paged: Array<Record<string, unknown>>;
        }>([
          {
            $match: {
              wardCode: ward.wardCode,
              status: { $nin: ['quarantined', 'rejected'] },
            },
          },
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
              emergRank: {
                $switch: {
                  branches: [
                    { case: { $eq: ['$priority', 'emergency'] }, then: 2 },
                    { case: { $eq: ['$priority', 'high'] }, then: 1 },
                  ],
                  default: 0,
                },
              },
            },
          },
          {
            $addFields: {
              isOpen: { $ne: ['$normStatus', 'resolved'] },
            },
          },
          {
            $facet: {
              statsSummary: [
                { $match: { createdAt: { $gte: since30dIso } } },
                {
                  $group: {
                    _id: null,
                    totalReports: { $sum: 1 },
                    resolvedReports: { $sum: { $cond: [{ $eq: ['$normStatus', 'resolved'] }, 1, 0] } },
                    openReports: {
                      $sum: {
                        $cond: [{ $in: ['$normStatus', ['received', 'verifying', 'processing']] }, 1, 0],
                      },
                    },
                    emergencyReports: {
                      $sum: {
                        $cond: [
                          {
                            $and: [
                              { $in: ['$normStatus', ['received', 'verifying', 'processing']] },
                              { $or: [{ $eq: ['$priority', 'emergency'] }, { $gte: ['$severity', 4] }] },
                            ],
                          },
                          1,
                          0,
                        ],
                      },
                    },
                  },
                },
              ],
              resolvedDurations: [
                { $match: { createdAt: { $gte: since30dIso }, normStatus: 'resolved' } },
                { $project: { _id: 0, createdAt: 1, resolvedAt: 1, updatedAt: 1 } },
              ],
              heatmapRows: [
                { $match: { createdAt: { $gte: since30dIso }, lat: { $type: 'number' }, lng: { $type: 'number' } } },
                { $limit: 300 },
                { $project: { _id: 0, lat: 1, lng: 1, severity: 1, normStatus: 1 } },
              ],
              totalCount: [incidentStatusStage, { $count: 'n' }],
              paged: [
                incidentStatusStage,
                { $sort: { isOpen: -1, emergRank: -1, createdAt: -1 } },
                { $skip: (page - 1) * pageSize },
                { $limit: pageSize },
                { $project: { _id: 0, normStatus: 0, emergRank: 0, isOpen: 0, location: 0, imageHash: 0, syncId: 0, customCategoryLabel: 0 } },
              ],
            },
          },
        ]),
        this.listAlerts({ wardId: ward.wardCode, status: 'active', limit: 30 }),
        this.listBulletins({ wardId: ward.wardCode, limit: 20 }),
        this.getLatestWeatherSnapshots(),
      ]);

      const agg = aggRows[0];
      const sm = agg?.statsSummary?.[0];
      const totalReports = sm?.totalReports ?? 0;
      const resolvedReports = sm?.resolvedReports ?? 0;
      const resolvedPct = totalReports > 0 ? Math.round((resolvedReports / totalReports) * 100) : 0;
      const openReports = sm?.openReports ?? 0;
      const emergencyReports = sm?.emergencyReports ?? 0;

      let totalHours = 0;
      let resolvedWithDuration = 0;
      for (const r of agg?.resolvedDurations ?? []) {
        const startMs = Date.parse(r.createdAt);
        const endMs = Date.parse(r.resolvedAt || r.updatedAt);
        if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
          totalHours += (endMs - startMs) / 3_600_000;
          resolvedWithDuration += 1;
        }
      }
      const avgResolutionHours =
        resolvedWithDuration > 0 ? Math.round((totalHours / resolvedWithDuration) * 10) / 10 : null;
      const areaStatus: WardOverviewStatus =
        emergencyReports >= 2 || openReports >= 6
          ? 'Điểm nóng'
          : openReports >= 2 || emergencyReports >= 1
            ? 'Cần chú ý'
            : 'Ổn định';
      const heatmapPoints: Array<[number, number, number]> = (agg?.heatmapRows ?? [])
        .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng))
        .map((r) => {
          const base = Math.min(1, Math.max(0.25, (r.severity ?? 2) / 5));
          const openBoost = r.normStatus === 'resolved' ? 0 : 0.2;
          const intensity = Math.round(Math.min(1, base + openBoost) * 100) / 100;
          return [r.lat, r.lng, intensity];
        });
      const totalFiltered = agg?.totalCount?.[0]?.n ?? 0;
      const pagedIncidents = (agg?.paged ?? [])
        .map((d) => reportFromDoc(d))
        .filter((r): r is Report => Boolean(r));
      const startIdx = (page - 1) * pageSize;

      let matchedWeather: WeatherSnapshotItem | null =
        weatherSnapshots.find((w) => w.wardCode === ward.wardCode) ?? null;
      if (!matchedWeather && weatherSnapshots.length > 0) {
        let bestDist = Infinity;
        for (const w of weatherSnapshots) {
          const d = haversineMeters(ward.centerLat, ward.centerLng, w.lat, w.lng);
          if (d < bestDist) {
            bestDist = d;
            matchedWeather = w;
          }
        }
      }

      return {
        ward,
        stats30d: {
          totalReports,
          resolvedReports,
          resolvedPct,
          openReports,
          emergencyReports,
          avgResolutionHours,
          areaStatus,
        },
        heatmapPoints,
        incidents: {
          items: pagedIncidents,
          total: totalFiltered,
          page,
          pageSize,
          hasMore: startIdx + pagedIncidents.length < totalFiltered,
        },
        alerts,
        bulletins,
        weather: matchedWeather,
      };
    }

    const [wardReportsAll, alerts, bulletins, weatherSnapshots] = await Promise.all([
      this.repos.reports.list({ wardCodes: [ward.wardCode], projection: 'full', limit: 500 }),
      this.listAlerts({ wardId: ward.wardCode, status: 'active', limit: 30 }),
      this.listBulletins({ wardId: ward.wardCode, limit: 20 }),
      this.getLatestWeatherSnapshots(),
    ]);

    const reports30d = wardReportsAll.filter((r) => {
      if (r.status === 'quarantined' || r.status === 'rejected') return false;
      const t = Date.parse(r.createdAt);
      return Number.isFinite(t) ? t >= since30dMs : true;
    });

    const totalReports = reports30d.length;
    const resolvedList = reports30d.filter((r) => r.status === 'resolved');
    const resolvedReports = resolvedList.length;
    const resolvedPct = totalReports > 0 ? Math.round((resolvedReports / totalReports) * 100) : 0;
    const openReportsList = reports30d.filter((r) => ['received', 'verifying', 'processing'].includes(r.status));
    const openReports = openReportsList.length;
    const emergencyReports = openReportsList.filter((r) => r.priority === 'emergency' || r.severity >= 4).length;

    let totalHours = 0;
    let resolvedWithDuration = 0;
    for (const r of resolvedList) {
      const startMs = Date.parse(r.createdAt);
      const endMs = Date.parse(r.resolvedAt || r.updatedAt);
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
        totalHours += (endMs - startMs) / 3_600_000;
        resolvedWithDuration += 1;
      }
    }
    const avgResolutionHours =
      resolvedWithDuration > 0 ? Math.round((totalHours / resolvedWithDuration) * 10) / 10 : null;

    const areaStatus: WardOverviewStatus =
      emergencyReports >= 2 || openReports >= 6
        ? 'Điểm nóng'
        : openReports >= 2 || emergencyReports >= 1
          ? 'Cần chú ý'
          : 'Ổn định';

    const heatmapPoints: Array<[number, number, number]> = reports30d
      .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng))
      .slice(0, 300)
      .map((r) => {
        const base = Math.min(1, Math.max(0.25, r.severity / 5));
        const openBoost = r.status === 'resolved' ? 0 : 0.2;
        const intensity = Math.round(Math.min(1, base + openBoost) * 100) / 100;
        return [r.lat, r.lng, intensity];
      });

    const filteredIncidents = wardReportsAll
      .filter((r) => {
        if (r.status === 'quarantined' || r.status === 'rejected') return false;
        if (statusFilter === 'open') return r.status !== 'resolved';
        if (statusFilter === 'resolved') return r.status === 'resolved';
        return true;
      })
      .sort((a, b) => {
        const aOpen = a.status === 'resolved' ? 0 : 1;
        const bOpen = b.status === 'resolved' ? 0 : 1;
        if (aOpen !== bOpen) return bOpen - aOpen;
        const aEmerg = a.priority === 'emergency' ? 2 : a.priority === 'high' ? 1 : 0;
        const bEmerg = b.priority === 'emergency' ? 2 : b.priority === 'high' ? 1 : 0;
        if (aEmerg !== bEmerg) return bEmerg - aEmerg;
        return b.createdAt.localeCompare(a.createdAt);
      });

    const startIdx = (page - 1) * pageSize;
    const pagedIncidents = filteredIncidents.slice(startIdx, startIdx + pageSize);

    // Lấy dữ liệu thời tiết khớp ward hoặc cụm gần nhất
    let matchedWeather: WeatherSnapshotItem | null =
      weatherSnapshots.find((w) => w.wardCode === ward.wardCode) ?? null;
    if (!matchedWeather && weatherSnapshots.length > 0) {
      let bestDist = Infinity;
      for (const w of weatherSnapshots) {
        const d = haversineMeters(ward.centerLat, ward.centerLng, w.lat, w.lng);
        if (d < bestDist) {
          bestDist = d;
          matchedWeather = w;
        }
      }
    }

    return {
      ward,
      stats30d: {
        totalReports,
        resolvedReports,
        resolvedPct,
        openReports,
        emergencyReports,
        avgResolutionHours,
        areaStatus,
      },
      heatmapPoints,
      incidents: {
        items: pagedIncidents,
        total: filteredIncidents.length,
        page,
        pageSize,
        hasMore: startIdx + pagedIncidents.length < filteredIncidents.length,
      },
      alerts,
      bulletins,
      weather: matchedWeather,
    };
  }

  /**
   * Kiểm tra an toàn tuyến đường (`GET /api/alerts/route-check?road=...`):
   * Đối chiếu thực tế các cảnh báo thiên tai/giao thông đang hiệu lực + sự cố giao thông/ngập còn mở.
   */
  async checkRouteSafety(roadRaw: string): Promise<RouteCheckResponse> {
    const roadQuery = roadRaw.trim();
    if (roadQuery.length < 2) {
      throw badRequest('Vui lòng nhập tên tuyến đường cần kiểm tra (ví dụ: QL1A, QL51, Đồng Khởi).');
    }

    const aliases = normalizeRoadAliases(roadQuery);
    const matchesRoad = (haystack: string): boolean => {
      const clean = stripVnDiacritics(haystack);
      return aliases.some((a) => clean.includes(a));
    };

    const [activeAlerts, recentReports] = await Promise.all([
      this.listAlerts({ status: 'active', limit: 150 }),
      this.repos.reports.list({ statuses: ['received', 'verifying', 'processing'], limit: 300, projection: 'full' }),
    ]);

    const matchedAlerts = activeAlerts.filter(
      (a) =>
        a.affectedRoads.some(matchesRoad) ||
        matchesRoad(a.title) ||
        matchesRoad(a.description),
    );

    const matchedReports = recentReports.filter(
      (r) =>
        (r.category === 'ngap_nuoc' || r.category === 'mat_duong' || r.category === 'den_duong' || r.category === 'khac') &&
        (matchesRoad(r.roadName ?? '') || matchesRoad(r.address ?? '') || matchesRoad(r.title)),
    );

    let maxSeverity: 0 | 1 | 2 | 3 = 0;
    for (const a of matchedAlerts) {
      if (a.severity > maxSeverity) maxSeverity = a.severity;
    }
    if (maxSeverity === 0 && matchedReports.length > 0) {
      maxSeverity = matchedReports.some((r) => r.priority === 'emergency') ? 2 : 1;
    }

    const status: RouteCheckResponse['status'] =
      maxSeverity === 3 ? 'danger' : maxSeverity >= 1 ? 'caution' : 'clear';

    const message =
      status === 'danger'
        ? `CẢNH BÁO KHẨN CẤP trên "${roadQuery}": có ${matchedAlerts.length} cảnh báo hiệu lực và ${matchedReports.length} sự cố hiện trường đang xử lý. Nên chọn lộ trình tránh nếu có thể.`
        : status === 'caution'
          ? `CHÚ Ý KHI LƯU THÔNG qua "${roadQuery}": ghi nhận ${matchedAlerts.length} cảnh báo và ${matchedReports.length} sự cố hiện trường chưa xử lý xong.`
          : `Hiện chưa ghi nhận cảnh báo thiên tai, thi công hay sự cố tồn đọng nào trên tuyến "${roadQuery}" từ nguồn dữ liệu thời gian thực.`;

    return {
      roadQuery,
      status,
      maxSeverity,
      activeAlerts: matchedAlerts,
      relatedIncidentsCount: matchedReports.length,
      message,
      checkedAt: new Date().toISOString(),
    };
  }

  /** Helper dùng nội bộ khi tạo Bulletin/Weather fallback snapshot trên SQLite/test */
  getFallbackPaths() {
    return {
      weatherFile: this.fallbackWeatherFile,
      bulletinsFile: this.fallbackBulletinsFile,
      alertsFile: this.fallbackAlertsFile,
    };
  }
}
