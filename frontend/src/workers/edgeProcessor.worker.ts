/**
 * Edge Web Worker — chạy HOÀN TOÀN ngoài Main Thread (60FPS):
 *  1) Trích xuất tọa độ EXIF GPS từ ảnh JPEG gốc TRƯỚC KHI nén (không cần thư viện ngoài)
 *  2) Nén ảnh bằng OffscreenCanvas về ≤ 1600px, ưu tiên WebP (fallback JPEG) quality 0.80 (giảm 70–85% dung lượng)
 *  3) Tính 64-bit dHash (9×8 grayscale)
 *  4) Chỉ số chất lượng cạnh (blur / độ phẳng / sáng)
 *  5) Quét trùng Haversine 100m + khớp trục huyết mạch + Bounding Box toàn Thành phố Đồng Nai
 *  6) So khớp Hamming với các hash đã biết
 */
import { DUPLICATE_SCAN_RADIUS_M } from '@shared/constants';
import { normalizeCoordinates } from '@shared/coordinates';
import { hammingDistance } from '@shared/dhash';
import { haversineMeters, inDongNaiBBox, matchArterial, nearestWard } from '@shared/geo';

interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}
const ctx = self as unknown as WorkerScope;

export interface EdgeStatsMsg {
  blurScore: number;
  brightness: number;
  flatRatio: number;
  aspect: number;
}

export interface ExifGpsCoords {
  lat: number;
  lng: number;
  inBounds: boolean;
}

export type EdgeRequest =
  | { id: number; type: 'process'; blob: Blob }
  | {
      id: number;
      type: 'geo';
      lat: number;
      lng: number;
      category: string | null;
      radiusM?: number;
      candidates: Array<{ id: string; lat: number; lng: number; category: string; status: string; clusterCount: number }>;
    }
  | { id: number; type: 'hamming'; hash: string; known: Array<{ id: string; hash: string }> };

export type EdgeResponse =
  | {
      id: number;
      type: 'processed';
      dataUrl: string;
      mimeType: string;
      dHash: string;
      width: number;
      height: number;
      originalBytes: number;
      bytes: number;
      stats: EdgeStatsMsg;
      exifGps: ExifGpsCoords | null;
      timings: { totalMs: number; hashMs: number };
    }
  | {
      id: number;
      type: 'geo';
      inBounds: boolean;
      ward: { wardCode: string; name: string };
      arterial: { name: string; distanceM: number } | null;
      nearby: Array<{ id: string; distanceM: number; clusterCount: number }>;
    }
  | { id: number; type: 'hamming'; matches: Array<{ id: string; distance: number }> }
  | { id: number; type: 'error'; message: string; unsupported?: boolean };

const MAX_SIDE = 1280;
const QUALITY = 0.8;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

/**
 * Parser EXIF GPS thuần nhẹ cho ảnh JPEG (đọc APP1 -> TIFF IFD0 -> GPS IFD tag 0x8825).
 * An toàn với mọi file không phải JPEG hoặc thiếu EXIF (trả về null).
 */
function extractExifGps(buf: ArrayBuffer): ExifGpsCoords | null {
  try {
    const view = new DataView(buf);
    if (view.byteLength < 12 || view.getUint16(0, false) !== 0xffd8) return null;
    let offset = 2;
    while (offset + 4 < view.byteLength) {
      const marker = view.getUint16(offset, false);
      offset += 2;
      if (marker === 0xffda || marker === 0xffd9) break;
      const segLen = view.getUint16(offset, false);
      if (segLen < 2 || offset + segLen > view.byteLength) break;
      if (marker === 0xffe1 && segLen >= 16) {
        // Kiểm tra header "Exif\0\0"
        if (view.getUint32(offset + 2, false) === 0x45786966 && view.getUint16(offset + 6, false) === 0x0000) {
          const tiffStart = offset + 8;
          const little = view.getUint16(tiffStart, false) === 0x4949;
          const firstIfd = view.getUint32(tiffStart + 4, little);
          const ifd0 = tiffStart + firstIfd;
          if (ifd0 + 2 > view.byteLength) return null;
          const entries = view.getUint16(ifd0, little);
          let gpsIfdOffset = 0;
          for (let i = 0; i < entries; i++) {
            const eOff = ifd0 + 2 + i * 12;
            if (eOff + 12 > view.byteLength) break;
            if (view.getUint16(eOff, little) === 0x8825) {
              gpsIfdOffset = view.getUint32(eOff + 8, little);
              break;
            }
          }
          if (!gpsIfdOffset) return null;
          const gpsStart = tiffStart + gpsIfdOffset;
          if (gpsStart + 2 > view.byteLength) return null;
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
          if (!latVals || !lngVals) return null;
          let lat = latVals[0] + latVals[1] / 60 + latVals[2] / 3600;
          let lng = lngVals[0] + lngVals[1] / 60 + lngVals[2] / 3600;
          if (latRef === 'S') lat = -lat;
          if (lngRef === 'W') lng = -lng;
          const norm = normalizeCoordinates({ lat, lng }, { requireVietnam: false });
          if (!norm.ok) return null;
          return { lat: norm.lat, lng: norm.lng, inBounds: inDongNaiBBox(norm.lat, norm.lng) };
        }
      }
      offset += segLen;
    }
  } catch {
    return null;
  }
  return null;
}

function grayscaleOf(source: ImageBitmap | OffscreenCanvas, w: number, h: number): Float32Array {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('Không tạo được ngữ cảnh 2D trong Worker');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, 0, 0, w, h);
  const { data } = g.getImageData(0, 0, w, h);
  const out = new Float32Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  return out;
}

/** dHash 64-bit: so sánh pixel liền kề trên lưới 9×8 → 64 bit → 16 ký tự hex. */
function dHash64(source: ImageBitmap | OffscreenCanvas): string {
  const gray = grayscaleOf(source, 9, 8);
  const nibbles: number[] = [];
  let cur = 0;
  let bits = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      cur = (cur << 1) | (gray[y * 9 + x] > gray[y * 9 + x + 1] ? 1 : 0);
      bits++;
      if (bits === 4) {
        nibbles.push(cur);
        cur = 0;
        bits = 0;
      }
    }
  }
  return nibbles.map((n) => n.toString(16)).join('');
}

function edgeStats(source: ImageBitmap | OffscreenCanvas, aspect: number): EdgeStatsMsg {
  const W = 128;
  const H = Math.max(16, Math.round(W / aspect));
  const g = grayscaleOf(source, W, H);
  let sum = 0;
  for (let i = 0; i < g.length; i++) sum += g[i];
  const brightness = sum / g.length;
  let lapSum = 0;
  let lapSq = 0;
  let n = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - W] - g[i + W];
      lapSum += lap;
      lapSq += lap * lap;
      n++;
    }
  }
  const mean = lapSum / n;
  const blurScore = lapSq / n - mean * mean;
  let flat = 0;
  let blocks = 0;
  for (let by = 0; by + 8 <= H; by += 8) {
    for (let bx = 0; bx + 8 <= W; bx += 8) {
      let s = 0;
      let sq = 0;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const v = g[(by + y) * W + bx + x];
          s += v;
          sq += v * v;
        }
      }
      const variance = sq / 64 - (s / 64) ** 2;
      if (variance < 12) flat++;
      blocks++;
    }
  }
  return { blurScore, brightness, flatRatio: blocks ? flat / blocks : 0, aspect };
}

async function encodeCompressed(canvas: OffscreenCanvas): Promise<{ blob: Blob; mimeType: string }> {
  try {
    const webp = await canvas.convertToBlob({ type: 'image/webp', quality: QUALITY });
    if (webp.type === 'image/webp' && webp.size > 0) return { blob: webp, mimeType: 'image/webp' };
  } catch {
    // Fallback sang JPEG nếu trình duyệt không hỗ trợ WebP encode trong OffscreenCanvas
  }
  const jpg = await canvas.convertToBlob({ type: 'image/jpeg', quality: QUALITY });
  return { blob: jpg, mimeType: 'image/jpeg' };
}

async function processImage(id: number, blob: Blob): Promise<EdgeResponse> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    return { id, type: 'error', unsupported: true, message: 'Trình duyệt chưa hỗ trợ OffscreenCanvas trong Web Worker.' };
  }
  const t0 = performance.now();
  // Trích xuất EXIF GPS từ ảnh gốc trước khi nén
  const rawBuf = await blob.arrayBuffer();
  const exifGps = extractExifGps(rawBuf);

  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const width = Math.max(1, Math.round(bmp.width * scale));
  const height = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d');
  if (!g) throw new Error('Không tạo được ngữ cảnh 2D trong Worker');
  g.drawImage(bmp, 0, 0, width, height);
  const { blob: out, mimeType } = await encodeCompressed(canvas);
  const bytes = new Uint8Array(await out.arrayBuffer());
  const t1 = performance.now();
  const dHash = dHash64(canvas);
  const hashMs = performance.now() - t1;
  const stats = edgeStats(canvas, bmp.width / bmp.height);
  bmp.close();
  return {
    id,
    type: 'processed',
    dataUrl: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
    mimeType,
    dHash,
    width,
    height,
    originalBytes: blob.size,
    bytes: bytes.length,
    stats,
    exifGps,
    timings: { totalMs: performance.now() - t0, hashMs },
  };
}

function geoScan(req: Extract<EdgeRequest, { type: 'geo' }>): EdgeResponse {
  const radius = req.radiusM ?? DUPLICATE_SCAN_RADIUS_M;
  const nearby = req.candidates
    .filter((c) => (req.category ? c.category === req.category : true) && ['received', 'verifying', 'processing'].includes(c.status))
    .map((c) => ({ id: c.id, distanceM: haversineMeters(req.lat, req.lng, c.lat, c.lng), clusterCount: c.clusterCount }))
    .filter((c) => c.distanceM <= radius)
    .sort((a, b) => a.distanceM - b.distanceM);
  const w = nearestWard(req.lat, req.lng);
  return {
    id: req.id,
    type: 'geo',
    inBounds: inDongNaiBBox(req.lat, req.lng),
    ward: { wardCode: w.wardCode, name: w.name },
    arterial: matchArterial(req.lat, req.lng),
    nearby,
  };
}

ctx.onmessage = (ev: MessageEvent<EdgeRequest>) => {
  const req = ev.data;
  const reply = (r: EdgeResponse): void => ctx.postMessage(r);
  const fail = (err: unknown): void =>
    reply({ id: req.id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  try {
    if (req.type === 'process') {
      processImage(req.id, req.blob).then(reply).catch(fail);
    } else if (req.type === 'geo') {
      reply(geoScan(req));
    } else {
      reply({
        id: req.id,
        type: 'hamming',
        matches: req.known.map((k) => ({ id: k.id, distance: hammingDistance(req.hash, k.hash) })).sort((a, b) => a.distance - b.distance),
      });
    }
  } catch (err) {
    fail(err);
  }
};
