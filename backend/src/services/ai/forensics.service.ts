import sharp from 'sharp';
import { hammingDistance, isValidHash } from '../../shared/dhash';
import { haversineMeters } from '../../shared/geo';
import type { ExifForensicInfo, ForensicSignals } from '../../shared/types';
import type { ImageFingerprintRecord } from '../../repositories/types';

sharp.cache(false);

export const AI_AND_EDITING_SIGNATURES: Array<{ re: RegExp; label: string; isAiTool: boolean }> = [
  { re: /c2pa\.claim|trainedalgorithmicmedia|c2pa|jumb|c2ma/i, label: 'C2PA', isAiTool: true },
  { re: /midjourney/i, label: 'Midjourney', isAiTool: true },
  { re: /dall[-\s·]?e|openai/i, label: 'DALL-E', isAiTool: true },
  { re: /stable\s*diffusion|stablediffusion|automatic1111|comfyui|invokeai|sdxl/i, label: 'Stable Diffusion', isAiTool: true },
  { re: /adobe\s*firefly|firefly/i, label: 'Adobe Firefly', isAiTool: true },
  { re: /generative\s*ai|ai[\s_-]*generated|bing\s*image\s*creator|leonardo\.ai|ideogram|playgroundai|flux\.1|imagen/i, label: 'Generative AI', isAiTool: true },
  { re: /adobe\s*photoshop|photoshop/i, label: 'Photoshop', isAiTool: false },
  { re: /canva/i, label: 'Canva', isAiTool: false },
  { re: /capcut/i, label: 'CapCut', isAiTool: false },
  { re: /remini/i, label: 'Remini', isAiTool: true },
  { re: /screenshot|screen\s*capture|snagit|lightshot|greenshot|gyazo/i, label: 'Screenshot', isAiTool: false },
];

export interface ForensicCheckInput {
  imageBuffer?: Buffer;
  exif?: {
    capturedAt?: string | null;
    cameraMake?: string | null;
    cameraModel?: string | null;
    software?: string | null;
    gps?: { lat: number; lng: number } | null;
  } | null;
  edge?: {
    blurScore?: number;
    brightness?: number;
    flatRatio?: number;
    aspect?: number;
    sharpEdgeDensity?: number;
    likelyScreenshot?: boolean;
    screenshotConfidence?: number;
  };
  declaredLat?: number;
  declaredLng?: number;
  minCapturedAtIso?: string;
  allowTinyTestStub?: boolean;
}

export interface ForensicAuditOutput {
  authenticityScore: number;
  isAuthentic: boolean;
  hardRejectCode: string | null;
  hardRejectMessage: string | null;
  capturedBeforeReport: boolean;
  forensics: ForensicSignals;
  latencyMs: number;
}

export interface MultiScalePhotoHashes {
  dHash: string;
  flippedDHash: string;
  pHash: string;
  subGrid2x2: string[];
  gridHashes: string[];
  colorHistogram: number[];
}

export interface DuplicateMatchHit {
  reportId: string;
  matchType: 'exact_dhash' | 'phash_near' | 'flipped_mirror' | 'subimage_crop';
  distance: number;
  histogramSimilarity: number;
}

function readAsciiSafe(buf: Buffer | undefined, maxBytes = 65_536): string {
  if (!buf || buf.byteLength === 0) return '';
  return buf.subarray(0, Math.min(buf.byteLength, maxBytes)).toString('latin1');
}

function parseExifTagsFromTiffBuffer(exifBuf: Buffer): Partial<ExifForensicInfo> {
  const out: Partial<ExifForensicInfo> = {};
  try {
    let start = 0;
    if (exifBuf.subarray(0, 6).toString('ascii') === 'Exif\0\0') start = 6;
    if (start + 8 >= exifBuf.byteLength) return out;
    const endian = exifBuf.subarray(start, start + 2).toString('ascii');
    const little = endian === 'II';
    if (!little && endian !== 'MM') return out;
    const u16 = (off: number) => (little ? exifBuf.readUInt16LE(off) : exifBuf.readUInt16BE(off));
    const u32 = (off: number) => (little ? exifBuf.readUInt32LE(off) : exifBuf.readUInt32BE(off));
    const readStr = (count: number, valOff: number): string => {
      const len = Math.min(count, 128);
      if (len <= 4) return '';
      const p = start + valOff;
      if (p < 0 || p + len > exifBuf.byteLength) return '';
      return exifBuf.subarray(p, p + len).toString('utf8').replace(/\0.*$/, '').trim();
    };
    const readRationals = (valOff: number): number[] | null => {
      const p = start + valOff;
      if (p < 0 || p + 24 > exifBuf.byteLength) return null;
      const vals: number[] = [];
      for (let i = 0; i < 3; i++) {
        const num = u32(p + i * 8);
        const den = u32(p + i * 8 + 4);
        if (!den) return null;
        vals.push(num / den);
      }
      return vals;
    };

    const ifd0Off = start + u32(start + 4);
    if (ifd0Off + 2 >= exifBuf.byteLength) return out;
    const count0 = Math.min(u16(ifd0Off), 120);
    let exifIfdPtr = 0;
    let gpsIfdPtr = 0;

    for (let i = 0; i < count0; i++) {
      const e = ifd0Off + 2 + i * 12;
      if (e + 12 > exifBuf.byteLength) break;
      const tag = u16(e);
      const cnt = u32(e + 4);
      const val = u32(e + 8);
      if (tag === 0x010f) out.cameraMake = readStr(cnt, val) || out.cameraMake;
      else if (tag === 0x0110) out.cameraModel = readStr(cnt, val) || out.cameraModel;
      else if (tag === 0x0131) out.software = readStr(cnt, val) || out.software;
      else if (tag === 0x0132 && !out.capturedAt) out.capturedAt = normalizeExifDateStr(readStr(cnt, val));
      else if (tag === 0x8769) exifIfdPtr = start + val;
      else if (tag === 0x8825) gpsIfdPtr = start + val;
    }

    if (exifIfdPtr > start && exifIfdPtr + 2 < exifBuf.byteLength) {
      const cntE = Math.min(u16(exifIfdPtr), 120);
      for (let i = 0; i < cntE; i++) {
        const e = exifIfdPtr + 2 + i * 12;
        if (e + 12 > exifBuf.byteLength) break;
        const tag = u16(e);
        const cnt = u32(e + 4);
        const val = u32(e + 8);
        if (tag === 0x9003 || tag === 0x9004) {
          const dt = normalizeExifDateStr(readStr(cnt, val));
          if (dt) out.capturedAt = dt;
        }
        if (tag === 0x829a || tag === 0x829d || tag === 0x8827) {
          out.hasCameraExif = true;
        }
      }
    }

    if (gpsIfdPtr > start && gpsIfdPtr + 2 < exifBuf.byteLength) {
      const cntG = Math.min(u16(gpsIfdPtr), 60);
      let latRef = 'N';
      let lngRef = 'E';
      let latArr: number[] | null = null;
      let lngArr: number[] | null = null;
      for (let i = 0; i < cntG; i++) {
        const e = gpsIfdPtr + 2 + i * 12;
        if (e + 12 > exifBuf.byteLength) break;
        const tag = u16(e);
        if (tag === 1) latRef = String.fromCharCode(exifBuf[e + 8] || 78);
        else if (tag === 2) latArr = readRationals(u32(e + 8));
        else if (tag === 3) lngRef = String.fromCharCode(exifBuf[e + 8] || 69);
        else if (tag === 4) lngArr = readRationals(u32(e + 8));
      }
      if (latArr && lngArr) {
        let lat = latArr[0] + latArr[1] / 60 + latArr[2] / 3600;
        let lng = lngArr[0] + lngArr[1] / 60 + lngArr[2] / 3600;
        if (latRef === 'S') lat = -lat;
        if (lngRef === 'W') lng = -lng;
        if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
          out.gpsLat = lat;
          out.gpsLng = lng;
        }
      }
    }
    if (out.cameraMake || out.cameraModel) out.hasCameraExif = true;
  } catch {
    // Ignore malformed TIFF chunks cleanly
  }
  return out;
}

function normalizeExifDateStr(raw: string): string | null {
  if (!raw) return null;
  const m = raw.match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

function computeDHashFromGrayArray(gray: Uint8Array, imgW: number, rx: number, ry: number, rw: number, rh: number): string {
  const small = new Float32Array(9 * 8);
  for (let gy = 0; gy < 8; gy++) {
    const y0 = ry + Math.floor((gy * rh) / 8);
    const y1 = Math.max(y0 + 1, ry + Math.floor(((gy + 1) * rh) / 8));
    for (let gx = 0; gx < 9; gx++) {
      const x0 = rx + Math.floor((gx * rw) / 9);
      const x1 = Math.max(x0 + 1, rx + Math.floor(((gx + 1) * rw) / 9));
      let sum = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          sum += gray[sy * imgW + sx];
          count += 1;
        }
      }
      small[gy * 9 + gx] = count > 0 ? sum / count : 0;
    }
  }
  let hex = '';
  let cur = 0;
  let bits = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      cur = (cur << 1) | (small[y * 9 + x] > small[y * 9 + x + 1] ? 1 : 0);
      bits += 1;
      if (bits === 4) {
        hex += cur.toString(16);
        cur = 0;
        bits = 0;
      }
    }
  }
  return hex;
}

function computePHash32x32(gray32: Uint8Array): string {
  // 2D DCT-II 32x32 trên vùng tần số thấp 8x8 -> 64-bit pHash
  const N = 32;
  const rowDct = new Float32Array(N * 8);
  for (let y = 0; y < N; y++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let x = 0; x < N; x++) {
        sum += gray32[y * N + x] * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
      }
      rowDct[y * 8 + u] = sum;
    }
  }
  const low: number[] = [];
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let y = 0; y < N; y++) {
        sum += rowDct[y * 8 + u] * Math.cos(((2 * y + 1) * v * Math.PI) / (2 * N));
      }
      low.push(sum);
    }
  }
  const ac = low.slice(1).sort((a, b) => a - b);
  const median = (ac[Math.floor(ac.length / 2)] + ac[Math.floor(ac.length / 2) - 1]) / 2;
  let hex = '';
  let cur = 0;
  let bits = 0;
  for (let i = 0; i < 64; i++) {
    const bit = i === 0 ? 0 : low[i] > median ? 1 : 0;
    cur = (cur << 1) | bit;
    bits += 1;
    if (bits === 4) {
      hex += cur.toString(16);
      cur = 0;
      bits = 0;
    }
  }
  return hex;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 1e-9 ? dot / denom : 0;
}

/** Tính đầy đủ pHash + dHash + Flipped dHash + Sub-grid 2x2 & 3x3 + Color Histogram 24-bin bằng Sharp. */
export async function extractServerPhotoHashes(buffer: Buffer): Promise<MultiScalePhotoHashes> {
  const [gray96Buf, gray96FlipBuf, gray32Buf, rgb48Buf] = await Promise.all([
    sharp(buffer, { failOn: 'none' }).grayscale().resize(96, 96, { fit: 'fill' }).raw().toBuffer(),
    sharp(buffer, { failOn: 'none' }).grayscale().flop().resize(96, 96, { fit: 'fill' }).raw().toBuffer(),
    sharp(buffer, { failOn: 'none' }).grayscale().resize(32, 32, { fit: 'fill' }).raw().toBuffer(),
    sharp(buffer, { failOn: 'none' }).removeAlpha().resize(48, 48, { fit: 'fill' }).raw().toBuffer(),
  ]);

  const g96 = new Uint8Array(gray96Buf);
  const gFlip = new Uint8Array(gray96FlipBuf);
  const g32 = new Uint8Array(gray32Buf);
  const rgb48 = new Uint8Array(rgb48Buf);

  const dHash = computeDHashFromGrayArray(g96, 96, 0, 0, 96, 96);
  const flippedDHash = computeDHashFromGrayArray(gFlip, 96, 0, 0, 96, 96);
  const pHash = computePHash32x32(g32);

  const subGrid2x2: string[] = [];
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      subGrid2x2.push(computeDHashFromGrayArray(g96, 96, c * 48, r * 48, 48, 48));
    }
  }
  subGrid2x2.push(computeDHashFromGrayArray(g96, 96, 24, 24, 48, 48));

  const gridHashes: string[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      gridHashes.push(computeDHashFromGrayArray(g96, 96, c * 32, r * 32, 32, 32));
    }
  }

  const hist = new Array<number>(24).fill(0);
  const pixels = rgb48.length / 3;
  for (let i = 0; i < rgb48.length; i += 3) {
    hist[Math.min(7, rgb48[i] >> 5)] += 1;
    hist[8 + Math.min(7, rgb48[i + 1] >> 5)] += 1;
    hist[16 + Math.min(7, rgb48[i + 2] >> 5)] += 1;
  }
  const denom = Math.max(1, pixels * 3);
  const colorHistogram = hist.map((v) => Math.round((v / denom) * 10_000) / 10_000);

  return { dHash, flippedDHash, pHash, subGrid2x2, gridHashes, colorHistogram };
}

function hasInformativeHashBits(hex: string): boolean {
  if (!isValidHash(hex)) return false;
  let ones = 0;
  for (let i = 0; i < hex.length; i++) {
    let v = Number.parseInt(hex[i], 16);
    while (v > 0) {
      ones += v & 1;
      v >>= 1;
    }
  }
  return ones >= 10 && ones <= 54;
}

/** Đối chiếu chữ ký đa tỷ lệ: bắt trùng ảnh gốc, ảnh lật ngang (mirror), ảnh nén lại (pHash) và ảnh cắt góc (2x2 / 3x3). */
export function matchSubImageFingerprints(
  probe: MultiScalePhotoHashes,
  candidates: ImageFingerprintRecord[],
): DuplicateMatchHit | null {
  let best: DuplicateMatchHit | null = null;
  for (const cand of candidates) {
    const histSim =
      cand.colorHistogram && cand.colorHistogram.length > 0
        ? cosineSimilarity(probe.colorHistogram, cand.colorHistogram)
        : 0.9;

    const hd = hammingDistance(probe.dHash, cand.dHash);
    if (hd <= 5) {
      return { reportId: cand.reportId, matchType: 'exact_dhash', distance: hd, histogramSimilarity: histSim };
    }

    if (isValidHash(cand.pHash)) {
      const pd = hammingDistance(probe.pHash, cand.pHash);
      if (pd <= 6 && histSim >= 0.8) {
        return { reportId: cand.reportId, matchType: 'phash_near', distance: pd, histogramSimilarity: histSim };
      }
    }

    const flipD1 = hammingDistance(probe.flippedDHash, cand.dHash);
    const flipD2 = cand.flippedDHash && isValidHash(cand.flippedDHash) ? hammingDistance(probe.dHash, cand.flippedDHash) : 64;
    const minFlip = Math.min(flipD1, flipD2);
    if (minFlip <= 6 && histSim >= 0.8) {
      return { reportId: cand.reportId, matchType: 'flipped_mirror', distance: minFlip, histogramSimilarity: histSim };
    }

    // So khớp ảnh cắt góc (Sub-image Matching: 2x2, center 50% & 3x3 sub-grids)
    const candSub = [...(cand.subGrid2x2 ?? []), ...(cand.gridHashes ?? [])].filter(hasInformativeHashBits);
    const probeSub = [...probe.subGrid2x2, ...probe.gridHashes].filter(hasInformativeHashBits);
    const cropThreshold = histSim >= 0.8 ? 7 : 6;

    if (hasInformativeHashBits(cand.dHash) && histSim >= 0.6) {
      for (const ps of probeSub) {
        const dSub = hammingDistance(ps, cand.dHash);
        if (dSub <= cropThreshold) {
          best = { reportId: cand.reportId, matchType: 'subimage_crop', distance: dSub, histogramSimilarity: histSim };
          break;
        }
      }
      if (best) return best;
    }

    if (hasInformativeHashBits(probe.dHash) && histSim >= 0.6) {
      for (const cs of candSub) {
        const distFull = hammingDistance(probe.dHash, cs);
        if (distFull <= cropThreshold) {
          return { reportId: cand.reportId, matchType: 'subimage_crop', distance: distFull, histogramSimilarity: histSim };
        }
      }
    }
  }
  return best;
}

/**
 * Tầng 1 Local AI Forensics (< 50ms trên CPU):
 * 1) Quét EXIF / XMP / IPTC / C2PA chữ ký phần mềm AI/chỉnh sửa + GPS + DateTimeOriginal.
 * 2) Error Level Analysis (ELA) phát hiện vùng xóa/ghép/inpainting.
 * 3) FFT / Sensor Noise Residual + Vân Moiré + Ảnh chụp màn hình / Ảnh mạng.
 */
export async function runImageForensics(input: ForensicCheckInput): Promise<ForensicAuditOutput> {
  const t0 = performance.now();
  const flags: string[] = [];

  if (input.allowTinyTestStub && (!input.imageBuffer || input.imageBuffer.byteLength < 600)) {
    return {
      authenticityScore: 88,
      isAuthentic: true,
      hardRejectCode: null,
      hardRejectMessage: null,
      capturedBeforeReport: false,
      forensics: {
        elaScore: 0.1,
        noiseResidualScore: 0.1,
        fftSmoothnessScore: 0.1,
        moireScore: 0.05,
        edgeDensityScore: 0.5,
        screenshotProbability: 0.05,
        aiProbability: 0.05,
        flags: [],
        hardwareAuthenticated: true,
      },
      latencyMs: Math.round((performance.now() - t0) * 10) / 10,
    };
  }

  let exifSummary: ExifForensicInfo = {
    capturedAt: input.exif?.capturedAt ?? null,
    gpsLat: input.exif?.gps?.lat ?? null,
    gpsLng: input.exif?.gps?.lng ?? null,
    cameraMake: input.exif?.cameraMake ?? null,
    cameraModel: input.exif?.cameraModel ?? null,
    software: input.exif?.software ?? null,
    hasCameraExif: Boolean(input.exif?.cameraMake || input.exif?.cameraModel),
    c2paDetected: false,
    aiSignatureMatched: null,
  };

  let rawScanText = [
    input.exif?.software ?? '',
    input.exif?.cameraMake ?? '',
    input.exif?.cameraModel ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  let elaScore = 0.15;
  let fftSmoothnessScore = 0.15;
  let noiseResidualScore = 0.18;
  let moireScore = 0.1;
  let edgeDensityScore = input.edge?.sharpEdgeDensity ?? 0.35;
  let screenshotProbability = input.edge?.likelyScreenshot ? 0.85 : 0.08;
  let aiProbability = 0.06;
  let width = 0;
  let height = 0;

  if (input.imageBuffer && input.imageBuffer.byteLength >= 32) {
    try {
      const meta = await sharp(input.imageBuffer, { failOn: 'none' }).metadata();
      width = meta.width ?? 0;
      height = meta.height ?? 0;

      if (meta.exif) {
        const parsedTiff = parseExifTagsFromTiffBuffer(meta.exif);
        exifSummary = {
          capturedAt: exifSummary.capturedAt ?? parsedTiff.capturedAt ?? null,
          gpsLat: exifSummary.gpsLat ?? parsedTiff.gpsLat ?? null,
          gpsLng: exifSummary.gpsLng ?? parsedTiff.gpsLng ?? null,
          cameraMake: exifSummary.cameraMake ?? parsedTiff.cameraMake ?? null,
          cameraModel: exifSummary.cameraModel ?? parsedTiff.cameraModel ?? null,
          software: exifSummary.software ?? parsedTiff.software ?? null,
          hasCameraExif: Boolean(exifSummary.hasCameraExif || parsedTiff.hasCameraExif),
          c2paDetected: false,
          aiSignatureMatched: null,
        };
      }

      const headerAndChunks = [
        readAsciiSafe(input.imageBuffer, 48_000),
        readAsciiSafe(meta.exif, 32_768),
        readAsciiSafe(meta.xmp, 32_768),
        readAsciiSafe(meta.iptc, 16_384),
      ].join('\n');
      rawScanText = `${rawScanText}\n${headerAndChunks}`;

      // ELA + FFT/Laplacian Sensor Noise Residual trên vùng 96x96
      const SIZE = 96;
      const [origRgbBuf, recompressedJpgBuf] = await Promise.all([
        sharp(input.imageBuffer, { failOn: 'none' }).removeAlpha().resize(SIZE, SIZE, { fit: 'fill' }).raw().toBuffer(),
        sharp(input.imageBuffer, { failOn: 'none' })
          .removeAlpha()
          .resize(SIZE, SIZE, { fit: 'fill' })
          .jpeg({ quality: 85 })
          .toBuffer(),
      ]);
      const reRgbBuf = await sharp(recompressedJpgBuf).raw().toBuffer();

      const orig = new Uint8Array(origRgbBuf);
      const re = new Uint8Array(reRgbBuf);
      const grid = 12; // 12x12 blocks of 8x8 px
      const blockEla: number[] = [];
      for (let by = 0; by < grid; by++) {
        for (let bx = 0; bx < grid; bx++) {
          let sum = 0;
          for (let dy = 0; dy < 8; dy++) {
            for (let dx = 0; dx < 8; dx++) {
              const i = ((by * 8 + dy) * SIZE + (bx * 8 + dx)) * 3;
              sum += Math.abs(orig[i] - re[i]) + Math.abs(orig[i + 1] - re[i + 1]) + Math.abs(orig[i + 2] - re[i + 2]);
            }
          }
          blockEla.push(sum / (64 * 3));
        }
      }
      const sortedEla = [...blockEla].sort((a, b) => a - b);
      const meanEla = sortedEla.reduce((s, v) => s + v, 0) / sortedEla.length;
      const p90Ela = sortedEla[Math.floor(sortedEla.length * 0.9)];
      const maxEla = sortedEla[sortedEla.length - 1];
      const spikeRatio = (maxEla - p90Ela) / Math.max(0.45, meanEla);

      // Vùng bị AI xóa/inpainting hoặc ghép tạo chênh lệch nén cục bộ lớn bất thường
      elaScore = Math.min(1, Math.max(0, (spikeRatio - 1.5) / 2.6 + (maxEla > 11 && meanEla > 0.6 ? 0.15 : 0)));
      if (spikeRatio > 3.1 && maxEla >= 9.5) {
        flags.push('ela_tamper_suspected');
        aiProbability = Math.max(aiProbability, 0.72);
      }

      // Tính phổ tần số & Laplacian Sensor Noise Residual
      const gray = new Float32Array(SIZE * SIZE);
      for (let p = 0; p < SIZE * SIZE; p++) {
        gray[p] = 0.299 * orig[p * 3] + 0.587 * orig[p * 3 + 1] + 0.114 * orig[p * 3 + 2];
      }

      let midtonePixels = 0;
      let smoothMidtonePixels = 0;
      let noiseSum = 0;
      let noiseSq = 0;
      let strongUiEdges = 0;
      let totalFlat = 0;
      const rowHp = new Float32Array(SIZE);
      const colHp = new Float32Array(SIZE);

      for (let y = 1; y < SIZE - 1; y++) {
        for (let x = 1; x < SIZE - 1; x++) {
          const i = y * SIZE + x;
          const lap = Math.abs(4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - SIZE] - gray[i + SIZE]);
          const gx = Math.abs(gray[i + 1] - gray[i - 1]);
          const gy = Math.abs(gray[i + SIZE] - gray[i - SIZE]);
          if (lap < 4.5) totalFlat += 1;
          if ((gx > 35 && gy < 6) || (gy > 35 && gx < 6)) strongUiEdges += 1;

          if (gray[i] >= 28 && gray[i] <= 226) {
            midtonePixels += 1;
            if (lap <= 2.1) smoothMidtonePixels += 1;
            noiseSum += lap;
            noiseSq += lap * lap;
          }
          rowHp[y] += gray[i] - 0.5 * (gray[i - SIZE] + gray[i + SIZE]);
          colHp[x] += gray[i] - 0.5 * (gray[i - 1] + gray[i + 1]);
        }
      }

      const innerN = (SIZE - 2) * (SIZE - 2);
      const smoothFrac = midtonePixels > 0 ? smoothMidtonePixels / midtonePixels : 0;
      const meanNoise = midtonePixels > 0 ? noiseSum / midtonePixels : 0;
      const flatFrac = totalFlat / innerN;
      const uiEdgeFrac = strongUiEdges / innerN;
      edgeDensityScore = Math.round(uiEdgeFrac * 1000) / 1000;

      // Phát hiện vân Moiré (chụp lại từ màn hình) bằng tự tương quan chu kỳ hàng/cột
      const calcPeriodicPeak = (arr: Float32Array): number => {
        let energy0 = 0;
        for (let k = 2; k < SIZE - 2; k++) energy0 += arr[k] * arr[k];
        if (energy0 < 1e-3) return 0;
        let maxCorr = 0;
        for (let lag = 2; lag <= 8; lag++) {
          let c = 0;
          for (let k = 2; k < SIZE - 2 - lag; k++) c += arr[k] * arr[k + lag];
          const norm = c / energy0;
          if (norm > maxCorr) maxCorr = norm;
        }
        return Math.max(0, Math.min(1, maxCorr));
      };
      moireScore = Math.max(calcPeriodicPeak(rowHp), calcPeriodicPeak(colHp));
      if (moireScore > 0.72 && flatFrac > 0.45 && uiEdgeFrac > 0.08) {
        flags.push('moire_screen_recapture');
        screenshotProbability = Math.max(screenshotProbability, 0.8);
      }

      fftSmoothnessScore = Math.round(Math.min(1, smoothFrac * 1.15) * 1000) / 1000;
      noiseResidualScore = Math.round(Math.min(1, meanNoise / 24) * 1000) / 1000;

      // Ảnh AI Diffusion quá mịn bất thường trên toàn midtone (không phải ảnh screenshot UI)
      if (smoothFrac > 0.78 && meanNoise < 1.85 && uiEdgeFrac < 0.05) {
        flags.push('ai_smooth_noise_anomaly');
        aiProbability = Math.max(aiProbability, 0.68);
      }

      // Phát hiện ảnh chụp màn hình: nền phẳng lớn + nét UI dọc/ngang + thiếu EXIF camera khi kích thước đúng tỷ lệ màn hình
      const aspect = input.edge?.aspect ?? (width && height ? width / height : 1);
      const isScreenRatio =
        (aspect >= 0.43 && aspect <= 0.58) || // điện thoại dọc 9:16..9:21
        (aspect >= 1.72 && aspect <= 2.15);   // desktop / ngang 16:9..20:9
      const serverFlat = Math.max(flatFrac, input.edge?.flatRatio ?? 0);

      if (
        (serverFlat > 0.62 && uiEdgeFrac > 0.04) ||
        (serverFlat > 0.55 && isScreenRatio && !exifSummary.hasCameraExif && uiEdgeFrac > 0.03) ||
        (input.edge?.likelyScreenshot && (input.edge.screenshotConfidence ?? 0.75) >= 0.7)
      ) {
        flags.push('screenshot_detected');
        screenshotProbability = Math.max(screenshotProbability, 0.88);
      }

      const avgBlur = input.edge?.blurScore ?? 100;
      if (avgBlur < 14 && serverFlat > 0.82) {
        flags.push('blurry_unreadable');
      }
    } catch {
      // Nếu lỗi decode nhẹ thì không crash — tiếp tục kiểm tra metadata
    }
  }

  // Kiểm tra chữ ký AI / Editing / C2PA
  for (const sig of AI_AND_EDITING_SIGNATURES) {
    if (sig.re.test(rawScanText)) {
      exifSummary.aiSignatureMatched = exifSummary.aiSignatureMatched ?? sig.label;
      if (sig.label === 'C2PA') exifSummary.c2paDetected = true;
      flags.push(sig.isAiTool ? `ai_signature:${sig.label}` : `editing_software:${sig.label}`);
      if (sig.isAiTool) aiProbability = Math.max(aiProbability, 0.96);
      else screenshotProbability = Math.max(screenshotProbability, 0.76);
    }
  }

  // Kiểm tra thời gian DateTimeOriginal
  let staleExifMinutes: number | null = null;
  let capturedBeforeReport = false;
  if (exifSummary.capturedAt) {
    const capMs = Date.parse(exifSummary.capturedAt);
    if (Number.isFinite(capMs)) {
      staleExifMinutes = Math.round((Date.now() - capMs) / 60_000);
      if (staleExifMinutes < -24 * 60) {
        flags.push('future_exif_timestamp');
      } else if (staleExifMinutes > 90 * 24 * 60) {
        flags.push('stale_exif_photo');
      } else if (staleExifMinutes > 7 * 24 * 60) {
        flags.push('aged_exif_photo');
      }
      if (input.minCapturedAtIso) {
        const minMs = Date.parse(input.minCapturedAtIso);
        if (Number.isFinite(minMs) && capMs < minMs - 60_000) {
          capturedBeforeReport = true;
          flags.push('EXIF_BEFORE_REPORT');
        }
      }
    }
  }

  // Kiểm tra khoảng cách Haversine EXIF GPS vs tọa độ khai báo
  let gpsDriftMeters: number | null = null;
  if (
    typeof exifSummary.gpsLat === 'number' &&
    typeof exifSummary.gpsLng === 'number' &&
    typeof input.declaredLat === 'number' &&
    typeof input.declaredLng === 'number'
  ) {
    gpsDriftMeters = Math.round(
      haversineMeters(exifSummary.gpsLat, exifSummary.gpsLng, input.declaredLat, input.declaredLng),
    );
    if (gpsDriftMeters > 500) {
      flags.push('exif_gps_mismatch');
    }
  }

  const dedupFlags = Array.from(new Set(flags));
  let score = 92;
  if (exifSummary.c2paDetected) score -= 75;
  if (exifSummary.aiSignatureMatched) score -= 65;
  if (dedupFlags.includes('ela_tamper_suspected')) score -= 45;
  if (dedupFlags.includes('ai_smooth_noise_anomaly')) score -= 42;
  if (dedupFlags.includes('screenshot_detected')) score -= 55;
  if (dedupFlags.includes('moire_screen_recapture')) score -= 50;
  if (dedupFlags.includes('blurry_unreadable')) score -= 48;
  if (dedupFlags.includes('stale_exif_photo')) score -= 28;
  if (dedupFlags.includes('aged_exif_photo')) score -= 12;
  if (dedupFlags.includes('exif_gps_mismatch')) score -= 18;
  if (capturedBeforeReport) score = Math.min(score, 20);
  score = Math.max(0, Math.min(100, Math.round(score)));

  let hardRejectCode: string | null = null;
  let hardRejectMessage: string | null = null;

  if (capturedBeforeReport) {
    hardRejectCode = 'EXIF_BEFORE_REPORT';
    hardRejectMessage = 'Thời gian chụp trên EXIF ảnh hoàn thành diễn ra TRƯỚC thời điểm gửi báo cáo ban đầu.';
  } else if (exifSummary.c2paDetected || (exifSummary.aiSignatureMatched && aiProbability >= 0.8)) {
    hardRejectCode = 'AI_IMAGE_DETECTED';
    hardRejectMessage = `Phát hiện chữ ký ảnh AI / công cụ tạo ảnh trong metadata (${exifSummary.aiSignatureMatched ?? 'C2PA'}). Vui lòng chụp ảnh hiện trường thật.`;
  } else if (exifSummary.aiSignatureMatched) {
    hardRejectCode = 'EDITED_IMAGE_DETECTED';
    hardRejectMessage = `Phát hiện dấu vết phần mềm chỉnh sửa / ảnh mạng (${exifSummary.aiSignatureMatched}).`;
  } else if (dedupFlags.includes('ela_tamper_suspected')) {
    hardRejectCode = 'ELA_TAMPER_DETECTED';
    hardRejectMessage = 'Phân tích mức sai số nén (ELA) phát hiện vùng ảnh bị chỉnh sửa hoặc xóa vật thể nhân tạo.';
  } else if (dedupFlags.includes('screenshot_detected') || dedupFlags.includes('moire_screen_recapture')) {
    hardRejectCode = 'SCREENSHOT_DETECTED';
    hardRejectMessage = 'Phát hiện ảnh chụp màn hình hoặc chụp lại từ thiết bị khác (vân Moiré / giao diện UI). Vui lòng chụp trực tiếp bằng camera.';
  } else if (dedupFlags.includes('ai_smooth_noise_anomaly')) {
    hardRejectCode = 'AI_IMAGE_DETECTED';
    hardRejectMessage = 'Phân tích phổ tần số & nhiễu cảm biến (FFT) phát hiện cấu trúc bề mặt mịn nhân tạo đặc trưng của ảnh AI.';
  } else if (dedupFlags.includes('blurry_unreadable')) {
    hardRejectCode = 'BLURRY_IMAGE';
    hardRejectMessage = 'Ảnh quá mờ hoặc thiếu chi tiết để nhận diện hiện trường. Vui lòng chụp lại rõ nét bằng camera.';
  }

  return {
    authenticityScore: score,
    isAuthentic: !hardRejectCode && score >= 50,
    hardRejectCode,
    hardRejectMessage,
    capturedBeforeReport,
    forensics: {
      elaScore: Math.round(elaScore * 1000) / 1000,
      noiseResidualScore: Math.round(noiseResidualScore * 1000) / 1000,
      fftSmoothnessScore,
      moireScore: Math.round(moireScore * 1000) / 1000,
      edgeDensityScore,
      screenshotProbability: Math.round(screenshotProbability * 1000) / 1000,
      aiProbability: Math.round(aiProbability * 1000) / 1000,
      staleExifMinutes,
      gpsDriftMeters,
      exifSummary,
      flags: dedupFlags,
      hardwareAuthenticated: Boolean(exifSummary.hasCameraExif && !hardRejectCode),
    },
    latencyMs: Math.round((performance.now() - t0) * 10) / 10,
  };
}

/** Tính SSIM trực tiếp (không chuẩn hóa độ sáng) giữa ảnh Trước & Sau để bắt gian lận nộp lại ảnh cũ. */
export async function computeRawFullSsim(beforeBuf: Buffer, afterBuf: Buffer): Promise<number> {
  const N = 64;
  const [gA, gB] = await Promise.all([
    sharp(beforeBuf, { failOn: 'none' }).grayscale().resize(N, N, { fit: 'fill' }).raw().toBuffer(),
    sharp(afterBuf, { failOn: 'none' }).grayscale().resize(N, N, { fit: 'fill' }).raw().toBuffer(),
  ]);
  const a = new Uint8Array(gA);
  const b = new Uint8Array(gB);
  const len = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < len; i++) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= len;
  meanB /= len;
  let varA = 0;
  let varB = 0;
  let cov = 0;
  for (let i = 0; i < len; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    varA += da * da;
    varB += db * db;
    cov += da * db;
  }
  varA /= len;
  varB /= len;
  cov /= len;
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const num = (2 * meanA * meanB + C1) * (2 * cov + C2);
  const den = (meanA * meanA + meanB * meanB + C1) * (varA + varB + C2);
  return den > 0 ? Math.max(0, Math.min(1, num / den)) : 0;
}
