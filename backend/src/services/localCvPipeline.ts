/**
 * High-Speed Local Computer Vision Pipeline (`sharp` native libvips C/C++ SIMD).
 * Vận hành trực tiếp trong tiến trình Node.js (< 15–45ms) khi Rust daemon (:8001) không hiện diện (vd: Render Node container):
 *  1) Thẩm định EXIF & phát hiện ảnh chụp màn hình / chụp lại màn hình (Screenshot & Screen Recapture Forensics).
 *  2) Trích xuất Multi-Scale 3x3 Grid dHash + pHash + Center Hash + Local FAST/Corner Keypoint Brief Descriptors
 *     để bắt chính xác cả ảnh bị cắt góc (crop) hoặc thay đổi kích thước trong bán kính 200m.
 *  3) Chấm điểm độc lập Nghiệm thu Trước/Sau: `sceneMatchScore` (khớp bối cảnh nền) & `resolutionScore` (mức độ xử lý sự cố).
 */

import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { hammingDistance } from '../shared/dhash';
import { predictWithLocalOnnxModel } from './ai/localOnnxRunner';

sharp.cache(false);
sharp.concurrency(2);
import { haversineMeters } from '../shared/geo';
import type { Category } from '../shared/types';
import type { ImageFingerprintRecord } from '../repositories/types';
import type {
  RustAuthenticityResult,
  RustDuplicateResult,
  RustResolutionResult,
} from './cvEngine.service';

const SCREENSHOT_SOFTWARE_RE =
  /(screenshot|snipping|lightshot|greenshot|sharex|gyazo|flameshot|screencapture|canva|figma|photoshop|gimp|paint)/i;

const COMMON_SCREEN_RATIOS = [
  9 / 19.5, // iPhone / Android hiện đại (19.5:9)
  9 / 20,   // Android 20:9
  9 / 16,   // 16:9 dọc
  16 / 9,   // 16:9 ngang (màn hình máy tính)
  16 / 10,  // MacBook / Laptop 16:10
];

function computeDHashFromGray(gray: Uint8Array, strideW: number, x0: number, y0: number, w: number, h: number): string {
  // Lấy mẫu nội suy nhanh về lưới 9x8
  const grid = new Float32Array(9 * 8);
  for (let gy = 0; gy < 8; gy++) {
    const sy = Math.min(y0 + h - 1, y0 + Math.floor(((gy + 0.5) * h) / 8));
    for (let gx = 0; gx < 9; gx++) {
      const sx = Math.min(x0 + w - 1, x0 + Math.floor(((gx + 0.5) * w) / 9));
      grid[gy * 9 + gx] = gray[sy * strideW + sx];
    }
  }
  const nibbles: string[] = [];
  let acc = 0;
  let bits = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      acc = (acc << 1) | (grid[y * 9 + x] > grid[y * 9 + x + 1] ? 1 : 0);
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

export function computePHashFromGray(gray: Uint8Array, width: number, height: number): string {
  const N = 32;
  const sample = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / N));
    for (let x = 0; x < N; x++) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) * width) / N));
      sample[y * N + x] = gray[sy * width + sx];
    }
  }
  const coeffs = new Float64Array(64);
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let sum = 0;
      for (let y = 0; y < N; y++) {
        const cy = Math.cos(((2 * y + 1) * u * Math.PI) / (2 * N));
        for (let x = 0; x < N; x++) {
          sum += sample[y * N + x] * cy * Math.cos(((2 * x + 1) * v * Math.PI) / (2 * N));
        }
      }
      coeffs[u * 8 + v] = sum;
    }
  }
  const ac = Array.from(coeffs.slice(1)).sort((a, b) => a - b);
  const median = ac[Math.floor(ac.length / 2)] ?? 0;
  const nibbles: string[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < 64; i++) {
    acc = (acc << 1) | (i > 0 && coeffs[i] > median ? 1 : 0);
    bits += 1;
    if (bits === 4) {
      nibbles.push(acc.toString(16));
      acc = 0;
      bits = 0;
    }
  }
  return nibbles.join('');
}

function computeSsimAndEdgeDiffServer(
  beforeGray: Uint8Array,
  afterGray: Uint8Array,
  size: number,
): { ssim: number; upperSsim: number; edgeDiffRatio: number } {
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let ssimSum = 0;
  let upperSum = 0;
  let blocks = 0;
  let upperBlocks = 0;
  const upperCut = Math.floor(size * 0.52);

  for (let by = 0; by + 8 <= size; by += 8) {
    for (let bx = 0; bx + 8 <= size; bx += 8) {
      let sA = 0;
      let sB = 0;
      let qA = 0;
      let qB = 0;
      let mAB = 0;
      for (let dy = 0; dy < 8; dy++) {
        const row = (by + dy) * size + bx;
        for (let dx = 0; dx < 8; dx++) {
          const a = beforeGray[row + dx];
          const b = afterGray[row + dx];
          sA += a;
          sB += b;
          qA += a * a;
          qB += b * b;
          mAB += a * b;
        }
      }
      const muA = sA / 64;
      const muB = sB / 64;
      const vA = Math.max(0, qA / 64 - muA * muA);
      const vB = Math.max(0, qB / 64 - muB * muB);
      const cAB = mAB / 64 - muA * muB;
      const ssim = ((2 * muA * muB + C1) * (2 * cAB + C2)) / ((muA * muA + muB * muB + C1) * (vA + vB + C2));
      ssimSum += ssim;
      blocks += 1;
      if (by + 8 <= upperCut) {
        upperSum += ssim;
        upperBlocks += 1;
      }
    }
  }

  let edgeDiff = 0;
  let edgeEnergy = 0;
  for (let y = Math.floor(size * 0.25); y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x;
      const gB = Math.abs(beforeGray[i + 1] - beforeGray[i - 1]) + Math.abs(beforeGray[i + size] - beforeGray[i - size]);
      const gA = Math.abs(afterGray[i + 1] - afterGray[i - 1]) + Math.abs(afterGray[i + size] - afterGray[i - size]);
      edgeDiff += Math.abs(gB - gA);
      edgeEnergy += Math.max(gB, gA, 1);
    }
  }

  return {
    ssim: Math.max(0, Math.min(1, ssimSum / Math.max(1, blocks))),
    upperSsim: Math.max(0, Math.min(1, upperSum / Math.max(1, upperBlocks))),
    edgeDiffRatio: Math.max(0, Math.min(1, edgeDiff / Math.max(1, edgeEnergy))),
  };
}

/** Trích xuất tối đa 48 điểm góc mạnh nhất (Shi-Tomasi/Sobel response) kèm descriptor nhị phân 64-bit (8 bytes/điểm). */
function extractCornerDescriptors(gray: Uint8Array, w: number, h: number, maxPts = 48): { count: number; base64: string; bytes: Uint8Array } {
  const candidates: Array<{ x: number; y: number; score: number }> = [];
  const step = 6;
  for (let y = 8; y < h - 8; y += step) {
    for (let x = 8; x < w - 8; x += step) {
      const idx = y * w + x;
      const gx = Math.abs(gray[idx + 1] - gray[idx - 1]);
      const gy = Math.abs(gray[idx + w] - gray[idx - w]);
      const gxy = Math.abs(gray[idx + w + 1] - gray[idx - w - 1]);
      const score = Math.min(gx, gy) * 2 + gxy;
      if (score >= 28) {
        candidates.push({ x, y, score });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, maxPts);
  const out = new Uint8Array(top.length * 8);

  // 64 cặp điểm cố định quanh tâm bán kính [-6..6] để tạo descriptor bất biến độ sáng cục bộ
  for (let i = 0; i < top.length; i++) {
    const { x, y } = top[i];
    for (let byteIdx = 0; byteIdx < 8; byteIdx++) {
      let b = 0;
      for (let bit = 0; bit < 8; bit++) {
        const k = byteIdx * 8 + bit;
        const dx1 = ((k * 7 + 3) % 13) - 6;
        const dy1 = ((k * 11 + 5) % 13) - 6;
        const dx2 = ((k * 5 + 9) % 13) - 6;
        const dy2 = ((k * 3 + 1) % 13) - 6;
        const p1 = gray[(y + dy1) * w + (x + dx1)];
        const p2 = gray[(y + dy2) * w + (x + dx2)];
        b = (b << 1) | (p1 > p2 ? 1 : 0);
      }
      out[i * 8 + byteIdx] = b;
    }
  }

  return {
    count: top.length,
    base64: Buffer.from(out).toString('base64'),
    bytes: out,
  };
}

const POPCOUNT_8: Uint8Array = (() => {
  const tbl = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let x = i;
    let c = 0;
    while (x) {
      c += x & 1;
      x >>= 1;
    }
    tbl[i] = c;
  }
  return tbl;
})();

function countDescriptorInliers(a: Uint8Array, bBase64: string, maxBitDist = 11): number {
  if (!a.length || !bBase64) return 0;
  const b = Buffer.from(bBase64, 'base64');
  const nA = Math.floor(a.length / 8);
  const nB = Math.floor(b.length / 8);
  if (nA === 0 || nB === 0) return 0;

  let inliers = 0;
  for (let i = 0; i < nA; i++) {
    let best = 65;
    let second = 65;
    const offA = i * 8;
    for (let j = 0; j < nB; j++) {
      const offB = j * 8;
      let dist = 0;
      for (let k = 0; k < 8; k++) {
        dist += POPCOUNT_8[a[offA + k] ^ b[offB + k]];
      }
      if (dist < best) {
        second = best;
        best = dist;
      } else if (dist < second) {
        second = dist;
      }
    }
    if (best <= maxBitDist && best < second * 0.82) {
      inliers += 1;
    }
  }
  return inliers;
}

function decodeBase64Payload(raw: string): Buffer {
  const idx = raw.indexOf(',');
  const clean = idx >= 0 && raw.slice(0, idx).includes('base64') ? raw.slice(idx + 1).trim() : raw.trim();
  return Buffer.from(clean, 'base64');
}

function readAsciiExifHints(buf: Buffer): { hasCameraExif: boolean; screenshotSoftware: boolean } {
  const head = buf.subarray(0, Math.min(buf.length, 32_768)).toString('latin1');
  const screenshotSoftware = SCREENSHOT_SOFTWARE_RE.test(head);
  const hasCameraExif =
    head.includes('Exif') &&
    /(Apple|Samsung|Xiaomi|OPPO|vivo|Realme|Google|Canon|Nikon|Sony|Huawei|f\/\d|ISO)/i.test(head);
  return { hasCameraExif, screenshotSoftware };
}

export async function runSharpAuthenticityCheck(
  imageBase64: string,
  screenshotThreshold: number,
): Promise<RustAuthenticityResult> {
  const t0 = performance.now();
  const buf = decodeBase64Payload(imageBase64);
  const { hasCameraExif, screenshotSoftware } = readAsciiExifHints(buf);

  const img = sharp(buf, { failOn: 'none' });
  const meta = await img.metadata();
  const origW = meta.width ?? 640;
  const origH = meta.height ?? 480;

  const W = 160;
  const H = 160;
  const gray = await img.clone().grayscale().resize(W, H, { fit: 'fill' }).raw().toBuffer();

  // 1. Tính độ nét Laplacian, tỷ lệ vùng phẳng 8x8 & dải thanh trạng thái trên cùng
  let lapSum = 0;
  let lapSq = 0;
  let lapN = 0;
  let moireAltCount = 0;
  let edgePixels = 0;
  let bimodalSharpEdges = 0;
  const histBins = new Float64Array(16);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      histBins[Math.min(15, gray[i] >> 4)] += 1;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - W] - gray[i + W];
      lapSum += lap;
      lapSq += lap * lap;
      lapN += 1;
      const d1 = gray[i] - gray[i - 1];
      const d2 = gray[i + 1] - gray[i];
      if (d1 * d2 < -225) moireAltCount += 1;
      const grad = Math.max(Math.abs(gray[i + 1] - gray[i - 1]), Math.abs(gray[i + W] - gray[i - W]));
      if (grad >= 20) {
        edgePixels += 1;
        if (grad >= 48 && Math.abs(d1) >= 40) bimodalSharpEdges += 1;
      }
    }
  }
  const meanLap = lapSum / Math.max(1, lapN);
  const blurVar = lapSq / Math.max(1, lapN) - meanLap * meanLap;
  const moireRatio = moireAltCount / Math.max(1, lapN);
  const sharpEdgeRatio = edgePixels > 0 ? bimodalSharpEdges / edgePixels : 0;

  let entropy = 0;
  for (let b = 0; b < 16; b++) {
    const p = histBins[b] / Math.max(1, lapN);
    if (p > 0) entropy -= p * Math.log2(p);
  }
  const entropyNorm = Math.min(1, entropy / 4);

  let flatBlocks = 0;
  let totalBlocks = 0;
  for (let by = 0; by + 8 <= H; by += 8) {
    for (let bx = 0; bx + 8 <= W; bx += 8) {
      let s = 0;
      let sq = 0;
      for (let dy = 0; dy < 8; dy++) {
        for (let dx = 0; dx < 8; dx++) {
          const v = gray[(by + dy) * W + (bx + dx)];
          s += v;
          sq += v * v;
        }
      }
      const variance = sq / 64 - (s / 64) ** 2;
      if (variance < 10) flatBlocks += 1;
      totalBlocks += 1;
    }
  }
  const flatRatio = flatBlocks / Math.max(1, totalBlocks);

  // Kiểm tra thanh trạng thái UI đồng nhất ở 6% mép trên cùng của ảnh dọc
  let topBandVar = 0;
  const topRows = 8;
  let topSum = 0;
  let topSq = 0;
  for (let i = 0; i < topRows * W; i++) {
    topSum += gray[i];
    topSq += gray[i] * gray[i];
  }
  topBandVar = topSq / (topRows * W) - (topSum / (topRows * W)) ** 2;

  const aspect = origW / Math.max(1, origH);
  const matchesPhoneScreenRatio = COMMON_SCREEN_RATIOS.some((r) => Math.abs(aspect - r) < 0.018);

  const features16 = new Float32Array(16);
  features16[0] = hasCameraExif ? 1 : 0;
  features16[1] = screenshotSoftware ? 1 : 0;
  features16[2] = matchesPhoneScreenRatio ? 1 : 0;
  features16[3] = !hasCameraExif && meta.format === 'png' ? 1 : 0;
  features16[4] = matchesPhoneScreenRatio && topBandVar < 35 ? 1 : 0;
  features16[5] = flatRatio > 0.5 ? 0.6 : 0;
  features16[6] = flatRatio;
  features16[7] = sharpEdgeRatio;
  features16[8] = Math.min(1, moireRatio * 3.5);
  features16[9] = Math.min(1, moireRatio * 2.5);
  features16[10] = entropyNorm;
  features16[11] = Math.min(1, blurVar / 500);
  features16[12] = Math.max(0, 1 - flatRatio);
  features16[13] = 0.25;
  features16[14] = 0.15;
  features16[15] = Math.min(1, (1 - flatRatio) * entropyNorm);

  const onnxPred = predictWithLocalOnnxModel(features16);

  let score = hasCameraExif ? 92 : 88;
  const flags: string[] = [];

  if (screenshotSoftware) {
    score -= 35;
    flags.push('exif_screenshot_software');
  }
  if (flatRatio > 0.78) {
    score -= 28;
    flags.push('high_flat_ui_surface');
  } else if (flatRatio > 0.62 && matchesPhoneScreenRatio && topBandVar < 22) {
    score -= 22;
    flags.push('mobile_screenshot_layout');
  }
  if (sharpEdgeRatio > 0.6 && !hasCameraExif) {
    score -= 18;
    flags.push('sharp_ui_edges');
  }
  if (moireRatio > 0.35 || onnxPred.isScreenPhotoProb >= 0.9) {
    score -= 20;
    flags.push('screen_moire_pattern');
  }
  const hasScreenshotVisualEvidence = flatRatio >= 0.72 || sharpEdgeRatio >= 0.58;
  if (onnxPred.onnxModelLoaded && onnxPred.isScreenshotProb >= 0.88 && !hasCameraExif && hasScreenshotVisualEvidence) {
    score -= 22;
    flags.push('onnx_screenshot_detected');
  }
  if (blurVar < 12) {
    score -= 18;
    flags.push('severe_blur');
  }

  const finalScore = Math.max(25, Math.min(99, Math.round(score)));
  const isAuthentic = finalScore >= Math.min(screenshotThreshold, 55);
  const latencyMs = Math.round((performance.now() - t0) * 10) / 10;

  return {
    is_authentic: isAuthentic,
    authenticity_score: finalScore,
    is_screenshot_prob: onnxPred.onnxModelLoaded
      ? Math.max(onnxPred.isScreenshotProb, Math.round(Math.max(0, Math.min(1, (100 - finalScore) / 100)) * 100) / 100)
      : Math.round(Math.max(0, Math.min(1, (100 - finalScore) / 100)) * 100) / 100,
    is_screen_photo_prob: Math.max(onnxPred.isScreenPhotoProb, Math.round(Math.min(1, moireRatio * 4) * 100) / 100),
    flags,
    reason: isAuthentic
      ? 'Ảnh đạt chuẩn hiện trường thực tế (Sharp + ONNX).'
      : 'Phát hiện dấu hiệu ảnh chụp màn hình hoặc chất lượng chưa đạt chuẩn.',
    onnx_model_loaded: onnxPred.onnxModelLoaded,
    latency_ms: latencyMs,
    engine: 'fallback',
  };
}

export async function runSharpDuplicateCheck(params: {
  imageBase64: string;
  fallbackDHash: string;
  reportId: string;
  lat: number;
  lng: number;
  duplicateThreshold: number;
  minKeypointInliers: number;
  candidates: ImageFingerprintRecord[];
}): Promise<RustDuplicateResult> {
  const t0 = performance.now();
  const buf = decodeBase64Payload(params.imageBase64);
  const SIZE = 180;
  const gray = new Uint8Array(
    await sharp(buf, { failOn: 'none' }).grayscale().resize(SIZE, SIZE, { fit: 'fill' }).raw().toBuffer(),
  );

  const dhashHex = computeDHashFromGray(gray, SIZE, 0, 0, SIZE, SIZE) || params.fallbackDHash;
  const phashHex = computePHashFromGray(gray, SIZE, SIZE);
  const cMargin = Math.floor(SIZE * 0.2);
  const cSpan = SIZE - cMargin * 2;
  const centerDhashHex = computeDHashFromGray(gray, SIZE, cMargin, cMargin, cSpan, cSpan);

  // 3x3 Multi-Scale Grid Hashes (bắt ảnh cắt góc / zoom cục bộ)
  const gridHashes: string[] = [];
  const cell = Math.floor(SIZE / 3);
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      gridHashes.push(computeDHashFromGray(gray, SIZE, gx * cell, gy * cell, cell, cell));
    }
  }

  const kp = extractCornerDescriptors(gray, SIZE, SIZE, 48);

  let bestMatchId: string | null = null;
  let matchType = 'none';
  let minHamming = 64;
  let bestGridMatches = 0;
  let bestInliers = 0;
  let bestSimilarity = 0;

  for (const c of params.candidates) {
    if (c.reportId === params.reportId) continue;
    const hdFull = hammingDistance(dhashHex, c.dHash);
    const hdCenter = c.centerHash ? hammingDistance(centerDhashHex, c.centerHash) : 64;
    const hdCrossCrop = c.centerHash ? Math.min(hammingDistance(dhashHex, c.centerHash), hammingDistance(centerDhashHex, c.dHash)) : 64;
    const bestHd = Math.min(hdFull, hdCenter, hdCrossCrop);
    if (bestHd < minHamming) minHamming = bestHd;

    let gridHits = 0;
    if (Array.isArray(c.gridHashes) && c.gridHashes.length > 0) {
      for (const gh of gridHashes) {
        if (c.gridHashes.some((ch) => hammingDistance(gh, ch) <= 5)) {
          gridHits += 1;
        }
      }
      // Hoặc ảnh mới là phần cắt từ 1 ô 3x3 của ảnh cũ
      if (c.gridHashes.some((ch) => hammingDistance(dhashHex, ch) <= 4 || hammingDistance(centerDhashHex, ch) <= 4)) {
        gridHits = Math.max(gridHits, 4);
      }
    }

    const inliers = c.descriptorsBase64 ? countDescriptorInliers(kp.bytes, c.descriptorsBase64) : 0;

    const isExactDup = hdFull <= params.duplicateThreshold;
    const isCropDup = hdCrossCrop <= 5 || gridHits >= 4 || inliers >= Math.max(10, params.minKeypointInliers);

    if (isExactDup || isCropDup) {
      const sim = isExactDup
        ? Math.round(((64 - hdFull) / 64) * 1000) / 10
        : Math.min(98, Math.round(65 + gridHits * 5 + inliers * 1.2));
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestMatchId = c.reportId;
        matchType = isExactDup ? 'perceptual_dhash' : gridHits >= 4 ? 'multiscale_crop_grid' : 'local_keypoints';
        bestGridMatches = gridHits;
        bestInliers = inliers;
      }
    }
  }

  return {
    is_duplicate: bestMatchId !== null,
    match_type: matchType,
    matched_incident_id: bestMatchId,
    similarity_score: bestSimilarity,
    inlier_count: bestInliers,
    min_hamming: minHamming,
    grid_matches: bestGridMatches,
    fingerprint: {
      dhash_hex: dhashHex,
      phash_hex: phashHex,
      center_dhash_hex: centerDhashHex,
      grid_dhashes_hex: gridHashes,
      keypoint_count: kp.count,
      descriptors_base64: kp.base64,
    },
    latency_ms: Math.round((performance.now() - t0) * 10) / 10,
    engine: 'fallback',
  };
}

export async function runSharpBeforeAfterVerify(params: {
  beforeBase64: string;
  afterBase64: string;
  category: Category;
  beforeLat?: number;
  beforeLng?: number;
  afterLat?: number;
  afterLng?: number;
  sceneMatchThreshold: number;
  resolutionThreshold: number;
}): Promise<RustResolutionResult> {
  const t0 = performance.now();
  const SIZE = 160;

  const [beforeGrayBuf, afterGrayBuf] = await Promise.all([
    sharp(decodeBase64Payload(params.beforeBase64), { failOn: 'none' })
      .grayscale()
      .normalize()
      .resize(SIZE, SIZE, { fit: 'fill' })
      .raw()
      .toBuffer(),
    sharp(decodeBase64Payload(params.afterBase64), { failOn: 'none' })
      .grayscale()
      .normalize()
      .resize(SIZE, SIZE, { fit: 'fill' })
      .raw()
      .toBuffer(),
  ]);

  const bGray = new Uint8Array(beforeGrayBuf);
  const aGray = new Uint8Array(afterGrayBuf);

  const bHash = computeDHashFromGray(bGray, SIZE, 0, 0, SIZE, SIZE);
  const aHash = computeDHashFromGray(aGray, SIZE, 0, 0, SIZE, SIZE);
  const fullHd = hammingDistance(bHash, aHash);

  const gpsDistM =
    typeof params.beforeLat === 'number' &&
    typeof params.beforeLng === 'number' &&
    typeof params.afterLat === 'number' &&
    typeof params.afterLng === 'number'
      ? Math.round(haversineMeters(params.beforeLat, params.beforeLng, params.afterLat, params.afterLng) * 10) / 10
      : null;

  if (fullHd <= 4) {
    return {
      verified: false,
      status: 'duplicate_photo_rejected',
      confidence: 18,
      scene_match_score: 96,
      resolution_score: 10,
      inlier_keypoints: 48,
      gps_distance_m: gpsDistM,
      summary: 'Ảnh sau xử lý trùng lặp với ảnh trước xử lý — sự cố chưa được khắc phục.',
      latency_ms: Math.round((performance.now() - t0) * 10) / 10,
      engine: 'fallback',
    };
  }

  // So sánh nửa trên (kiến trúc/cây cối/cột điện cố định) để đo sceneMatchScore
  const bTopHash = computeDHashFromGray(bGray, SIZE, 0, 0, SIZE, Math.floor(SIZE * 0.52));
  const aTopHash = computeDHashFromGray(aGray, SIZE, 0, 0, SIZE, Math.floor(SIZE * 0.52));
  const topHd = hammingDistance(bTopHash, aTopHash);

  const kpB = extractCornerDescriptors(bGray, SIZE, SIZE, 48);
  const kpA = extractCornerDescriptors(aGray, SIZE, SIZE, 48);
  const inliers = countDescriptorInliers(kpB.bytes, kpA.base64, 13);

  // Đo thay đổi bề mặt vùng trung tâm/hạ cảnh (nơi thường chứa rác thải, ổ gà, nước ngập)
  let roiDiffSum = 0;
  let roiPixels = 0;
  let bRoughness = 0;
  let aRoughness = 0;
  for (let y = Math.floor(SIZE * 0.35); y < SIZE - 2; y++) {
    for (let x = Math.floor(SIZE * 0.12); x < Math.floor(SIZE * 0.88); x++) {
      const i = y * SIZE + x;
      roiDiffSum += Math.abs(bGray[i] - aGray[i]);
      bRoughness += Math.abs(bGray[i + 1] - bGray[i]) + Math.abs(bGray[i + SIZE] - bGray[i]);
      aRoughness += Math.abs(aGray[i + 1] - aGray[i]) + Math.abs(aGray[i + SIZE] - aGray[i]);
      roiPixels += 1;
    }
  }
  const meanRoiDiff = roiDiffSum / Math.max(1, roiPixels);
  const roughnessDropRatio = bRoughness > 0 ? Math.max(0, (bRoughness - aRoughness) / bRoughness) : 0;
  const ssimStats = computeSsimAndEdgeDiffServer(bGray, aGray, SIZE);

  let sceneMatchScore = Math.round(
    Math.max(0, 100 - topHd * 1.55) * 0.35 +
      ssimStats.upperSsim * 100 * 0.35 +
      Math.min(100, 50 + inliers * 3.2) * 0.3,
  );
  if (gpsDistM !== null) {
    if (gpsDistM <= 65) sceneMatchScore = Math.min(98, sceneMatchScore + 8);
    else if (gpsDistM > 350) sceneMatchScore = Math.max(15, sceneMatchScore - 35);
  }
  sceneMatchScore = Math.max(10, Math.min(98, sceneMatchScore));

  let resolutionScore = Math.round(
    Math.min(
      96,
      46 +
        Math.min(26, meanRoiDiff * 0.85) +
        Math.min(14, roughnessDropRatio * 45) +
        Math.min(18, ssimStats.edgeDiffRatio * 36),
    ),
  );
  if (fullHd > 46 && inliers < 3 && (gpsDistM === null || gpsDistM > 150)) {
    sceneMatchScore = Math.min(sceneMatchScore, 38);
    resolutionScore = Math.min(resolutionScore, 42);
  }

  const verified =
    sceneMatchScore >= params.sceneMatchThreshold && resolutionScore >= params.resolutionThreshold;
  const confidence = Math.round(sceneMatchScore * 0.45 + resolutionScore * 0.55);

  return {
    verified,
    status: verified ? 'verified' : sceneMatchScore < params.sceneMatchThreshold ? 'scene_mismatch' : 'insufficient_remediation',
    confidence,
    scene_match_score: sceneMatchScore,
    resolution_score: resolutionScore,
    inlier_keypoints: inliers,
    gps_distance_m: gpsDistM,
    summary: verified
      ? `Đối chiếu đạt yêu cầu: đúng vị trí hiện trường (${sceneMatchScore}%) và khu vực sự cố đã được khắc phục (${resolutionScore}%).`
      : sceneMatchScore < params.sceneMatchThreshold
        ? `Bối cảnh hiện trường chưa khớp với ảnh ban đầu (${sceneMatchScore}% < ${params.sceneMatchThreshold}%). Vui lòng chụp lại cùng góc nhìn.`
        : `Mức độ khắc phục sự cố chưa đạt ngưỡng nghiệm thu (${resolutionScore}% < ${params.resolutionThreshold}%).`,
    latency_ms: Math.round((performance.now() - t0) * 10) / 10,
    engine: 'fallback',
  };
}
