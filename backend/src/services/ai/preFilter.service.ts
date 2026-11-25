import { performance } from 'node:perf_hooks';
import { LRUCache } from 'lru-cache';
import { env } from '../../config/env';
import type { ReportRepository } from '../../repositories/types';
import { hammingDistance, isValidHash } from '../../shared/dhash';
import { haversineMeters } from '../../shared/geo';
import type { VisionResult } from '../../shared/types';
import { tooMany } from '../../utils/errors';
import { MAX_IMAGE_BYTES, validateAndInspectImage, type ValidatedImageInfo } from '../media.service';

export interface Stage0ExifInput {
  capturedAt?: string | null;
  cameraMake?: string | null;
  cameraModel?: string | null;
  software?: string | null;
  gps?: { lat: number; lng: number; inBounds?: boolean } | null;
}

export interface Stage0EdgeInput {
  blurScore: number;
  brightness: number;
  flatRatio: number;
  aspect: number;
}

export interface Stage0RequestContext {
  rateLimitKey: string;
  trustScore?: number;
  imageBuffer?: Buffer;
  allowTinyTestStub?: boolean;
  dHash: string;
  hintText?: string;
  lat?: number;
  lng?: number;
  exif?: Stage0ExifInput | null;
  edge?: Stage0EdgeInput;
  reportsRepo?: ReportRepository;
  skipDedup?: boolean;
  skipCache?: boolean;
}

export type Stage0Result =
  | {
      outcome: 'CACHE_HIT';
      cachedResult: VisionResult;
      stage0Ms: number;
    }
  | {
      outcome: 'DUPLICATE_FOUND';
      duplicateIncidentId: string;
      duplicateIncidentCode: string;
      distanceMeters: number | null;
      hammingDistance: number | null;
      stage0Ms: number;
    }
  | {
      outcome: 'REJECT_TEXT';
      reasonCode: string;
      citizenFeedback: string;
      stage0Ms: number;
    }
  | {
      outcome: 'PROCEED';
      sanitizedWrappedText: string;
      cleanHintText: string;
      promptInjectionDetected: boolean;
      forensicSignals: string[];
      inspectedImage: ValidatedImageInfo | null;
      stage0Ms: number;
    };

interface RateBucket {
  timestamps: number[];
  rejections: number[];
  cooldownUntil: number;
}

const AI_EDITING_SOFTWARE_RE =
  /(photoshop|midjourney|dall-e|stable\s*diffusion|comfyui|invokeai|leonardo|firefly|bing\s*image|snipping|screenshot|lightshot|greenshot|sharex|gyazo|flameshot|screencapture|canva|figma|gimp|picsart|remini|meitu)/i;

const PROMO_URL_RE =
  /(?:https?:\/\/|www\.|bit\.ly\/|tinyurl\.com\/|t\.me\/|zalo\.me\/|facebook\.com\/|tiktok\.com\/|shopee\.vn\/)/i;

const PROFANITY_RE =
  /(?:\bđịt\b|\bđụ\b|\blồn\b|\bcặc\b|\bđéo\b|\bđm\b|\bvcl\b|\bvãi lồn\b|\bfuck\b|\bshit\b|\bbitch\b|\bmotherfucker\b)/i;

const REPEATED_CHAR_RE = /(.)\1{7,}/u;

const STAGE0_INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above)\s+(?:instructions|rules|prompts?)/gi,
  /(?:reveal|show|print|repeat|leak|tell\s+me)\b.{0,40}(?:system\s*prompt|instructions|api[ _-]?key|secret|env)/gi,
  /(?:bỏ qua|quên|phớt lờ).{0,30}(?:hướng dẫn|chỉ dẫn|quy tắc|luật|lệnh)/gi,
  /(?:tiết lộ|cho\s+(?:tôi\s+)?xem|in\s+ra|lặp\s+lại|đọc\s+lại).{0,35}(?:prompt|chỉ dẫn hệ thống|system|api[ _-]?key|khóa api|mật khẩu|biến môi trường)/gi,
  /\b(?:jailbreak|DAN\s*mode|developer\s*mode|do\s+anything\s+now|AUTO_APPROVE|authenticity_score\s*[:=]\s*100)\b/gi,
  /(?:you\s+are\s+now|bây\s+giờ\s+bạn\s+là|từ\s+giờ\s+bạn\s+là)\b/gi,
  /<\/?\s*untrusted_user_input\s*>/gi,
];

/** Kiểm tra ký tự vô nghĩa (entropy thấp hoặc spam ký tự lặp). */
export function evaluateTextAntiSpam(rawText: string): { ok: true } | { ok: false; code: string; feedback: string } {
  const trimmed = rawText.trim();
  if (!trimmed) return { ok: true };

  if (PROMO_URL_RE.test(trimmed)) {
    return {
      ok: false,
      code: 'spam_promotional_url',
      feedback: 'Nội dung phản ánh không được chứa liên kết quảng cáo hoặc đường dẫn ngoài hệ thống.',
    };
  }
  if (PROFANITY_RE.test(trimmed)) {
    return {
      ok: false,
      code: 'spam_profanity',
      feedback: 'Vui lòng sử dụng ngôn từ lịch sự, đúng chuẩn mực khi gửi phản ánh công cộng.',
    };
  }
  if (REPEATED_CHAR_RE.test(trimmed)) {
    return {
      ok: false,
      code: 'spam_gibberish_repeat',
      feedback: 'Nội dung mô tả chứa chuỗi ký tự lặp bất thường. Vui lòng mô tả rõ tình trạng sự cố thực tế.',
    };
  }
  const compact = trimmed.replace(/\s+/g, '');
  if (compact.length >= 12) {
    const uniqueChars = new Set(compact.toLowerCase()).size;
    const alphaNumCount = (compact.match(/[\p{L}\p{N}]/gu) ?? []).length;
    if (uniqueChars <= 3 || alphaNumCount / compact.length < 0.35) {
      return {
        ok: false,
        code: 'spam_low_entropy_gibberish',
        feedback: 'Nội dung mô tả chưa có ý nghĩa rõ ràng. Vui lòng nhập mô tả ngắn gọn về sự cố.',
      };
    }
  }
  return { ok: true };
}

/** Làm sạch, vô hiệu hóa prompt-injection và bọc an toàn trong `<untrusted_user_input>`. */
export function sanitizeAndWrapUntrustedInput(rawText: string, max = 500): {
  cleanText: string;
  wrappedText: string;
  injectionDetected: boolean;
} {
  // eslint-disable-next-line no-control-regex
  let text = rawText.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  let injectionDetected = false;
  for (const pat of STAGE0_INJECTION_PATTERNS) {
    pat.lastIndex = 0;
    if (pat.test(text)) {
      injectionDetected = true;
      pat.lastIndex = 0;
      text = text.replace(pat, '[filtered]');
    }
  }
  const safeXmlText = text.replace(/</g, '[').replace(/>/g, ']').slice(0, max);
  return {
    cleanText: safeXmlText,
    wrappedText: safeXmlText ? `<untrusted_user_input>${safeXmlText}</untrusted_user_input>` : '',
    injectionDetected,
  };
}

export class Stage0PreFilterService {
  // Sliding-window rate limiter (tối đa 5000 khóa trong 1 giờ để bảo vệ RAM 512MB)
  private readonly rateBuckets = new LRUCache<string, RateBucket>({
    max: 5000,
    ttl: 60 * 60 * 1000,
  });

  // Cache kết quả Stage 1 theo dHash (tối đa 200 mục, TTL 15 phút)
  private readonly aiResultCache = new LRUCache<string, VisionResult>({
    max: 200,
    ttl: 15 * 60 * 1000,
  });

  resetForTests(): void {
    this.rateBuckets.clear();
    this.aiResultCache.clear();
  }

  getCachedVision(cacheKey: string): VisionResult | undefined {
    return this.aiResultCache.get(cacheKey);
  }

  setCachedVision(cacheKey: string, val: VisionResult): void {
    this.aiResultCache.set(cacheKey, val);
  }

  checkSlidingWindowRateLimit(key: string, trustScore = 50): void {
    const now = Date.now();
    const bucket = this.rateBuckets.get(key) ?? { timestamps: [], rejections: [], cooldownUntil: 0 };

    if (bucket.cooldownUntil > now) {
      const waitSec = Math.max(1, Math.ceil((bucket.cooldownUntil - now) / 1000));
      throw tooMany(
        `Hệ thống tạm giới hạn thao tác do phát hiện nhiều ảnh/nội dung chưa hợp lệ liên tiếp. Vui lòng thử lại sau ${waitSec} giây.`,
        'progressive_cooldown',
      );
    }

    const windowMs = 60 * 60 * 1000;
    bucket.timestamps = bucket.timestamps.filter((ts) => now - ts < windowMs);
    bucket.rejections = bucket.rejections.filter((ts) => now - ts < 15 * 60 * 1000);

    // Người dùng bị giám sát (trustScore < 25) bị siết giới hạn chặt hơn
    const maxPerHour = trustScore < 25 ? Math.max(3, Math.floor(env.aiVisionPerHour / 2)) : env.aiVisionPerHour * 2;
    if (bucket.timestamps.length >= maxPerHour) {
      throw tooMany(
        `Bạn đã vượt quá giới hạn phân tích (${maxPerHour} lượt/giờ). Vui lòng thử lại sau.`,
        'stage0_rate_limited',
      );
    }
    bucket.timestamps.push(now);
    this.rateBuckets.set(key, bucket);
  }

  recordRejection(key: string): void {
    const now = Date.now();
    const bucket = this.rateBuckets.get(key) ?? { timestamps: [], rejections: [], cooldownUntil: 0 };
    bucket.rejections = bucket.rejections.filter((ts) => now - ts < 15 * 60 * 1000);
    bucket.rejections.push(now);
    if (bucket.rejections.length >= 2) {
      const steps = [60_000, 180_000, 600_000];
      const idx = Math.min(steps.length - 1, bucket.rejections.length - 2);
      bucket.cooldownUntil = now + steps[idx];
    }
    this.rateBuckets.set(key, bucket);
  }

  async run(ctx: Stage0RequestContext): Promise<Stage0Result> {
    const t0 = performance.now();

    // 1. Sliding-window rate limit & progressive cooldown
    this.checkSlidingWindowRateLimit(ctx.rateLimitKey, ctx.trustScore ?? 50);

    // 2. Text Anti-Spam / Profanity / Gibberish / Prompt-Injection Sanitizer
    const rawHint = ctx.hintText ?? '';
    const textCheck = evaluateTextAntiSpam(rawHint);
    if (!textCheck.ok) {
      this.recordRejection(ctx.rateLimitKey);
      return {
        outcome: 'REJECT_TEXT',
        reasonCode: textCheck.code,
        citizenFeedback: textCheck.feedback,
        stage0Ms: Math.round((performance.now() - t0) * 10) / 10,
      };
    }

    const { cleanText, wrappedText, injectionDetected } = sanitizeAndWrapUntrustedInput(rawHint);
    const forensicSignals: string[] = [];

    if (ctx.exif?.software && AI_EDITING_SOFTWARE_RE.test(ctx.exif.software)) {
      forensicSignals.push(`exif_editing_or_ai_software:${ctx.exif.software.slice(0, 40)}`);
    }
    if (ctx.edge) {
      if (ctx.edge.flatRatio > 0.62) forensicSignals.push('high_flat_ui_ratio');
      if (ctx.edge.blurScore < 20) forensicSignals.push('severe_blur');
      if (ctx.edge.brightness < 18 || ctx.edge.brightness > 245) forensicSignals.push('extreme_exposure');
    }
    if (injectionDetected) {
      forensicSignals.push('prompt_injection_attempted');
    }

    // 3. Fast Buffer Guard (<1ms): đảm bảo đúng giới hạn trước khi tra trùng / cache
    const hasBuf = Boolean(ctx.imageBuffer && ctx.imageBuffer.byteLength > 0);
    if (hasBuf && (ctx.imageBuffer!.byteLength < 16 || ctx.imageBuffer!.byteLength > MAX_IMAGE_BYTES)) {
      this.recordRejection(ctx.rateLimitKey);
      await validateAndInspectImage(ctx.imageBuffer!, { allowTinyTestStub: ctx.allowTinyTestStub });
    }

    // 4. Instant Geo (48h, <= DUPLICATE_RADIUS_METERS) + Perceptual dHash (<= DHASH_HAMMING_THRESHOLD) Deduplication
    if (!ctx.skipDedup && ctx.reportsRepo && isValidHash(ctx.dHash)) {
      const since48h = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      const dupRadius = env.duplicateRadiusMeters;
      const dHashThreshold = env.dHashHammingThreshold;

      const nearbyCandidates =
        typeof ctx.lat === 'number' && typeof ctx.lng === 'number'
          ? await ctx.reportsRepo
              .findNearby({ lat: ctx.lat, lng: ctx.lng, radiusM: dupRadius, sinceIso: since48h, projection: 'dedup' })
              .catch(() => [])
          : [];
      const recentCandidates = await ctx.reportsRepo.findSince(since48h, 'dedup').catch(() => []);

      const seen = new Set<string>();
      for (const c of [...nearbyCandidates, ...recentCandidates]) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        if (c.status === 'resolved' || c.status === 'rejected' || c.status === 'quarantined') continue;
        if (c.createdAt < since48h) continue;

        const minHd = (c.photos ?? []).reduce((m, p) => Math.min(m, hammingDistance(ctx.dHash, p.dHash)), 64);
        const distM =
          typeof ctx.lat === 'number' && typeof ctx.lng === 'number'
            ? haversineMeters(ctx.lat, ctx.lng, c.lat, c.lng)
            : null;

        const isHashMatch = minHd <= dHashThreshold;
        const isGeoMatch = distM !== null && distM <= dupRadius && minHd <= dHashThreshold + 4;

        if (isHashMatch || isGeoMatch) {
          return {
            outcome: 'DUPLICATE_FOUND',
            duplicateIncidentId: c.id,
            duplicateIncidentCode: c.code,
            distanceMeters: distM !== null ? Math.round(distM) : null,
            hammingDistance: minHd,
            stage0Ms: Math.round((performance.now() - t0) * 10) / 10,
          };
        }
      }
    }

    // 5. Bounded AI Result Cache (by dHash, TTL 15 min, max 200) -> <10ms on identical clean retries
    if (!ctx.skipCache && isValidHash(ctx.dHash) && !injectionDetected && forensicSignals.length === 0) {
      const hit = this.aiResultCache.get(ctx.dHash);
      if (hit) {
        return {
          outcome: 'CACHE_HIT',
          cachedResult: { ...hit, cached: true },
          stage0Ms: Math.round((performance.now() - t0) * 10) / 10,
        };
      }
    }

    // 6. Image Quality & EXIF Forensics Check (Sharp decode, >=200x200px, non-solid frame, EXIF risk signals)
    let inspectedImage: ValidatedImageInfo | null = null;
    if (hasBuf) {
      try {
        inspectedImage = await validateAndInspectImage(ctx.imageBuffer!, {
          allowTinyTestStub: ctx.allowTinyTestStub,
        });
      } catch (err) {
        this.recordRejection(ctx.rateLimitKey);
        throw err;
      }

      const sw = ctx.exif?.software || inspectedImage.exif.software;
      if (sw && AI_EDITING_SOFTWARE_RE.test(sw) && !forensicSignals.some((s) => s.startsWith('exif_editing_or_ai_software:'))) {
        forensicSignals.push(`exif_editing_or_ai_software:${sw.slice(0, 40)}`);
      }

      const exifLat = ctx.exif?.gps?.lat ?? inspectedImage.exif.gpsLat;
      const exifLng = ctx.exif?.gps?.lng ?? inspectedImage.exif.gpsLng;
      if (
        typeof exifLat === 'number' &&
        typeof exifLng === 'number' &&
        typeof ctx.lat === 'number' &&
        typeof ctx.lng === 'number'
      ) {
        const distM = haversineMeters(exifLat, exifLng, ctx.lat, ctx.lng);
        if (distM > 5000) {
          forensicSignals.push(`exif_gps_deviation_${(distM / 1000).toFixed(1)}km`);
        }
      }
    }

    return {
      outcome: 'PROCEED',
      sanitizedWrappedText: wrappedText,
      cleanHintText: cleanText,
      promptInjectionDetected: injectionDetected,
      forensicSignals,
      inspectedImage,
      stage0Ms: Math.round((performance.now() - t0) * 10) / 10,
    };
  }
}

export const stage0PreFilter = new Stage0PreFilterService();
