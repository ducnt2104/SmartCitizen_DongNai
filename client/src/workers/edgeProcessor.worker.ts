/**
 * Edge Web Worker — chạy HOÀN TOÀN ngoài Main Thread:
 *  1) Nén ảnh bằng OffscreenCanvas về ≤ 1024px, JPEG quality 0.78
 *  2) Tính 64-bit dHash (9×8 grayscale)
 *  3) Chỉ số chất lượng cạnh (blur / độ phẳng / sáng) để phát hiện ảnh mờ, ảnh chụp màn hình
 *  4) Quét trùng Haversine 50m + khớp trục huyết mạch + Bounding Box
 *  5) So khớp Hamming với các hash đã biết
 * Không import DOM/React; chỉ dùng hàm thuần từ /shared.
 */
import { CLUSTER_RADIUS_M } from '@shared/constants';
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

export type EdgeRequest =
  | { id: number; type: 'process'; blob: Blob }
  | {
      id: number;
      type: 'geo';
      lat: number;
      lng: number;
      category: string | null;
      candidates: Array<{ id: string; lat: number; lng: number; category: string; status: string; clusterCount: number }>;
    }
  | { id: number; type: 'hamming'; hash: string; known: Array<{ id: string; hash: string }> };

export type EdgeResponse =
  | {
      id: number;
      type: 'processed';
      dataUrl: string;
      dHash: string;
      width: number;
      height: number;
      originalBytes: number;
      bytes: number;
      stats: EdgeStatsMsg;
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

const MAX_SIDE = 1024;
const QUALITY = 0.78;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
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
  // Phương sai Laplacian (độ nét)
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
  // Tỷ lệ khối 8×8 gần như phẳng (ảnh chụp màn hình/ảnh trơn có rất nhiều khối phẳng)
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

async function processImage(id: number, blob: Blob): Promise<EdgeResponse> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    return { id, type: 'error', unsupported: true, message: 'Trình duyệt chưa hỗ trợ OffscreenCanvas trong Web Worker.' };
  }
  const t0 = performance.now();
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const width = Math.max(1, Math.round(bmp.width * scale));
  const height = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d');
  if (!g) throw new Error('Không tạo được ngữ cảnh 2D trong Worker');
  g.drawImage(bmp, 0, 0, width, height);
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: QUALITY });
  const bytes = new Uint8Array(await out.arrayBuffer());
  const t1 = performance.now();
  const dHash = dHash64(canvas);
  const hashMs = performance.now() - t1;
  const stats = edgeStats(canvas, bmp.width / bmp.height);
  bmp.close();
  return {
    id, type: 'processed',
    dataUrl: `data:image/jpeg;base64,${bytesToBase64(bytes)}`,
    dHash, width, height, originalBytes: blob.size, bytes: bytes.length, stats,
    timings: { totalMs: performance.now() - t0, hashMs },
  };
}

function geoScan(req: Extract<EdgeRequest, { type: 'geo' }>): EdgeResponse {
  const nearby = req.candidates
    .filter((c) => (req.category ? c.category === req.category : true) && ['received', 'verifying', 'processing'].includes(c.status))
    .map((c) => ({ id: c.id, distanceM: haversineMeters(req.lat, req.lng, c.lat, c.lng), clusterCount: c.clusterCount }))
    .filter((c) => c.distanceM <= CLUSTER_RADIUS_M)
    .sort((a, b) => a.distanceM - b.distanceM);
  const w = nearestWard(req.lat, req.lng);
  return {
    id: req.id, type: 'geo', inBounds: inDongNaiBBox(req.lat, req.lng),
    ward: { wardCode: w.wardCode, name: w.name }, arterial: matchArterial(req.lat, req.lng), nearby,
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
        id: req.id, type: 'hamming',
        matches: req.known.map((k) => ({ id: k.id, distance: hammingDistance(req.hash, k.hash) })).sort((a, b) => a.distance - b.distance),
      });
    }
  } catch (err) {
    fail(err);
  }
};
