import { describe, expect, it } from 'vitest';
import {
  colorHistogramSimilarity,
  computeColorHistogram24,
  computeDHashFromGrayRegion,
  computeEdgeStatsAndScreenshot,
  computePHashFromGray,
  computeSsimAndEdgeDiff,
  computeSubGridHashesFromGray,
  matchDuplicateSignature,
  rgbaToGray,
} from '../lib/localCvMath';

function makeNaturalSceneGray(w: number, h: number, withDefectCenter = false): Uint8Array {
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Nền kiến trúc + cây cối bán tự nhiên ở phần trên (0..45%)
      const upperPattern =
        y < h * 0.45
          ? 125 + Math.round(28 * Math.sin(x * 0.25) + 18 * Math.cos(y * 0.35))
          : 155 + Math.round(10 * Math.sin((x + y) * 0.12));
      let val = upperPattern;
      if (withDefectCenter && y >= h * 0.5 && y <= h * 0.85 && x >= w * 0.25 && x <= w * 0.75) {
        val = 38 + (((x * 13 + y * 7) % 5) * 14);
      }
      gray[y * w + x] = Math.max(0, Math.min(255, val));
    }
  }
  return gray;
}

describe('Client Edge CV Math (pHash DCT, Sub-Grid Crop, Screenshot Forensics, SSIM + Edge Diff)', () => {
  it('tính pHash (2D-DCT), dHash, 3x3 sub-grid & Color Histogram bắt chính xác ảnh trùng và ảnh cắt góc', () => {
    const W = 96;
    const H = 96;
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        rgba[i] = (x * 3 + y) % 255;
        rgba[i + 1] = 110 + Math.round(40 * Math.sin(x * 0.2));
        rgba[i + 2] = 90 + Math.round(30 * Math.cos(y * 0.25));
        rgba[i + 3] = 255;
      }
    }
    const gray = rgbaToGray(rgba, W, H);
    const dHash = computeDHashFromGrayRegion(gray, W, 0, 0, W, H);
    const pHash = computePHashFromGray(gray, W, H);
    const subGrid = computeSubGridHashesFromGray(gray, W, H);
    const hist = computeColorHistogram24(rgba);

    expect(dHash).toMatch(/^[0-9a-f]{16}$/);
    expect(pHash).toMatch(/^[0-9a-f]{16}$/);
    expect(subGrid).toHaveLength(9);
    expect(hist).toHaveLength(24);
    expect(colorHistogramSimilarity(hist, hist)).toBeCloseTo(1, 3);

    // Giả lập người dùng cắt 1 ô 50% từ góc ảnh gốc làm ảnh "mới"
    const cropGray = new Uint8Array(48 * 48);
    for (let y = 0; y < 48; y++) {
      for (let x = 0; x < 48; x++) {
        cropGray[y * 48 + x] = gray[y * W + x];
      }
    }
    const cropDHash = computeDHashFromGrayRegion(cropGray, 48, 0, 0, 48, 48);
    const cropSubGrid = computeSubGridHashesFromGray(cropGray, 48, 48);
    const dupMatch = matchDuplicateSignature(
      { dHash, pHash, subGridHashes: subGrid, colorHistogram: hist },
      { id: 'r-crop', dHash: cropDHash, subGridHashes: cropSubGrid, colorHistogram: hist },
    );
    expect(dupMatch.isDuplicate).toBe(true);
  });

  it('phát hiện ảnh chụp màn hình cục bộ (tỷ lệ màn hình + thiếu EXIF + nhiều vùng phẳng + cạnh UI gắt)', () => {
    const W = 96;
    const H = 192;
    const uiGray = new Uint8Array(W * H).fill(248);
    // Vẽ khung chữ nhật UI đen sắc nét trên nền trắng phẳng đặc trưng screenshot app
    for (let y = 40; y < 80; y++) {
      for (let x = 16; x < 80; x++) {
        if (y === 40 || y === 79 || x === 16 || x === 79) uiGray[y * W + x] = 20;
      }
    }
    const screenStats = computeEdgeStatsAndScreenshot(uiGray, W, H, W / H, false);
    expect(screenStats.likelyScreenshot).toBe(true);
    expect(screenStats.screenshotConfidence).toBeGreaterThanOrEqual(0.65);

    const realScene = makeNaturalSceneGray(120, 90, true);
    const camStats = computeEdgeStatsAndScreenshot(realScene, 120, 90, 120 / 90, true);
    expect(camStats.likelyScreenshot).toBe(false);
    expect(camStats.screenshotConfidence).toBeLessThan(0.4);
  });

  it('đối chiếu Trước/Sau bằng Windowed SSIM + Structural Edge Diff phân tách rõ sceneMatch & resolution', () => {
    const W = 96;
    const H = 96;
    const beforeDefect = makeNaturalSceneGray(W, H, true);
    const afterCleared = makeNaturalSceneGray(W, H, false);

    const res = computeSsimAndEdgeDiff(beforeDefect, afterCleared, W, H, {
      sceneMatchThreshold: 55,
      resolutionThreshold: 55,
    });
    expect(res.upperBgRetention).toBeGreaterThan(0.9);
    expect(res.edgeDiffRatio).toBeGreaterThan(0.35);
    expect(res.sceneMatchScore).toBeGreaterThanOrEqual(75);
    expect(res.resolutionScore).toBeGreaterThanOrEqual(55);
    expect(res.verified).toBe(true);
  });
});
