/**
 * Thuần toán Computer Vision chạy trên CPU/Web Worker (không phụ thuộc DOM):
 *  - 64-bit dHash + 64-bit 2D-DCT pHash + lưới vùng con 3x3 chống cắt cúp (crop)
 *  - Histogram màu 24-bin L1 + cosine similarity
 *  - Phát hiện ảnh chụp màn hình cục bộ (tỷ lệ màn hình, thiếu EXIF camera, mật độ cạnh gắt bất thường, vùng phẳng UI)
 *  - Đối chiếu Trước/Sau (Before/After) bằng SSIM có cửa sổ + Structural Edge Diff
 */
import { hammingDistance } from '@shared/dhash';

export interface LocalEdgeStats {
  blurScore: number;
  brightness: number;
  flatRatio: number;
  aspect: number;
  sharpEdgeDensity: number;
  likelyScreenshot: boolean;
  screenshotConfidence: number;
}

export interface DuplicateSignatureInput {
  id: string;
  dHash: string;
  pHash?: string;
  subGridHashes?: string[];
  colorHistogram?: number[];
}

export interface DuplicateMatchResult {
  id: string;
  dHashDist: number;
  pHashDist: number | null;
  subGridMinDist: number | null;
  colorSimilarity: number | null;
  isDuplicate: boolean;
  reason: 'dhash' | 'phash' | 'subgrid_crop' | 'none';
}

export interface BeforeAfterSsimResult {
  ssim: number;
  edgeDiffRatio: number;
  upperBgRetention: number;
  roiChangeRatio: number;
  sceneMatchScore: number;
  resolutionScore: number;
  verified: boolean;
  summary: string;
}

const COMMON_SCREEN_RATIOS = [9 / 19.5, 9 / 20, 9 / 21, 9 / 18, 9 / 16, 16 / 9, 18 / 9, 16 / 10, 3 / 4, 4 / 3];

// Bảng cosine 32x32 tiền tính toán cho pHash 2D-DCT siêu nhanh
const DCT_SIZE = 32;
const DCT_COS: Float64Array = (() => {
  const table = new Float64Array(8 * DCT_SIZE);
  for (let u = 0; u < 8; u++) {
    for (let x = 0; x < DCT_SIZE; x++) {
      table[u * DCT_SIZE + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * DCT_SIZE));
    }
  }
  return table;
})();

function nibblesToHex64(bits64: Uint8Array | number[]): string {
  const hex: string[] = [];
  for (let i = 0; i < 64; i += 4) {
    const val = (bits64[i] << 3) | (bits64[i + 1] << 2) | (bits64[i + 2] << 1) | bits64[i + 3];
    hex.push(val.toString(16));
  }
  return hex.join('');
}

/** Chuyển vùng RGBA (rgba, width, height) sang mảng grayscale Uint8Array. */
export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const n = width * height;
  const gray = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    gray[i] = Math.round(rgba[p] * 0.299 + rgba[p + 1] * 0.587 + rgba[p + 2] * 0.114);
  }
  return gray;
}

/** Lấy mẫu lại ảnh xám bất kỳ vùng con (x0, y0, rw, rh) về lưới 9x8 và tính 64-bit dHash. */
export function computeDHashFromGrayRegion(
  gray: Uint8Array,
  strideW: number,
  x0: number,
  y0: number,
  rw: number,
  rh: number,
): string {
  const bits = new Uint8Array(64);
  for (let gy = 0; gy < 8; gy++) {
    const sy = Math.min(y0 + rh - 1, y0 + Math.floor(((gy + 0.5) * rh) / 8));
    let prev = 0;
    for (let gx = 0; gx < 9; gx++) {
      const sx = Math.min(x0 + rw - 1, x0 + Math.floor(((gx + 0.5) * rw) / 9));
      const v = gray[sy * strideW + sx];
      if (gx > 0) {
        bits[gy * 8 + (gx - 1)] = prev > v ? 1 : 0;
      }
      prev = v;
    }
  }
  return nibblesToHex64(bits);
}

/** Tính 64-bit pHash (2D-DCT tần số thấp 8x8 từ ảnh nội suy 32x32). */
export function computePHashFromGray(gray: Uint8Array, width: number, height: number): string {
  const sample = new Float64Array(DCT_SIZE * DCT_SIZE);
  for (let y = 0; y < DCT_SIZE; y++) {
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / DCT_SIZE));
    for (let x = 0; x < DCT_SIZE; x++) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) * width) / DCT_SIZE));
      sample[y * DCT_SIZE + x] = gray[sy * width + sx];
    }
  }

  // Biến đổi DCT 1D theo hàng trước cho 8 tần số thấp (nhanh hơn 10 lần DCT toàn ma trận)
  const rowDct = new Float64Array(DCT_SIZE * 8);
  for (let y = 0; y < DCT_SIZE; y++) {
    const base = y * DCT_SIZE;
    for (let v = 0; v < 8; v++) {
      let sum = 0;
      const vOff = v * DCT_SIZE;
      for (let x = 0; x < DCT_SIZE; x++) {
        sum += sample[base + x] * DCT_COS[vOff + x];
      }
      rowDct[y * 8 + v] = sum;
    }
  }

  const coeffs = new Float64Array(64);
  for (let u = 0; u < 8; u++) {
    const uOff = u * DCT_SIZE;
    for (let v = 0; v < 8; v++) {
      let sum = 0;
      for (let y = 0; y < DCT_SIZE; y++) {
        sum += rowDct[y * 8 + v] * DCT_COS[uOff + y];
      }
      coeffs[u * 8 + v] = sum;
    }
  }

  // Bỏ hệ số DC coeffs[0], lấy trung vị của 63 hệ số AC
  const ac = Array.from(coeffs.slice(1)).sort((a, b) => a - b);
  const median = ac[Math.floor(ac.length / 2)] ?? 0;

  const bits = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    bits[i] = i === 0 ? 0 : coeffs[i] > median ? 1 : 0;
  }
  return nibblesToHex64(bits);
}

/**
 * Chia ảnh thành 3x3 lưới vùng con gối chồng 50% width/height để bắt cả ảnh bị cắt xén (crop).
 */
export function computeSubGridHashesFromGray(gray: Uint8Array, width: number, height: number): string[] {
  const hashes: string[] = [];
  const winW = Math.max(12, Math.floor(width * 0.5));
  const winH = Math.max(12, Math.floor(height * 0.5));
  const stepX = Math.max(1, Math.floor((width - winW) / 2));
  const stepY = Math.max(1, Math.floor((height - winH) / 2));
  for (let ry = 0; ry < 3; ry++) {
    const y0 = Math.min(Math.max(0, height - winH), ry * stepY);
    for (let rx = 0; rx < 3; rx++) {
      const x0 = Math.min(Math.max(0, width - winW), rx * stepX);
      hashes.push(computeDHashFromGrayRegion(gray, width, x0, y0, winW, winH));
    }
  }
  return hashes;
}

/** Histogram màu 24-bin chuẩn hóa L1 (8R + 8G + 8B) chịu được nén JPEG/WebP và lệch độ sáng nhẹ. */
export function computeColorHistogram24(rgba: Uint8ClampedArray | Uint8Array): number[] {
  const bins = new Float64Array(24);
  const totalPixels = Math.max(1, Math.floor(rgba.length / 4));
  for (let p = 0; p < totalPixels * 4; p += 4) {
    const rBin = Math.min(7, rgba[p] >> 5);
    const gBin = Math.min(7, rgba[p + 1] >> 5);
    const bBin = Math.min(7, rgba[p + 2] >> 5);
    bins[rBin] += 1;
    bins[8 + gBin] += 1;
    bins[16 + bBin] += 1;
  }
  const norm = totalPixels * 3;
  return Array.from(bins, (v) => Math.round((v / norm) * 10000) / 10000);
}

export function colorHistogramSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? Math.max(0, Math.min(1, dot / denom)) : 0;
}

export function matchDuplicateSignature(
  target: {
    dHash: string;
    pHash?: string;
    subGridHashes?: string[];
    colorHistogram?: number[];
  },
  candidate: DuplicateSignatureInput,
): DuplicateMatchResult {
  const dHashDist = hammingDistance(target.dHash, candidate.dHash);
  const pHashDist =
    target.pHash && candidate.pHash ? hammingDistance(target.pHash, candidate.pHash) : null;
  const colorSimilarity =
    target.colorHistogram && candidate.colorHistogram
      ? colorHistogramSimilarity(target.colorHistogram, candidate.colorHistogram)
      : null;

  let subGridMinDist: number | null = null;
  const checkBest = (d: number) => {
    subGridMinDist = subGridMinDist === null ? d : Math.min(subGridMinDist, d);
  };
  if (target.subGridHashes?.length && candidate.subGridHashes?.length) {
    for (const shA of target.subGridHashes) {
      for (const shB of candidate.subGridHashes) {
        checkBest(hammingDistance(shA, shB));
      }
    }
  }
  if (target.subGridHashes?.length) {
    for (const shA of target.subGridHashes) {
      checkBest(hammingDistance(shA, candidate.dHash));
    }
  }
  if (candidate.subGridHashes?.length) {
    for (const shB of candidate.subGridHashes) {
      checkBest(hammingDistance(target.dHash, shB));
    }
  }

  let isDuplicate = false;
  let reason: DuplicateMatchResult['reason'] = 'none';

  const colorOk = colorSimilarity === null || colorSimilarity >= 0.72;
  if (dHashDist <= 5) {
    isDuplicate = true;
    reason = 'dhash';
  } else if (pHashDist !== null && pHashDist <= 8 && colorOk) {
    isDuplicate = true;
    reason = 'phash';
  } else if (subGridMinDist !== null && subGridMinDist <= 4 && (colorSimilarity === null || colorSimilarity >= 0.78)) {
    isDuplicate = true;
    reason = 'subgrid_crop';
  }

  return {
    id: candidate.id,
    dHashDist,
    pHashDist,
    subGridMinDist,
    colorSimilarity,
    isDuplicate,
    reason,
  };
}

/**
 * Tính các chỉ số chất lượng ảnh + phát hiện ảnh chụp màn hình (screenshot) cục bộ.
 */
export function computeEdgeStatsAndScreenshot(
  gray: Uint8Array,
  width: number,
  height: number,
  aspect: number,
  hasCameraExif = false,
): LocalEdgeStats {
  const N = width * height;
  let brightSum = 0;
  for (let i = 0; i < N; i++) brightSum += gray[i];
  const brightness = brightSum / Math.max(1, N);

  let lapSum = 0;
  let lapSq = 0;
  let edgePixels = 0;
  let bimodalSharpEdges = 0;
  let totalInner = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
      lapSum += lap;
      lapSq += lap * lap;
      const gx = Math.abs(gray[i + 1] - gray[i - 1]);
      const gy = Math.abs(gray[i + width] - gray[i - width]);
      const grad = Math.max(gx, gy);
      if (grad >= 20) edgePixels += 1;
      // Cạnh UI kỹ thuật số có bước nhảy sắc 1px rất gắt (chữ, viền nút, khung app)
      const stepX = Math.max(Math.abs(gray[i] - gray[i - 1]), Math.abs(gray[i + 1] - gray[i]));
      const stepY = Math.max(Math.abs(gray[i] - gray[i - width]), Math.abs(gray[i + width] - gray[i]));
      if (grad >= 40 && Math.max(stepX, stepY) >= 40) {
        bimodalSharpEdges += 1;
      }
      totalInner += 1;
    }
  }
  const meanLap = lapSum / Math.max(1, totalInner);
  const blurScore = lapSq / Math.max(1, totalInner) - meanLap * meanLap;
  const sharpEdgeDensity = edgePixels > 0 ? bimodalSharpEdges / edgePixels : 0;

  let flat = 0;
  let blocks = 0;
  for (let by = 0; by + 8 <= height; by += 8) {
    for (let bx = 0; bx + 8 <= width; bx += 8) {
      let s = 0;
      let sq = 0;
      for (let dy = 0; dy < 8; dy++) {
        for (let dx = 0; dx < 8; dx++) {
          const v = gray[(by + dy) * width + bx + dx];
          s += v;
          sq += v * v;
        }
      }
      const variance = sq / 64 - (s / 64) ** 2;
      if (variance < 12) flat += 1;
      blocks += 1;
    }
  }
  const flatRatio = blocks ? flat / blocks : 0;

  const matchesScreenRatio = COMMON_SCREEN_RATIOS.some((r) => Math.abs(aspect - r) < 0.02);
  let conf = 0;
  if (!hasCameraExif) conf += 0.25;
  if (matchesScreenRatio) conf += 0.22;
  if (flatRatio > 0.55) conf += 0.35;
  else if (flatRatio > 0.4) conf += 0.16;
  if (sharpEdgeDensity > 0.42) conf += 0.32;
  else if (sharpEdgeDensity > 0.28) conf += 0.14;
  if (hasCameraExif) conf *= 0.35;

  const screenshotConfidence = Math.round(Math.min(1, conf) * 100) / 100;
  const likelyScreenshot = screenshotConfidence >= 0.65 || (flatRatio > 0.62 && sharpEdgeDensity > 0.35);

  return {
    blurScore,
    brightness,
    flatRatio,
    aspect,
    sharpEdgeDensity: Math.round(sharpEdgeDensity * 1000) / 1000,
    likelyScreenshot,
    screenshotConfidence,
  };
}

/**
 * So sánh ảnh Trước/Sau cục bộ bằng Windowed SSIM (8x8) + Structural Edge Diff (Sobel).
 * Tách riêng: `sceneMatchScore` (giữ nguyên bối cảnh) và `resolutionScore` (mức độ thay đổi hiện trường).
 */
export function computeSsimAndEdgeDiff(
  beforeGray: Uint8Array,
  afterGray: Uint8Array,
  width: number,
  height: number,
  thresholds: { sceneMatchThreshold?: number; resolutionThreshold?: number } = {},
): BeforeAfterSsimResult {
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;

  let ssimSum = 0;
  let upperSsimSum = 0;
  let upperCount = 0;
  let totalBlocks = 0;

  const halfY = Math.floor(height * 0.48);

  for (let by = 0; by + 8 <= height; by += 8) {
    for (let bx = 0; bx + 8 <= width; bx += 8) {
      let sumA = 0;
      let sumB = 0;
      let sqA = 0;
      let sqB = 0;
      let mulAB = 0;
      for (let dy = 0; dy < 8; dy++) {
        const row = (by + dy) * width + bx;
        for (let dx = 0; dx < 8; dx++) {
          const a = beforeGray[row + dx];
          const b = afterGray[row + dx];
          sumA += a;
          sumB += b;
          sqA += a * a;
          sqB += b * b;
          mulAB += a * b;
        }
      }
      const n = 64;
      const muA = sumA / n;
      const muB = sumB / n;
      const varA = Math.max(0, sqA / n - muA * muA);
      const varB = Math.max(0, sqB / n - muB * muB);
      const covAB = mulAB / n - muA * muB;

      const ssimBlock =
        ((2 * muA * muB + C1) * (2 * covAB + C2)) /
        ((muA * muA + muB * muB + C1) * (varA + varB + C2));
      ssimSum += ssimBlock;
      totalBlocks += 1;

      if (by + 8 <= halfY) {
        upperSsimSum += ssimBlock;
        upperCount += 1;
      }
    }
  }

  const ssim = Math.max(0, Math.min(1, ssimSum / Math.max(1, totalBlocks)));
  const upperBgRetention = Math.max(0, Math.min(1, upperSsimSum / Math.max(1, upperCount)));

  // Structural Edge Diff ở vùng trung tâm / hạ cảnh (nơi thường chứa sự cố rác thải, ổ gà, ngập)
  let edgeDiffSum = 0;
  let totalEdgeEnergy = 0;
  let roiChangedPixels = 0;
  let roiPixels = 0;

  const roiTop = Math.floor(height * 0.3);
  const roiLeft = Math.floor(width * 0.1);
  const roiRight = Math.floor(width * 0.9);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gBefore =
        Math.abs(beforeGray[i + 1] - beforeGray[i - 1]) +
        Math.abs(beforeGray[i + width] - beforeGray[i - width]);
      const gAfter =
        Math.abs(afterGray[i + 1] - afterGray[i - 1]) +
        Math.abs(afterGray[i + width] - afterGray[i - width]);
      edgeDiffSum += Math.abs(gBefore - gAfter);
      totalEdgeEnergy += Math.max(gBefore, gAfter, 1);

      if (y >= roiTop && x >= roiLeft && x < roiRight) {
        if (Math.abs(beforeGray[i] - afterGray[i]) >= 18 || Math.abs(gBefore - gAfter) >= 24) {
          roiChangedPixels += 1;
        }
        roiPixels += 1;
      }
    }
  }

  const edgeDiffRatio = Math.max(0, Math.min(1, edgeDiffSum / Math.max(1, totalEdgeEnergy)));
  const roiChangeRatio = roiPixels > 0 ? roiChangedPixels / roiPixels : 0;

  const sceneMatchScore = Math.round(
    Math.max(5, Math.min(99, upperBgRetention * 65 + ssim * 35)),
  );
  const resolutionScore = Math.round(
    Math.max(5, Math.min(98, 25 + edgeDiffRatio * 48 + roiChangeRatio * 42)),
  );

  const sceneThresh = thresholds.sceneMatchThreshold ?? 55;
  const resThresh = thresholds.resolutionThreshold ?? 55;
  const verified = sceneMatchScore >= sceneThresh && resolutionScore >= resThresh;

  const summary = verified
    ? `SSIM bối cảnh ${Math.round(upperBgRetention * 100)}% & thay đổi cấu trúc cạnh ${Math.round(edgeDiffRatio * 100)}% — đạt chuẩn nghiệm thu.`
    : sceneMatchScore < sceneThresh
      ? `Độ tương đồng bối cảnh SSIM (${sceneMatchScore}%) chưa đạt ngưỡng ${sceneThresh}%.`
      : `Mức thay đổi hiện trường theo Structural Edge Diff (${resolutionScore}%) chưa đạt ngưỡng ${resThresh}%.`;

  return {
    ssim: Math.round(ssim * 1000) / 1000,
    edgeDiffRatio: Math.round(edgeDiffRatio * 1000) / 1000,
    upperBgRetention: Math.round(upperBgRetention * 1000) / 1000,
    roiChangeRatio: Math.round(roiChangeRatio * 1000) / 1000,
    sceneMatchScore,
    resolutionScore,
    verified,
    summary,
  };
}
