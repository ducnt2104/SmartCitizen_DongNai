import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { DONG_NAI_WARDS, WARD_BY_CODE } from '../shared/dongNaiWards';
import type {
  AlertCategory,
  AlertSeverity,
  DailyDigestItem,
  OfficialBulletinItem,
  WeatherRiskLevel,
  WeatherSnapshotItem,
} from '../shared/types';
import { env } from '../config/env';
import { Bulletin, DailyDigest, WeatherSnapshot } from '../models';
import type { Repositories } from '../repositories/types';
import { newId, sha256 } from '../utils/crypto';
import { stripVnDiacritics } from './alertsAndWards.service';
import type { AlertsAndWardsService } from './alertsAndWards.service';
import type { GeminiService } from './gemini.service';
import { safeFetchOfficial } from './ssrfGuard';

export interface DongNaiWeatherZone {
  regionKey: string;
  regionName: string;
  wardCode: string;
  lat: number;
  lng: number;
}

export const DONG_NAI_WEATHER_ZONES: readonly DongNaiWeatherZone[] = [
  { regionKey: 'bien_hoa_tran_bien', regionName: 'Biên Hòa — Trấn Biên', wardCode: 'DN-TB', lat: 10.9465, lng: 106.8243 },
  { regionKey: 'long_thanh', regionName: 'Long Thành', wardCode: 'DN-LTH', lat: 10.7782, lng: 106.9462 },
  { regionKey: 'nhon_trach', regionName: 'Nhơn Trạch', wardCode: 'DN-NTR', lat: 10.7458, lng: 106.9474 },
  { regionKey: 'trang_bom', regionName: 'Trảng Bom', wardCode: 'DN-TBO', lat: 10.9526, lng: 107.0104 },
  { regionKey: 'long_khanh', regionName: 'Long Khánh', wardCode: 'DN-LKH', lat: 10.9336, lng: 107.2627 },
  { regionKey: 'dinh_quan', regionName: 'Định Quán', wardCode: 'DN-DQU', lat: 11.202, lng: 107.352 },
  { regionKey: 'tan_phu', regionName: 'Tân Phú — Tà Lài', wardCode: 'DN-TPU', lat: 11.2695, lng: 107.4277 },
  { regionKey: 'vinh_cuu_tri_an', regionName: 'Trị An — Vĩnh Cửu', wardCode: 'DN-TRA', lat: 11.0964, lng: 107.0391 },
  { regionKey: 'binh_phuoc_bac_dn', regionName: 'Bắc Đồng Nai (Bình Phước)', wardCode: 'DN-BP', lat: 11.535, lng: 106.8832 },
] as const;

export interface OfficialFeedSource {
  sourceName: string;
  url: string;
}

export const OFFICIAL_RSS_FEEDS: readonly OfficialFeedSource[] = [
  { sourceName: 'Báo Đồng Nai', url: 'https://baodongnai.com.vn/rss/news/tin-moi.rss' },
  { sourceName: 'Báo Đồng Nai (Xã hội)', url: 'https://baodongnai.com.vn/rss/news/xa-hoi.rss' },
  { sourceName: 'Báo Đồng Nai (Chính quyền)', url: 'https://baodongnai.com.vn/rss/news/chinh-quyen.rss' },
  { sourceName: 'Tuổi Trẻ Online', url: 'https://tuoitre.vn/rss/thoi-su.rss' },
  { sourceName: 'VnExpress', url: 'https://vnexpress.net/rss/thoi-su.rss' },
  { sourceName: 'Báo Thanh Niên', url: 'https://thanhnien.vn/rss/thoi-su.rss' },
] as const;

const SYNC_INTERVAL_MS = 15 * 60 * 1000;
const DIGEST_TTL_MS = 2 * 60 * 60 * 1000;

function classifyRssEntryDeterministic(input: {
  title: string;
  description: string;
  sourceName: string;
}): {
  isRelevant: boolean;
  category: AlertCategory;
  severity: AlertSeverity;
  wardIds: string[];
  affectedRoads: string[];
  cleanSummary: string;
} {
  const cleanSummary = input.description.replace(/\s+/g, ' ').trim() || input.title.trim();
  const norm = stripVnDiacritics(`${input.title} ${cleanSummary}`);
  const isDongNaiSource = stripVnDiacritics(input.sourceName).includes('dong nai');

  const hasDongNaiKeyword =
    /\b(dong nai|bien hoa|tran bien|long thanh|nhon trach|trang bom|long khanh|xuan loc|dinh quan|tan phu|vinh cuu|cam my|thong nhat|binh phuoc|dong xoai|chon thanh|binh long|phuoc long|loc ninh|bu dang|bu dop|bu gia map|quoc lo 51|ql51|ql 51|quoc lo 1a|ql1a|quoc lo 20|ql20|dong khoi|vo nguyen giap|pham van thuan|bui van hoa|tri an|cat tien|san bay long thanh|cao toc bien hoa|cau dong nai|cau an hao|cau hoa an)\b/.test(
      norm,
    );

  const isDisaster =
    /\b(ngap lut|ngap ung|mua lon|mua to|mua giong|bao|ap thap|trieu cuong|sat lo|loc xoay|thien tai|lu quet|lu lut|canh bao thoi tiet|khi tuong|thuy van|chay rung|nang nong)\b/.test(
      norm,
    );
  const isTraffic =
    /\b(giao thong|phan luong|thi cong|ket xe|un tac|tai nan|cam duong|sua duong|quoc lo|cao toc|tinh lo|ql51|ql1a|ql20|dt768|dt769|dong khoi|vo nguyen giap|nut giao)\b/.test(
      norm,
    );
  const isUtility =
    /\b(cup dien|mat dien|ngung cap dien|dien luc|cup nuoc|mat nuoc|cap nuoc|nuoc sach|ubnd|chinh quyen|thong bao|nghi quyet|sap nhap|phuong|xa)\b/.test(
      norm,
    );

  const isRelevant = isDongNaiSource || hasDongNaiKeyword || isDisaster;
  const category: AlertCategory = isDisaster
    ? 'disaster'
    : isTraffic
      ? 'traffic'
      : isUtility
        ? 'utility'
        : 'official_notice';

  const severity: AlertSeverity =
    /\b(khan cap|ngap sau|chia cat|bao lon|lu quet|sap cau|tai nan nghiem trong|mat dien dien rong)\b/.test(norm)
      ? 3
      : isDisaster || isTraffic
        ? 2
        : 1;

  const matchedWards = DONG_NAI_WARDS.filter((w) => {
    const shortNorm = stripVnDiacritics(w.shortName);
    return shortNorm.length >= 4 && norm.includes(shortNorm);
  })
    .slice(0, 4)
    .map((w) => w.wardCode);
  const wardIds = matchedWards.length > 0 ? matchedWards : ['ALL_DONG_NAI'];

  const roadMatches: Array<[RegExp, string]> = [
    [/\b(quoc lo 1a|ql1a|ql 1a)\b/, 'Quốc lộ 1A'],
    [/\b(quoc lo 51|ql51|ql 51)\b/, 'Quốc lộ 51'],
    [/\b(quoc lo 20|ql20|ql 20)\b/, 'Quốc lộ 20'],
    [/\bvo nguyen giap\b/, 'Võ Nguyên Giáp'],
    [/\bdong khoi\b/, 'Đồng Khởi'],
    [/\bpham van thuan\b/, 'Phạm Văn Thuận'],
    [/\bbui van hoa\b/, 'Bùi Văn Hòa'],
    [/\b(dt 768|dt768)\b/, 'ĐT 768'],
  ];
  const affectedRoads = roadMatches.filter(([re]) => re.test(norm)).map(([, label]) => label);

  return { isRelevant, category, severity, wardIds, affectedRoads, cleanSummary };
}

export type FetcherLike = (url: string, init?: { timeoutMs?: number; headers?: Record<string, string> }) => Promise<Response>;

function decodeXmlEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  return m ? decodeXmlEntities(m[1]) : '';
}

export interface ParsedRssItem {
  title: string;
  link: string;
  description: string;
  publishedAt: string;
}

export function parseRssItems(xmlText: string): ParsedRssItem[] {
  const items: ParsedRssItem[] = [];
  const itemMatches = xmlText.match(/<item\b[\s\S]*?<\/item>/gi) ?? xmlText.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];

  for (const rawItem of itemMatches) {
    const title = extractTag(rawItem, 'title');
    let link = extractTag(rawItem, 'link');
    if (!link) {
      const hrefMatch = rawItem.match(/<link[^>]+href=["']([^"']+)["']/i);
      if (hrefMatch) link = hrefMatch[1].trim();
    }
    const description = extractTag(rawItem, 'description') || extractTag(rawItem, 'summary') || extractTag(rawItem, 'content');
    const pubRaw = extractTag(rawItem, 'pubDate') || extractTag(rawItem, 'updated') || extractTag(rawItem, 'published');
    const parsedDate = pubRaw ? Date.parse(pubRaw) : NaN;
    const publishedAt = Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : new Date().toISOString();
    if (title && link) {
      items.push({ title, link, description, publishedAt });
    }
  }
  return items;
}

export function describeWmoWeatherCode(code: number): string {
  if (code === 0) return 'Trời quang';
  if (code === 1 || code === 2) return 'Ít mây';
  if (code === 3) return 'Nhiều mây';
  if (code === 45 || code === 48) return 'Sương mù';
  if (code >= 51 && code <= 57) return 'Mưa phùn';
  if (code === 61) return 'Mưa nhỏ';
  if (code === 63) return 'Mưa vừa';
  if (code === 65 || code === 67) return 'Mưa rất to';
  if (code >= 80 && code <= 82) return 'Mưa rào mạnh';
  if (code >= 95) return 'Mưa dông, gió giật';
  return 'Thời tiết biến động';
}

export function classifyWeatherRisk(precipMm: number, precip24hMm: number, windGustsKmh: number): {
  riskLevel: WeatherRiskLevel;
  isHazard: boolean;
} {
  if (precipMm >= 50 || precip24hMm >= 100 || windGustsKmh >= 75) {
    return { riskLevel: 'emergency', isHazard: true };
  }
  if (precipMm > 30 || precip24hMm > 70 || windGustsKmh >= 60) {
    return { riskLevel: 'warning', isHazard: true };
  }
  if (precipMm >= 15 || precip24hMm >= 40 || windGustsKmh >= 45) {
    return { riskLevel: 'advisory', isHazard: false };
  }
  return { riskLevel: 'normal', isHazard: false };
}

export interface SyncRunSummary {
  startedAt: string;
  finishedAt: string;
  skippedOverlap: boolean;
  weatherZonesUpdated: number;
  weatherAlertsTriggered: number;
  rssItemsScanned: number;
  bulletinsSaved: number;
  rssAlertsCreated: number;
  errors: string[];
}

export class DataAggregatorService {
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private warmupTimer: NodeJS.Timeout | null = null;
  private lastSyncSummary: SyncRunSummary | null = null;
  private lastRssSyncAtMs = 0;
  private rssSyncInFlight: Promise<void> | null = null;
  private digestInFlight: Promise<DailyDigestItem> | null = null;
  private readonly fallbackDigestFile: string;
  private readonly seenHashMemory = new Set<string>();

  constructor(
    private readonly repos: Repositories,
    private readonly gemini: GeminiService,
    private readonly alertsAndWards: AlertsAndWardsService,
    dataDir = env.dataDir,
  ) {
    this.fallbackDigestFile = path.join(dataDir, 'aggregator', 'daily_digest.json');
  }

  startScheduler(): void {
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) return;
    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.syncAll().catch((err) => {
        console.warn('[aggregator] Lỗi đồng bộ định kỳ:', err instanceof Error ? err.message : String(err));
      });
    }, SYNC_INTERVAL_MS);
    this.timer.unref();

    // Warm sync nhẹ sau khi server boot xong 6s để có dữ liệu thật ngay mà không nghẽn healthz lúc khởi động
    this.warmupTimer = setTimeout(() => {
      void this.syncAll().catch((err) => {
        console.warn('[aggregator] Lỗi warm-sync ban đầu:', err instanceof Error ? err.message : String(err));
      });
    }, 6_000);
    this.warmupTimer.unref();
  }

  stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.warmupTimer) {
      clearTimeout(this.warmupTimer);
      this.warmupTimer = null;
    }
  }

  get status() {
    return {
      isRunning: this.isRunning,
      lastSyncSummary: this.lastSyncSummary,
    };
  }

  async syncAll(opts: { skipWeather?: boolean; skipRss?: boolean; fetcher?: FetcherLike } = {}): Promise<SyncRunSummary> {
    const startedAt = new Date().toISOString();
    if (this.isRunning) {
      return {
        startedAt,
        finishedAt: new Date().toISOString(),
        skippedOverlap: true,
        weatherZonesUpdated: 0,
        weatherAlertsTriggered: 0,
        rssItemsScanned: 0,
        bulletinsSaved: 0,
        rssAlertsCreated: 0,
        errors: ['Đang có tiến trình tổng hợp dữ liệu khác đang chạy.'],
      };
    }

    this.isRunning = true;
    const errors: string[] = [];
    let weatherZonesUpdated = 0;
    let weatherAlertsTriggered = 0;
    let rssItemsScanned = 0;
    let bulletinsSaved = 0;
    let rssAlertsCreated = 0;

    try {
      if (!opts.skipWeather) {
        try {
          const wRes = await this.syncWeatherSnapshots(opts.fetcher);
          weatherZonesUpdated = wRes.updatedCount;
          weatherAlertsTriggered = wRes.alertsTriggered;
        } catch (err) {
          errors.push(`Open-Meteo: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (!opts.skipRss) {
        try {
          const rRes = await this.syncOfficialBulletins(opts.fetcher);
          rssItemsScanned = rRes.scannedCount;
          bulletinsSaved = rRes.savedCount;
          rssAlertsCreated = rRes.alertsCreated;
          errors.push(...rRes.feedErrors);
        } catch (err) {
          errors.push(`RSS: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const summary: SyncRunSummary = {
        startedAt,
        finishedAt: new Date().toISOString(),
        skippedOverlap: false,
        weatherZonesUpdated,
        weatherAlertsTriggered,
        rssItemsScanned,
        bulletinsSaved,
        rssAlertsCreated,
        errors,
      };
      this.lastSyncSummary = summary;
      return summary;
    } finally {
      this.isRunning = false;
    }
  }

  async syncWeatherSnapshots(fetcher: FetcherLike = safeFetchOfficial): Promise<{
    updatedCount: number;
    alertsTriggered: number;
    snapshots: WeatherSnapshotItem[];
  }> {
    const lats = DONG_NAI_WEATHER_ZONES.map((z) => z.lat).join(',');
    const lngs = DONG_NAI_WEATHER_ZONES.map((z) => z.lng).join(',');
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lngs}` +
      '&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_gusts_10m' +
      '&hourly=precipitation_probability,precipitation&forecast_days=1&timezone=Asia%2FHo_Chi_Minh';

    const res = await fetcher(url, { timeoutMs: 6000 });
    if (!res.ok) {
      throw new Error(`Open-Meteo trả về HTTP ${res.status}`);
    }
    const rawJson = (await res.json()) as unknown;
    const rows = Array.isArray(rawJson) ? rawJson : [rawJson];
    const fetchedAtDate = new Date();
    const fetchedAtIso = fetchedAtDate.toISOString();
    const todayKey = fetchedAtIso.slice(0, 10);

    const snapshots: WeatherSnapshotItem[] = [];
    let alertsTriggered = 0;

    for (let i = 0; i < DONG_NAI_WEATHER_ZONES.length; i++) {
      const zone = DONG_NAI_WEATHER_ZONES[i];
      const entry = rows[i] as Record<string, unknown> | undefined;
      if (!entry || typeof entry !== 'object') continue;
      const cur = (entry.current ?? {}) as Record<string, unknown>;
      const hourly = (entry.hourly ?? {}) as Record<string, unknown>;
      const hourlyPrecip = Array.isArray(hourly.precipitation)
        ? hourly.precipitation.slice(0, 24).map((v) => Number(v) || 0)
        : [];
      const hourlyProb = Array.isArray(hourly.precipitation_probability)
        ? hourly.precipitation_probability.slice(0, 12).map((v) => Number(v) || 0)
        : [];

      const temperatureC = Math.round((Number(cur.temperature_2m ?? 0)) * 10) / 10;
      const humidityPct = Math.round(Number(cur.relative_humidity_2m ?? 0));
      const precipitationMm = Math.round((Number(cur.precipitation ?? 0)) * 10) / 10;
      const precipitation24hMm = Math.round(hourlyPrecip.reduce((s, x) => s + x, 0) * 10) / 10;
      const precipitationProbabilityPct = hourlyProb.length ? Math.round(Math.max(...hourlyProb)) : 0;
      const windGustsKmh = Math.round((Number(cur.wind_gusts_10m ?? 0)) * 10) / 10;
      const weatherCode = Math.round(Number(cur.weather_code ?? 0));
      const weatherLabel = describeWmoWeatherCode(weatherCode);
      const { riskLevel, isHazard } = classifyWeatherRisk(precipitationMm, precipitation24hMm, windGustsKmh);
      const observedAt = typeof cur.time === 'string' ? cur.time : fetchedAtIso;

      const item: WeatherSnapshotItem = {
        id: newId('wx'),
        regionKey: zone.regionKey,
        regionName: zone.regionName,
        wardCode: zone.wardCode,
        lat: zone.lat,
        lng: zone.lng,
        temperatureC,
        humidityPct,
        precipitationMm,
        precipitation24hMm,
        precipitationProbabilityPct,
        windGustsKmh,
        weatherCode,
        weatherLabel,
        riskLevel,
        isHazard,
        source: 'Dữ liệu khí tượng Open-Meteo',
        observedAt,
        fetchedAt: fetchedAtIso,
      };
      snapshots.push(item);

      if (precipitationMm > 30 || precipitation24hMm > 70) {
        const sev: AlertSeverity = riskLevel === 'emergency' ? 3 : 2;
        const hash = sha256(`open-meteo:${zone.regionKey}:${todayKey}`);
        await this.alertsAndWards.upsertExternalAlert({
          title: `Cảnh báo mưa lớn / nguy cơ ngập úng tại ${zone.regionName}`,
          description: `Lượng mưa hiện tại đạt ${precipitationMm} mm/giờ (dự báo 24h tới ${precipitation24hMm} mm, xác suất ${precipitationProbabilityPct}%, gió giật ${windGustsKmh} km/h). Người dân cần chủ động phòng tránh ngập cục bộ và sạt lở.`,
          category: 'disaster',
          severity: sev,
          sourceType: 'weather_api',
          sourceLabel: 'Dữ liệu khí tượng Open-Meteo',
          sourceUrl: 'https://open-meteo.com',
          sourceUrlHash: hash,
          wardIds: [zone.wardCode],
          affectedRoads: WARD_BY_CODE[zone.wardCode]?.arterialRoads ?? [],
          geometryType: 'circle',
          lat: zone.lat,
          lng: zone.lng,
          radiusM: 8000,
          isVerifiedOfficial: true,
          expiresAt: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
        });
        alertsTriggered += 1;
      }
    }

    if (snapshots.length > 0) {
      if (mongoose.connection.readyState === 1) {
        await WeatherSnapshot.insertMany(
          snapshots.map((s) => ({ ...s, fetchedAt: fetchedAtDate })),
          { ordered: false },
        ).catch(() => undefined);
      } else {
        const { weatherFile } = this.alertsAndWards.getFallbackPaths();
        fs.mkdirSync(path.dirname(weatherFile), { recursive: true });
        fs.writeFileSync(weatherFile, JSON.stringify(snapshots), 'utf8');
      }
    }

    return {
      updatedCount: snapshots.length,
      alertsTriggered,
      snapshots,
    };
  }

  private async hasBulletinHash(sourceUrlHash: string): Promise<boolean> {
    if (this.seenHashMemory.has(sourceUrlHash)) return true;
    if (mongoose.connection.readyState === 1) {
      const hit = await Bulletin.exists({ sourceUrlHash });
      if (hit) {
        this.seenHashMemory.add(sourceUrlHash);
        return true;
      }
    }
    const { bulletinsFile } = this.alertsAndWards.getFallbackPaths();
    try {
      if (fs.existsSync(bulletinsFile)) {
        const arr = JSON.parse(fs.readFileSync(bulletinsFile, 'utf8')) as OfficialBulletinItem[];
        if (arr.some((b) => b.sourceUrlHash === sourceUrlHash)) {
          this.seenHashMemory.add(sourceUrlHash);
          return true;
        }
      }
    } catch {
      // Bỏ qua lỗi đọc file cũ
    }
    return false;
  }

  private async saveBulletin(item: OfficialBulletinItem): Promise<void> {
    this.seenHashMemory.add(item.sourceUrlHash);
    if (mongoose.connection.readyState === 1) {
      await Bulletin.updateOne(
        { sourceUrlHash: item.sourceUrlHash },
        {
          $setOnInsert: {
            ...item,
            publishedAt: new Date(item.publishedAt),
            fetchedAt: new Date(item.fetchedAt),
          },
        },
        { upsert: true },
      );
      return;
    }

    const { bulletinsFile } = this.alertsAndWards.getFallbackPaths();
    let existing: OfficialBulletinItem[] = [];
    try {
      if (fs.existsSync(bulletinsFile)) {
        const parsed = JSON.parse(fs.readFileSync(bulletinsFile, 'utf8')) as unknown;
        if (Array.isArray(parsed)) existing = parsed as OfficialBulletinItem[];
      }
    } catch {
      existing = [];
    }
    if (existing.some((b) => b.sourceUrlHash === item.sourceUrlHash)) return;
    fs.mkdirSync(path.dirname(bulletinsFile), { recursive: true });
    fs.writeFileSync(bulletinsFile, JSON.stringify([item, ...existing].slice(0, 250)), 'utf8');
  }

  async ensureFreshBulletins(): Promise<void> {
    if (Date.now() - this.lastRssSyncAtMs < SYNC_INTERVAL_MS) return;
    if (this.rssSyncInFlight) return this.rssSyncInFlight;
    this.rssSyncInFlight = this.syncOfficialBulletins()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.rssSyncInFlight = null;
      });
    return this.rssSyncInFlight;
  }

  async syncOfficialBulletins(
    fetcher: FetcherLike = safeFetchOfficial,
    feeds: readonly OfficialFeedSource[] = OFFICIAL_RSS_FEEDS,
  ): Promise<{
    scannedCount: number;
    savedCount: number;
    alertsCreated: number;
    feedErrors: string[];
  }> {
    let scannedCount = 0;
    let savedCount = 0;
    let alertsCreated = 0;
    const feedErrors: string[] = [];

    for (const feed of feeds) {
      try {
        const res = await fetcher(feed.url, { timeoutMs: 7000 });
        if (!res.ok) {
          feedErrors.push(`${feed.sourceName}: HTTP ${res.status}`);
          continue;
        }
        const xml = await res.text();
        const items = parseRssItems(xml).slice(0, 15);

        for (const entry of items) {
          scannedCount += 1;
          const sourceUrlHash = sha256(`${entry.link}|${entry.title}`);
          if (await this.hasBulletinHash(sourceUrlHash)) {
            continue;
          }

          const classified = classifyRssEntryDeterministic({
            title: entry.title,
            description: entry.description,
            sourceName: feed.sourceName,
          });

          if (!classified.isRelevant) {
            this.seenHashMemory.add(sourceUrlHash);
            continue;
          }

          const bulletin: OfficialBulletinItem = {
            id: newId('blt'),
            title: entry.title.trim(),
            cleanSummary: classified.cleanSummary,
            category: classified.category,
            severity: classified.severity,
            wardIds: classified.wardIds,
            affectedRoads: classified.affectedRoads,
            sourceName: feed.sourceName,
            sourceUrl: entry.link,
            sourceUrlHash,
            publishedAt: entry.publishedAt,
            fetchedAt: new Date().toISOString(),
          };
          await this.saveBulletin(bulletin);
          savedCount += 1;

          // Tự động đưa vào bản đồ/luồng cảnh báo nếu liên quan thiên tai, giao thông hoặc điện/nước
          if (
            bulletin.category === 'disaster' ||
            bulletin.category === 'traffic' ||
            bulletin.category === 'utility'
          ) {
            const firstWardCode = bulletin.wardIds.find((c) => WARD_BY_CODE[c]);
            const ward = firstWardCode ? WARD_BY_CODE[firstWardCode] : WARD_BY_CODE['DN-TB'];
            await this.alertsAndWards.upsertExternalAlert({
              title: bulletin.title,
              description: bulletin.cleanSummary,
              category: bulletin.category,
              severity: bulletin.severity,
              sourceType: 'official_rss',
              sourceLabel: feed.sourceName,
              sourceUrl: bulletin.sourceUrl,
              sourceUrlHash: `alert:${sourceUrlHash}`,
              wardIds: bulletin.wardIds,
              affectedRoads: bulletin.affectedRoads,
              geometryType: 'point',
              lat: ward?.centerLat ?? 10.9465,
              lng: ward?.centerLng ?? 106.8243,
              isVerifiedOfficial: true,
              expiresAt: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
            });
            alertsCreated += 1;
          }
        }
      } catch (err) {
        feedErrors.push(`${feed.sourceName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.lastRssSyncAtMs = Date.now();
    return { scannedCount, savedCount, alertsCreated, feedErrors };
  }

  /**
   * Phục vụ Tóm tắt AI 24h từ Cache DB (TTL 2 giờ):
   * Người dân đọc qua API này không bao giờ gọi thẳng làm cạn Gemini KeyPool.
   */
  async getDailyDigest(): Promise<DailyDigestItem> {
    const now = new Date();
    const todayKey = `${now.toISOString().slice(0, 10)}:v2`;

    if (mongoose.connection.readyState === 1) {
      const hit = (await DailyDigest.findOne({
        dateKey: todayKey,
        expiresAt: { $gt: now },
      })
        .sort({ generatedAt: -1 })
        .lean()) as Record<string, unknown> | null;
      if (hit) {
        return {
          id: String(hit.id),
          dateKey: String(hit.dateKey),
          bullets: Array.isArray(hit.bullets) ? hit.bullets.map(String) : [],
          highlightsCount: (hit.highlightsCount as DailyDigestItem['highlightsCount']) ?? {
            alerts: 0,
            bulletins: 0,
            openIncidents: 0,
          },
          generatedAt:
            hit.generatedAt instanceof Date ? hit.generatedAt.toISOString() : String(hit.generatedAt),
          expiresAt: hit.expiresAt instanceof Date ? hit.expiresAt.toISOString() : String(hit.expiresAt),
          cached: true,
          model: typeof hit.model === 'string' ? hit.model : undefined,
        };
      }
    } else {
      try {
        if (fs.existsSync(this.fallbackDigestFile)) {
          const parsed = JSON.parse(fs.readFileSync(this.fallbackDigestFile, 'utf8')) as DailyDigestItem;
          if (parsed.dateKey === todayKey && Date.parse(parsed.expiresAt) > Date.now()) {
            return { ...parsed, cached: true };
          }
        }
      } catch {
        // Bỏ qua cache lỗi
      }
    }

    if (this.digestInFlight) {
      return this.digestInFlight;
    }

    this.digestInFlight = (async (): Promise<DailyDigestItem> => {
      const [activeAlerts, bulletins, openReports] = await Promise.all([
        this.alertsAndWards.listAlerts({ status: 'active', limit: 25 }),
        this.alertsAndWards.listBulletins({ limit: 15 }),
        this.repos.reports.list({ statuses: ['received', 'verifying', 'processing'], limit: 300, projection: 'stats' }),
      ]);

      const wardCounts = new Map<string, number>();
      for (const r of openReports) {
        wardCounts.set(r.wardCode, (wardCounts.get(r.wardCode) ?? 0) + 1);
      }
      const hotWardNames = Array.from(wardCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([code]) => DONG_NAI_WARDS.find((w) => w.wardCode === code)?.name ?? code);

      const { bullets, model } = await this.gemini.generateDailyDigest({
        dateKey: todayKey,
        activeAlerts,
        bulletins,
        openIncidentsCount: openReports.length,
        hotWardNames,
      });

      const genAt = new Date();
      const expAt = new Date(genAt.getTime() + DIGEST_TTL_MS);
      const digest: DailyDigestItem = {
        id: newId('dgst'),
        dateKey: todayKey,
        bullets,
        highlightsCount: {
          alerts: activeAlerts.length,
          bulletins: bulletins.length,
          openIncidents: openReports.length,
        },
        generatedAt: genAt.toISOString(),
        expiresAt: expAt.toISOString(),
        cached: false,
        model,
      };

      if (mongoose.connection.readyState === 1) {
        await DailyDigest.create({
          ...digest,
          generatedAt: genAt,
          expiresAt: expAt,
        }).catch(() => undefined);
      } else {
        fs.mkdirSync(path.dirname(this.fallbackDigestFile), { recursive: true });
        fs.writeFileSync(this.fallbackDigestFile, JSON.stringify(digest), 'utf8');
      }

      return digest;
    })().finally(() => {
      this.digestInFlight = null;
    });

    return this.digestInFlight;
  }
}
