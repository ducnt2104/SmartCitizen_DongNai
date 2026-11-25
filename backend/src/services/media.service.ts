import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LRUCache } from 'lru-cache';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { env } from '../config/env';
import { MediaAsset } from '../models/Media';
import { normalizeCoordinates } from '../shared/coordinates';
import { badRequest } from '../utils/errors';

// Bảo vệ ngưỡng RAM 512MB trên Render Free Tier: tắt libvips internal cache & giới hạn luồng
sharp.cache(false);
sharp.concurrency(2);

export const MIN_IMAGE_EDGE_PX = 200;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DISPLAY_MAX_EDGE = 1280;
const THUMB_MAX_EDGE = 320;

export interface ParsedExifMetadata {
  software: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  capturedAt: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
}

export interface ValidatedImageInfo {
  format: string;
  width: number;
  height: number;
  isTinyStub: boolean;
  isSolidBlank: boolean;
  channelStdevMean: number;
  exif: ParsedExifMetadata;
  normalizedBuffer: Buffer;
}

export interface StoredMediaResult {
  mediaId: string;
  url: string;
  thumbnailUrl: string;
  width: number;
  height: number;
  displayBytes: number;
  thumbnailBytes: number;
}

const mediaBinaryCache = new LRUCache<string, Buffer>({
  max: 80,
  maxSize: 10 * 1024 * 1024, // Giới hạn tối đa 10MB RAM cho media cache
  sizeCalculation: (buf) => Math.max(1, buf.byteLength),
  ttl: 10 * 60 * 1000,
});

function readAscii(buf: Buffer, start: number, count: number): string {
  const end = Math.min(buf.length, start + count);
  let s = '';
  for (let i = start; i < end; i++) {
    const b = buf[i];
    if (b === 0) break;
    if (b >= 32 && b <= 126) s += String.fromCharCode(b);
  }
  return s.trim();
}

function readTiffString(buf: Buffer, tiffStart: number, entryOffset: number, little: boolean): string | null {
  if (entryOffset + 12 > buf.length) return null;
  const type = little ? buf.readUInt16LE(entryOffset + 2) : buf.readUInt16BE(entryOffset + 2);
  const count = little ? buf.readUInt32LE(entryOffset + 4) : buf.readUInt32BE(entryOffset + 4);
  if (type !== 2 || count === 0 || count > 256) return null;
  const valOff =
    count <= 4
      ? entryOffset + 8
      : tiffStart + (little ? buf.readUInt32LE(entryOffset + 8) : buf.readUInt32BE(entryOffset + 8));
  if (valOff < 0 || valOff >= buf.length) return null;
  const s = readAscii(buf, valOff, count);
  return s || null;
}

function parseExifTimestamp(raw: string | null): string | null {
  if (!raw) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const ts = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

export function parseExifFromSharpBuffer(exifBuf: Buffer | undefined, rawImageBuf?: Buffer): ParsedExifMetadata {
  const empty: ParsedExifMetadata = {
    software: null,
    cameraMake: null,
    cameraModel: null,
    capturedAt: null,
    gpsLat: null,
    gpsLng: null,
  };

  try {
    let tiffBuf: Buffer | null = null;
    let tiffStart = 0;

    if (exifBuf && exifBuf.length >= 12) {
      if (exifBuf.toString('ascii', 0, 4) === 'Exif') {
        tiffBuf = exifBuf;
        tiffStart = 6;
      } else {
        const bo = exifBuf.readUInt16BE(0);
        if (bo === 0x4949 || bo === 0x4d4d) {
          tiffBuf = exifBuf;
          tiffStart = 0;
        }
      }
    }

    if (tiffBuf && tiffStart + 8 <= tiffBuf.length) {
      const bo = tiffBuf.readUInt16BE(tiffStart);
      if (bo === 0x4949 || bo === 0x4d4d) {
        const little = bo === 0x4949;
        const firstIfd = little ? tiffBuf.readUInt32LE(tiffStart + 4) : tiffBuf.readUInt32BE(tiffStart + 4);
        const ifd0 = tiffStart + firstIfd;
        if (ifd0 + 2 <= tiffBuf.length) {
          const entries = little ? tiffBuf.readUInt16LE(ifd0) : tiffBuf.readUInt16BE(ifd0);
          let gpsIfdOffset = 0;
          let exifIfdOffset = 0;
          let dtRaw: string | null = null;

          for (let i = 0; i < entries; i++) {
            const eOff = ifd0 + 2 + i * 12;
            if (eOff + 12 > tiffBuf.length) break;
            const tag = little ? tiffBuf.readUInt16LE(eOff) : tiffBuf.readUInt16BE(eOff);
            if (tag === 0x010f) empty.cameraMake = readTiffString(tiffBuf, tiffStart, eOff, little);
            else if (tag === 0x0110) empty.cameraModel = readTiffString(tiffBuf, tiffStart, eOff, little);
            else if (tag === 0x0131) empty.software = readTiffString(tiffBuf, tiffStart, eOff, little);
            else if (tag === 0x0132) dtRaw = readTiffString(tiffBuf, tiffStart, eOff, little);
            else if (tag === 0x8769) {
              exifIfdOffset = little ? tiffBuf.readUInt32LE(eOff + 8) : tiffBuf.readUInt32BE(eOff + 8);
            } else if (tag === 0x8825) {
              gpsIfdOffset = little ? tiffBuf.readUInt32LE(eOff + 8) : tiffBuf.readUInt32BE(eOff + 8);
            }
          }

          if (exifIfdOffset) {
            const exifStart = tiffStart + exifIfdOffset;
            if (exifStart + 2 <= tiffBuf.length) {
              const cnt = little ? tiffBuf.readUInt16LE(exifStart) : tiffBuf.readUInt16BE(exifStart);
              for (let i = 0; i < cnt; i++) {
                const eOff = exifStart + 2 + i * 12;
                if (eOff + 12 > tiffBuf.length) break;
                const tag = little ? tiffBuf.readUInt16LE(eOff) : tiffBuf.readUInt16BE(eOff);
                if (tag === 0x9003 || tag === 0x9004) {
                  const ts = parseExifTimestamp(readTiffString(tiffBuf, tiffStart, eOff, little));
                  if (ts) {
                    empty.capturedAt = ts;
                    break;
                  }
                }
              }
            }
          }
          if (!empty.capturedAt) empty.capturedAt = parseExifTimestamp(dtRaw);

          if (gpsIfdOffset) {
            const gpsStart = tiffStart + gpsIfdOffset;
            if (gpsStart + 2 <= tiffBuf.length) {
              const gpsEntries = little ? tiffBuf.readUInt16LE(gpsStart) : tiffBuf.readUInt16BE(gpsStart);
              let latRef = '';
              let lngRef = '';
              let latVals: number[] | null = null;
              let lngVals: number[] | null = null;

              const readRationals = (valOff: number): number[] | null => {
                const p = tiffStart + valOff;
                if (p + 24 > tiffBuf!.length) return null;
                const out: number[] = [];
                for (let k = 0; k < 3; k++) {
                  const num = little ? tiffBuf!.readUInt32LE(p + k * 8) : tiffBuf!.readUInt32BE(p + k * 8);
                  const den = little ? tiffBuf!.readUInt32LE(p + k * 8 + 4) : tiffBuf!.readUInt32BE(p + k * 8 + 4);
                  if (!den) return null;
                  out.push(num / den);
                }
                return out;
              };

              for (let i = 0; i < gpsEntries; i++) {
                const eOff = gpsStart + 2 + i * 12;
                if (eOff + 12 > tiffBuf.length) break;
                const tag = little ? tiffBuf.readUInt16LE(eOff) : tiffBuf.readUInt16BE(eOff);
                if (tag === 1) latRef = String.fromCharCode(tiffBuf[eOff + 8]);
                else if (tag === 2) {
                  const v = little ? tiffBuf.readUInt32LE(eOff + 8) : tiffBuf.readUInt32BE(eOff + 8);
                  latVals = readRationals(v);
                } else if (tag === 3) lngRef = String.fromCharCode(tiffBuf[eOff + 8]);
                else if (tag === 4) {
                  const v = little ? tiffBuf.readUInt32LE(eOff + 8) : tiffBuf.readUInt32BE(eOff + 8);
                  lngVals = readRationals(v);
                }
              }

              if (latVals && lngVals) {
                let lat = latVals[0] + latVals[1] / 60 + latVals[2] / 3600;
                let lng = lngVals[0] + lngVals[1] / 60 + lngVals[2] / 3600;
                if (latRef === 'S') lat = -lat;
                if (lngRef === 'W') lng = -lng;
                const norm = normalizeCoordinates({ lat, lng }, { requireVietnam: false });
                if (norm.ok) {
                  empty.gpsLat = norm.lat;
                  empty.gpsLng = norm.lng;
                }
              }
            }
          }
        }
      }
    }

    if (!empty.software && rawImageBuf) {
      const head = rawImageBuf.subarray(0, Math.min(rawImageBuf.length, 32_768)).toString('latin1');
      const m = /(Adobe Photoshop[^;\r\n\0]{0,40}|Midjourney|Stable Diffusion|ComfyUI|DALL-E|Snipping Tool|Lightshot|Greenshot|ShareX|Canva|Figma|GIMP)/i.exec(head);
      if (m) empty.software = m[1].trim();
    }
  } catch {
    return empty;
  }

  return empty;
}

const ALLOWED_SHARP_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif', 'avif', 'gif', 'tiff']);

export async function validateAndInspectImage(
  buffer: Buffer,
  opts: { allowTinyTestStub?: boolean } = {},
): Promise<ValidatedImageInfo> {
  if (!Buffer.isBuffer(buffer) || buffer.byteLength < 16) {
    throw badRequest('Tệp ảnh trống hoặc bị hỏng.', 'corrupted_image');
  }
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw badRequest('Dung lượng ảnh vượt quá giới hạn 5MB.', 'file_too_large');
  }

  let meta: sharp.Metadata;
  let stats: sharp.Stats;
  try {
    const instance = sharp(buffer, {
      failOn: opts.allowTinyTestStub ? 'none' : 'error',
      limitInputPixels: 40_000_000,
    });
    meta = await instance.metadata();
    if (!meta.format || !ALLOWED_SHARP_FORMATS.has(meta.format)) {
      throw badRequest('Định dạng tệp không phải ảnh hợp lệ (JPEG/PNG/WebP).', 'invalid_image_format');
    }
    stats = await instance.clone().stats();
  } catch (err) {
    if (err instanceof Error && 'status' in err) throw err;
    throw badRequest('Ảnh bị lỗi giải mã hoặc không đúng định dạng ảnh hợp lệ.', 'corrupted_image');
  }

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const isTinyStub = Boolean(opts.allowTinyTestStub && width <= 2 && height <= 2 && width > 0 && height > 0);

  if (!isTinyStub && (width < MIN_IMAGE_EDGE_PX || height < MIN_IMAGE_EDGE_PX)) {
    throw badRequest(
      `Kích thước ảnh quá nhỏ (${width}×${height}px). Yêu cầu tối thiểu ${MIN_IMAGE_EDGE_PX}×${MIN_IMAGE_EDGE_PX}px.`,
      'image_too_small',
    );
  }

  const stdevs = stats.channels.slice(0, 3).map((c) => c.stdev);
  const channelStdevMean = stdevs.length ? stdevs.reduce((a, b) => a + b, 0) / stdevs.length : 0;
  const isSolidBlank = !isTinyStub && stdevs.length > 0 && stdevs.every((s) => s < 2.0);

  if (isSolidBlank) {
    throw badRequest(
      'Ảnh bị đơn sắc, tối đen hoặc trống hoàn toàn. Vui lòng chụp lại hiện trường rõ nét.',
      'solid_blank_frame',
    );
  }

  const exif = parseExifFromSharpBuffer(meta.exif, buffer);
  return {
    format: meta.format,
    width,
    height,
    isTinyStub,
    isSolidBlank,
    channelStdevMean,
    exif,
    normalizedBuffer: buffer,
  };
}

function mediaDiskDir(): string {
  return path.join(env.dataDir, 'media');
}

function writeMediaDisk(mediaId: string, displayBuffer: Buffer, thumbnailBuffer: Buffer): void {
  try {
    const dir = mediaDiskDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${mediaId}_display.webp`), displayBuffer);
    fs.writeFileSync(path.join(dir, `${mediaId}_thumb.webp`), thumbnailBuffer);
  } catch (err) {
    console.warn('[media] Không ghi được bộ đệm đĩa cục bộ:', err instanceof Error ? err.message : err);
  }
}

function readMediaDisk(mediaId: string, variant: 'display' | 'thumb'): Buffer | null {
  try {
    const filePath = path.join(mediaDiskDir(), `${mediaId}_${variant}.webp`);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

export function isValidMediaId(id: string): boolean {
  return /^md_[a-zA-Z0-9_-]{8,64}$/.test(id);
}

export class MediaService {
  async computeDHashFromBuffer(buffer: Buffer): Promise<string> {
    const raw = await sharp(buffer, { failOn: 'none', limitInputPixels: 40_000_000 })
      .rotate()
      .grayscale()
      .resize(9, 8, { fit: 'fill' })
      .raw()
      .toBuffer();
    const nibbles: string[] = [];
    let acc = 0;
    let bits = 0;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        acc = (acc << 1) | (raw[y * 9 + x] > raw[y * 9 + x + 1] ? 1 : 0);
        bits += 1;
        if (bits === 4) {
          nibbles.push(acc.toString(16));
          acc = 0;
          bits = 0;
        }
      }
    }
    return nibbles.join('');
  }

  async storeIncidentImage(params: {
    buffer: Buffer;
    dHash: string;
    reportId?: string | null;
    precomputed?: ValidatedImageInfo;
  }): Promise<StoredMediaResult> {
    const mediaId = `md_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

    const baseSharp = sharp(params.buffer, { failOn: 'none', limitInputPixels: 40_000_000 }).rotate();
    const [displayOut, thumbOut] = await Promise.all([
      baseSharp
        .clone()
        .resize(DISPLAY_MAX_EDGE, DISPLAY_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80, effort: 4 })
        .toBuffer({ resolveWithObject: true }),
      baseSharp
        .clone()
        .resize(THUMB_MAX_EDGE, THUMB_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 72, effort: 4 })
        .toBuffer({ resolveWithObject: true }),
    ]);

    const displayBuffer = displayOut.data;
    const thumbnailBuffer = thumbOut.data;
    const width = displayOut.info.width || params.precomputed?.width || 1;
    const height = displayOut.info.height || params.precomputed?.height || 1;

    mediaBinaryCache.set(`${mediaId}:display`, displayBuffer);
    mediaBinaryCache.set(`${mediaId}:thumb`, thumbnailBuffer);

    if (mongoose.connection.readyState === 1) {
      await MediaAsset.create({
        id: mediaId,
        reportId: params.reportId ?? null,
        mimeType: 'image/webp',
        width,
        height,
        dHash: params.dHash,
        displayBuffer,
        thumbnailBuffer,
        displayBytes: displayBuffer.byteLength,
        thumbnailBytes: thumbnailBuffer.byteLength,
      });
    } else {
      writeMediaDisk(mediaId, displayBuffer, thumbnailBuffer);
    }

    return {
      mediaId,
      url: `/api/media/${mediaId}`,
      thumbnailUrl: `/api/media/${mediaId}?variant=thumb`,
      width,
      height,
      displayBytes: displayBuffer.byteLength,
      thumbnailBytes: thumbnailBuffer.byteLength,
    };
  }

  async getMediaBinary(
    mediaId: string,
    variant: 'display' | 'thumb' = 'display',
  ): Promise<{ buffer: Buffer; mimeType: 'image/webp'; etag: string } | null> {
    if (!isValidMediaId(mediaId)) return null;
    const cacheKey = `${mediaId}:${variant}`;
    const cached = mediaBinaryCache.get(cacheKey);
    if (cached) {
      return { buffer: cached, mimeType: 'image/webp', etag: `"${mediaId}-${variant}"` };
    }

    if (mongoose.connection.readyState === 1) {
      const field = variant === 'thumb' ? 'thumbnailBuffer' : 'displayBuffer';
      const doc = (await MediaAsset.findOne({ id: mediaId }).select(field).lean()) as
        | { displayBuffer?: Buffer | { buffer: Buffer }; thumbnailBuffer?: Buffer | { buffer: Buffer } }
        | null;
      const raw = variant === 'thumb' ? doc?.thumbnailBuffer : doc?.displayBuffer;
      if (raw) {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from((raw as { buffer: Uint8Array }).buffer);
        mediaBinaryCache.set(cacheKey, buf);
        return { buffer: buf, mimeType: 'image/webp', etag: `"${mediaId}-${variant}"` };
      }
    }

    const diskBuf = readMediaDisk(mediaId, variant);
    if (diskBuf) {
      mediaBinaryCache.set(cacheKey, diskBuf);
      return { buffer: diskBuf, mimeType: 'image/webp', etag: `"${mediaId}-${variant}"` };
    }
    return null;
  }

  async renderAiBufferFromStoredOrRaw(buffer: Buffer): Promise<Buffer> {
    return sharp(buffer, { failOn: 'none', limitInputPixels: 40_000_000 })
      .rotate()
      .resize(640, 640, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 72, effort: 3 })
      .toBuffer();
  }
}

export const mediaService = new MediaService();
