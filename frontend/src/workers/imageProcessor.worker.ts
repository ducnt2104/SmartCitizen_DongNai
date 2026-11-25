/**
 * Client Web Worker (`imageProcessor.worker.ts`) — xử lý ảnh 100% ngoài Main Thread (<150ms):
 *  1) Trích xuất EXIF nhẹ từ byte ảnh gốc (capturedAt, GPS, cameraMake, cameraModel, editing software tag)
 *  2) Nén song song 2 phiên bản WebP qua createImageBitmap + OffscreenCanvas:
 *     - aiBuffer: cạnh dài <= 640px, WebP quality 0.72 (~25-55KB) cho AI Vision siêu tốc
 *     - displayBuffer: cạnh dài <= 1280px, WebP quality 0.80 (~80-180KB) cho hiển thị sắc nét
 *  3) Tính 64-bit dHash (9x8 grayscale) + chỉ số chất lượng ảnh (blurScore, brightness, flatRatio, aspect)
 *  4) Trả về qua Transferable ArrayBuffer (zero-copy)
 */

import { normalizeCoordinates } from '@shared/coordinates';
import { inDongNaiBBox } from '@shared/geo';
import {
  computeColorHistogram24,
  computeDHashFromGrayRegion,
  computeEdgeStatsAndScreenshot,
  computePHashFromGray,
  computeSubGridHashesFromGray,
  rgbaToGray,
} from '../lib/localCvMath';

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}
const ctx: WorkerScope | null =
  typeof self !== 'undefined' && typeof (self as { document?: unknown }).document === 'undefined'
    ? (self as unknown as WorkerScope)
    : null;

export interface ExifGpsCoords {
  lat: number;
  lng: number;
  inBounds: boolean;
}

export interface ExtractedExifMetadata {
  capturedAt: string | null;
  gps: ExifGpsCoords | null;
  cameraMake: string | null;
  cameraModel: string | null;
  software: string | null;
}

export interface EdgeStatsMsg {
  blurScore: number;
  brightness: number;
  flatRatio: number;
  aspect: number;
  sharpEdgeDensity?: number;
  likelyScreenshot?: boolean;
  screenshotConfidence?: number;
}

export type ImageProcessorRequest =
  | { id: number; type: 'process'; buffer: ArrayBuffer; mimeType: string; size: number }
  | { id: number; type: 'process_blob'; blob: Blob };

export type ImageProcessorResponse =
  | {
      id: number;
      type: 'processed';
      aiBuffer: ArrayBuffer;
      aiMimeType: string;
      aiSha256: string;
      displayBuffer: ArrayBuffer;
      displayMimeType: string;
      dHash: string;
      pHash: string;
      subGridHashes: string[];
      colorHistogram: number[];
      width: number;
      height: number;
      originalBytes: number;
      aiBytes: number;
      displayBytes: number;
      stats: EdgeStatsMsg;
      exif: ExtractedExifMetadata;
      timings: { totalMs: number; hashMs: number };
    }
  | {
      id: number;
      type: 'error';
      message: string;
      unsupported?: boolean;
    };

const AI_MAX_EDGE = 1024;
const AI_QUALITY = 0.80;
const AI_TARGET_MAX_BYTES = 220 * 1024;
const DISPLAY_MAX_EDGE = 1280;
const DISPLAY_QUALITY = 0.82;

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return '';
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function readAsciiString(view: DataView, start: number, len: number): string {
  const end = Math.min(view.byteLength, start + len);
  let out = '';
  for (let i = start; i < end; i++) {
    const ch = view.getUint8(i);
    if (ch === 0) break;
    if (ch >= 32 && ch <= 126) out += String.fromCharCode(ch);
  }
  return out.trim();
}

function readTagString(
  view: DataView,
  tiffStart: number,
  entryOffset: number,
  little: boolean,
): string | null {
  const type = view.getUint16(entryOffset + 2, little);
  const count = view.getUint32(entryOffset + 4, little);
  if (type !== 2 || count === 0 || count > 256) return null;
  const valOffset = count <= 4 ? entryOffset + 8 : tiffStart + view.getUint32(entryOffset + 8, little);
  if (valOffset < 0 || valOffset >= view.byteLength) return null;
  const s = readAsciiString(view, valOffset, count);
  return s || null;
}

function parseExifDateTime(raw: string | null): string | null {
  if (!raw) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

function extractPngSoftware(buf: ArrayBuffer): string | null {
  try {
    const view = new DataView(buf);
    if (view.byteLength < 32) return null;
    if (view.getUint32(0, false) !== 0x89504e47) return null;
    let offset = 8;
    const chunks: string[] = [];
    while (offset + 12 <= view.byteLength && offset < 65536) {
      const len = view.getUint32(offset, false);
      const type = readAsciiString(view, offset + 4, 4);
      if (type === 'IDAT' || type === 'IEND') break;
      if ((type === 'tEXt' || type === 'iTXt' || type === 'zTXt') && len > 0 && len <= 4096 && offset + 8 + len <= view.byteLength) {
        const text = readAsciiString(view, offset + 8, len);
        if (/(software|photoshop|midjourney|dall-?e|stable\s*diffusion|firefly|c2pa|trainedalgorithmic|generative\s*ai|ai\s*generated|screenshot|snipping|canva|capcut|remini|figma|gimp|creator)/i.test(text)) {
          chunks.push(text);
        }
      }
      offset += 12 + len;
    }
    return chunks.length ? chunks.join(' | ').slice(0, 160) : null;
  } catch {
    return null;
  }
}

export function extractExifMetadata(buf: ArrayBuffer): ExtractedExifMetadata {
  const empty: ExtractedExifMetadata = {
    capturedAt: null,
    gps: null,
    cameraMake: null,
    cameraModel: null,
    software: null,
  };
  try {
    // Quét nhanh chữ ký XMP / C2PA / JUMBF AI trong 48KB đầu mọi định dạng ảnh (JPEG/PNG/WebP)
    let rawHeaderSw: string | null = null;
    try {
      const scanLen = Math.min(buf.byteLength, 48_000);
      const bytes = new Uint8Array(buf, 0, scanLen);
      let ascii = '';
      for (let i = 0; i < bytes.length; i++) {
        const c = bytes[i];
        ascii += c >= 32 && c <= 126 ? String.fromCharCode(c) : ' ';
      }
      const m = ascii.match(
        /(c2pa\.claim|trainedalgorithmicmedia|c2pa|midjourney|dall[-\s·]?e|stable\s*diffusion|adobe\s*firefly|photoshop|canva|capcut|remini|generative\s*ai)/i,
      );
      if (m) rawHeaderSw = m[1];
    } catch {
      /* ignore binary scan err */
    }

    const view = new DataView(buf);
    if (view.byteLength < 12) return rawHeaderSw ? { ...empty, software: rawHeaderSw } : empty;
    if (view.getUint16(0, false) !== 0xffd8) {
      const pngSw = extractPngSoftware(buf) ?? rawHeaderSw;
      return pngSw ? { ...empty, software: pngSw } : empty;
    }

    let offset = 2;
    while (offset + 4 < view.byteLength) {
      const marker = view.getUint16(offset, false);
      offset += 2;
      if (marker === 0xffda || marker === 0xffd9) break;
      const segLen = view.getUint16(offset, false);
      if (segLen < 2 || offset + segLen > view.byteLength) break;
      if (
        marker === 0xffe1 &&
        segLen >= 16 &&
        view.getUint32(offset + 2, false) === 0x45786966 &&
        view.getUint16(offset + 6, false) === 0x0000
      ) {
        const tiffStart = offset + 8;
        const byteOrder = view.getUint16(tiffStart, false);
        if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return empty;
        const little = byteOrder === 0x4949;
        const firstIfd = view.getUint32(tiffStart + 4, little);
        const ifd0 = tiffStart + firstIfd;
        if (ifd0 + 2 > view.byteLength) return empty;

        const entries = view.getUint16(ifd0, little);
        let gpsIfdOffset = 0;
        let exifIfdOffset = 0;
        let cameraMake: string | null = null;
        let cameraModel: string | null = null;
        let software: string | null = null;
        let dateTimeRaw: string | null = null;

        for (let i = 0; i < entries; i++) {
          const eOff = ifd0 + 2 + i * 12;
          if (eOff + 12 > view.byteLength) break;
          const tag = view.getUint16(eOff, little);
          if (tag === 0x010f) cameraMake = readTagString(view, tiffStart, eOff, little);
          else if (tag === 0x0110) cameraModel = readTagString(view, tiffStart, eOff, little);
          else if (tag === 0x0131) software = readTagString(view, tiffStart, eOff, little);
          else if (tag === 0x0132) dateTimeRaw = readTagString(view, tiffStart, eOff, little);
          else if (tag === 0x8769) exifIfdOffset = view.getUint32(eOff + 8, little);
          else if (tag === 0x8825) gpsIfdOffset = view.getUint32(eOff + 8, little);
        }

        let capturedAt: string | null = null;
        if (exifIfdOffset) {
          const exifStart = tiffStart + exifIfdOffset;
          if (exifStart + 2 <= view.byteLength) {
            const exifEntries = view.getUint16(exifStart, little);
            for (let i = 0; i < exifEntries; i++) {
              const eOff = exifStart + 2 + i * 12;
              if (eOff + 12 > view.byteLength) break;
              const tag = view.getUint16(eOff, little);
              if (tag === 0x9003 || tag === 0x9004) {
                const dt = parseExifDateTime(readTagString(view, tiffStart, eOff, little));
                if (dt) {
                  capturedAt = dt;
                  break;
                }
              }
            }
          }
        }
        if (!capturedAt) capturedAt = parseExifDateTime(dateTimeRaw);

        let gps: ExifGpsCoords | null = null;
        if (gpsIfdOffset) {
          const gpsStart = tiffStart + gpsIfdOffset;
          if (gpsStart + 2 <= view.byteLength) {
            const gpsEntries = view.getUint16(gpsStart, little);
            let latRef = '';
            let lngRef = '';
            let latVals: number[] | null = null;
            let lngVals: number[] | null = null;

            const readRationals = (valOff: number): number[] | null => {
              const p = tiffStart + valOff;
              if (p + 24 > view.byteLength) return null;
              const out: number[] = [];
              for (let k = 0; k < 3; k++) {
                const num = view.getUint32(p + k * 8, little);
                const den = view.getUint32(p + k * 8 + 4, little);
                if (!den) return null;
                out.push(num / den);
              }
              return out;
            };

            for (let i = 0; i < gpsEntries; i++) {
              const eOff = gpsStart + 2 + i * 12;
              if (eOff + 12 > view.byteLength) break;
              const tag = view.getUint16(eOff, little);
              if (tag === 1) latRef = String.fromCharCode(view.getUint8(eOff + 8));
              else if (tag === 2) latVals = readRationals(view.getUint32(eOff + 8, little));
              else if (tag === 3) lngRef = String.fromCharCode(view.getUint8(eOff + 8));
              else if (tag === 4) lngVals = readRationals(view.getUint32(eOff + 8, little));
            }

            if (latVals && lngVals) {
              let lat = latVals[0] + latVals[1] / 60 + latVals[2] / 3600;
              let lng = lngVals[0] + lngVals[1] / 60 + lngVals[2] / 3600;
              if (latRef.toUpperCase() === 'S') lat = -lat;
              if (lngRef.toUpperCase() === 'W') lng = -lng;
              const norm = normalizeCoordinates({ lat, lng }, { requireVietnam: false });
              if (norm.ok) {
                gps = { lat: norm.lat, lng: norm.lng, inBounds: inDongNaiBBox(norm.lat, norm.lng) };
              }
            }
          }
        }

        return { capturedAt, gps, cameraMake, cameraModel, software };
      }
      offset += segLen;
    }
  } catch {
    return empty;
  }
  return empty;
}

function extractWorkerCvFeatures(
  source: ImageBitmap | OffscreenCanvas,
  aspect: number,
  hasCameraExif: boolean,
): {
  dHash: string;
  pHash: string;
  subGridHashes: string[];
  colorHistogram: number[];
  stats: EdgeStatsMsg;
} {
  const W = 128;
  const H = Math.max(32, Math.min(256, Math.round(W / Math.max(0.25, aspect))));
  const c = new OffscreenCanvas(W, H);
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('Không tạo được ngữ cảnh 2D trong Worker');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, 0, 0, W, H);
  const { data } = g.getImageData(0, 0, W, H);
  const gray = rgbaToGray(data, W, H);

  return {
    dHash: computeDHashFromGrayRegion(gray, W, 0, 0, W, H),
    pHash: computePHashFromGray(gray, W, H),
    subGridHashes: computeSubGridHashesFromGray(gray, W, H),
    colorHistogram: computeColorHistogram24(data),
    stats: computeEdgeStatsAndScreenshot(gray, W, H, aspect, hasCameraExif),
  };
}

async function encodeWebPWithFallback(
  canvas: OffscreenCanvas,
  quality: number,
): Promise<{ buffer: ArrayBuffer; mimeType: string }> {
  try {
    const webp = await canvas.convertToBlob({ type: 'image/webp', quality });
    if (webp.type === 'image/webp' && webp.size > 0) {
      return { buffer: await webp.arrayBuffer(), mimeType: 'image/webp' };
    }
  } catch {
    // Fallback to JPEG if browser OffscreenCanvas lacks WebP encoding
  }
  const jpg = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return { buffer: await jpg.arrayBuffer(), mimeType: 'image/jpeg' };
}

async function encodeAiSnapshotWithTarget(
  canvas: OffscreenCanvas,
  initialQuality: number,
  maxBytes: number,
): Promise<{ buffer: ArrayBuffer; mimeType: string }> {
  let encoded = await encodeWebPWithFallback(canvas, initialQuality);
  if (encoded.buffer.byteLength <= maxBytes) return encoded;
  for (const q of [0.72, 0.62]) {
    encoded = await encodeWebPWithFallback(canvas, q);
    if (encoded.buffer.byteLength <= maxBytes) return encoded;
  }
  return encoded;
}

function renderScaledCanvas(bmp: ImageBitmap, maxEdge: number): { canvas: OffscreenCanvas; width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const width = Math.max(1, Math.round(bmp.width * scale));
  const height = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d');
  if (!g) throw new Error('Không tạo được ngữ cảnh 2D trong Worker');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, width, height);
  return { canvas, width, height };
}

async function processImage(id: number, rawBuf: ArrayBuffer, mimeType: string, originalBytes: number): Promise<void> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    ctx?.postMessage({
      id,
      type: 'error',
      unsupported: true,
      message: 'Trình duyệt chưa hỗ trợ OffscreenCanvas trong Web Worker.',
    } satisfies ImageProcessorResponse);
    return;
  }

  const t0 = performance.now();
  const exif = extractExifMetadata(rawBuf);
  const blob = new Blob([rawBuf], { type: mimeType || 'image/jpeg' });
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });

  try {
    const display = renderScaledCanvas(bmp, DISPLAY_MAX_EDGE);
    const ai = renderScaledCanvas(bmp, AI_MAX_EDGE);

    const [displayEncoded, aiEncoded] = await Promise.all([
      encodeWebPWithFallback(display.canvas, DISPLAY_QUALITY),
      encodeAiSnapshotWithTarget(ai.canvas, AI_QUALITY, AI_TARGET_MAX_BYTES),
    ]);

    const t1 = performance.now();
    const hasCameraExif = Boolean(exif.cameraMake || exif.cameraModel);
    const [cv, aiSha256] = await Promise.all([
      Promise.resolve(extractWorkerCvFeatures(ai.canvas, bmp.width / Math.max(1, bmp.height), hasCameraExif)),
      sha256Hex(aiEncoded.buffer),
    ]);
    const hashMs = performance.now() - t1;

    const msg: ImageProcessorResponse = {
      id,
      type: 'processed',
      aiBuffer: aiEncoded.buffer,
      aiMimeType: aiEncoded.mimeType,
      aiSha256,
      displayBuffer: displayEncoded.buffer,
      displayMimeType: displayEncoded.mimeType,
      dHash: cv.dHash,
      pHash: cv.pHash,
      subGridHashes: cv.subGridHashes,
      colorHistogram: cv.colorHistogram,
      width: display.width,
      height: display.height,
      originalBytes,
      aiBytes: aiEncoded.buffer.byteLength,
      displayBytes: displayEncoded.buffer.byteLength,
      stats: cv.stats,
      exif,
      timings: { totalMs: performance.now() - t0, hashMs },
    };

    ctx?.postMessage(msg, [aiEncoded.buffer, displayEncoded.buffer]);
  } finally {
    bmp.close();
  }
}

if (ctx) {
  ctx.onmessage = (ev: MessageEvent<ImageProcessorRequest>) => {
    const req = ev.data;
    const fail = (err: unknown): void => {
      ctx.postMessage({
        id: req.id,
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      } satisfies ImageProcessorResponse);
    };

    if (req.type === 'process') {
      processImage(req.id, req.buffer, req.mimeType, req.size).catch(fail);
    } else if (req.type === 'process_blob') {
      req.blob
        .arrayBuffer()
        .then((buf) => processImage(req.id, buf, req.blob.type, req.blob.size))
        .catch(fail);
    }
  };
}
