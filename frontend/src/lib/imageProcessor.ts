/**
 * Client Image Pipeline Controller:
 *  - Điều phối `imageProcessor.worker.ts` qua Transferable ArrayBuffer (zero-copy).
 *  - Có Main-Thread HTMLCanvas fallback sạch sẽ nếu trình duyệt không hỗ trợ OffscreenCanvas/Worker.
 *  - Sinh song song `aiBlob` (<=640px WebP ~25-55KB) + `displayBlob` (<=1280px WebP ~80-180KB) + 64-bit dHash + EXIF.
 */
import {
  extractExifMetadata,
  type EdgeStatsMsg,
  type ExifGpsCoords,
  type ExtractedExifMetadata,
  type ImageProcessorRequest,
  type ImageProcessorResponse,
} from '../workers/imageProcessor.worker';

export type { EdgeStatsMsg, ExifGpsCoords, ExtractedExifMetadata };

export interface ProcessedImageResult {
  aiBlob: Blob;
  aiMimeType: string;
  displayBlob: Blob;
  displayMimeType: string;
  /** Preview URL tạo bằng URL.createObjectURL (hoặc fallback), không giữ base64 trong React state */
  previewUrl: string;
  dHash: string;
  width: number;
  height: number;
  originalBytes: number;
  aiBytes: number;
  displayBytes: number;
  bytes: number;
  stats: EdgeStatsMsg;
  exif: ExtractedExifMetadata;
  exifGps: ExifGpsCoords | null;
  timings: { totalMs: number; hashMs: number };
}

let worker: Worker | null = null;
let workerUnsupported = typeof Worker === 'undefined';
let seq = 0;

const pending = new Map<
  number,
  {
    resolve: (res: Extract<ImageProcessorResponse, { type: 'processed' }>) => void;
    reject: (err: Error & { unsupported?: boolean }) => void;
    timer: number;
  }
>();

function ensureImageWorker(): Worker | null {
  if (workerUnsupported || typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    const w = new Worker(new URL('../workers/imageProcessor.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<ImageProcessorResponse>) => {
      const p = pending.get(ev.data.id);
      if (!p) return;
      pending.delete(ev.data.id);
      window.clearTimeout(p.timer);
      if (ev.data.type === 'error') {
        const err = Object.assign(new Error(ev.data.message), { unsupported: ev.data.unsupported });
        p.reject(err);
      } else {
        p.resolve(ev.data);
      }
    };
    w.onerror = (ev) => {
      const err = new Error(ev.message || 'ImageProcessor Worker gặp lỗi');
      for (const [id, p] of pending) {
        window.clearTimeout(p.timer);
        p.reject(err);
        pending.delete(id);
      }
      w.terminate();
      worker = null;
    };
    worker = w;
    return w;
  } catch {
    workerUnsupported = true;
    return null;
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

async function encodeCanvasFallback(canvas: HTMLCanvasElement, quality: number): Promise<{ blob: Blob; mimeType: string }> {
  const webp = await canvasToBlob(canvas, 'image/webp', quality);
  if (webp && webp.type === 'image/webp' && webp.size > 0) {
    return { blob: webp, mimeType: 'image/webp' };
  }
  const jpg = await canvasToBlob(canvas, 'image/jpeg', quality);
  if (jpg && jpg.size > 0) {
    return { blob: jpg, mimeType: 'image/jpeg' };
  }
  throw new Error('Trình duyệt không hỗ trợ nén ảnh Canvas');
}

function loadHtmlImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Không đọc được tệp ảnh đầu vào'));
    img.src = url;
  });
}

function computeFallbackDHashAndStats(aiCanvas: HTMLCanvasElement, aspect: number): { dHash: string; stats: EdgeStatsMsg } {
  const hashCanvas = document.createElement('canvas');
  hashCanvas.width = 9;
  hashCanvas.height = 8;
  const hg = hashCanvas.getContext('2d', { willReadFrequently: true });
  if (!hg) throw new Error('Không tạo được Canvas 2D fallback');
  hg.drawImage(aiCanvas, 0, 0, 9, 8);
  const hData = hg.getImageData(0, 0, 9, 8).data;
  const gray9x8 = new Float32Array(72);
  for (let i = 0, p = 0; i < 72; i++, p += 4) {
    gray9x8[i] = 0.299 * hData[p] + 0.587 * hData[p + 1] + 0.114 * hData[p + 2];
  }
  const nibbles: number[] = [];
  let cur = 0;
  let bits = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      cur = (cur << 1) | (gray9x8[y * 9 + x] > gray9x8[y * 9 + x + 1] ? 1 : 0);
      bits += 1;
      if (bits === 4) {
        nibbles.push(cur);
        cur = 0;
        bits = 0;
      }
    }
  }
  const dHash = nibbles.map((n) => n.toString(16)).join('');

  const W = 128;
  const H = Math.max(16, Math.round(W / Math.max(0.1, aspect)));
  const statCanvas = document.createElement('canvas');
  statCanvas.width = W;
  statCanvas.height = H;
  const sg = statCanvas.getContext('2d', { willReadFrequently: true });
  if (!sg) throw new Error('Không tạo được Canvas 2D fallback');
  sg.drawImage(aiCanvas, 0, 0, W, H);
  const sData = sg.getImageData(0, 0, W, H).data;
  const g = new Float32Array(W * H);
  let sum = 0;
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    const lum = 0.299 * sData[p] + 0.587 * sData[p + 1] + 0.114 * sData[p + 2];
    g[i] = lum;
    sum += lum;
  }
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
      n += 1;
    }
  }
  const mean = lapSum / Math.max(1, n);
  const blurScore = lapSq / Math.max(1, n) - mean * mean;
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
      if (sq / 64 - (s / 64) ** 2 < 12) flat += 1;
      blocks += 1;
    }
  }
  return { dHash, stats: { blurScore, brightness, flatRatio: blocks ? flat / blocks : 0, aspect } };
}

async function processImageCanvasFallback(blob: Blob, rawBuf: ArrayBuffer): Promise<ProcessedImageResult> {
  const t0 = performance.now();
  const exif = extractExifMetadata(rawBuf);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await loadHtmlImage(objectUrl);
    const natW = Math.max(1, img.naturalWidth || img.width);
    const natH = Math.max(1, img.naturalHeight || img.height);

    const makeScaled = (maxEdge: number): { canvas: HTMLCanvasElement; width: number; height: number } => {
      const scale = Math.min(1, maxEdge / Math.max(natW, natH));
      const width = Math.max(1, Math.round(natW * scale));
      const height = Math.max(1, Math.round(natH * scale));
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      const g = c.getContext('2d');
      if (!g) throw new Error('Không tạo được Canvas 2D');
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, width, height);
      return { canvas: c, width, height };
    };

    const disp = makeScaled(1280);
    const ai = makeScaled(640);
    const [dispEnc, aiEnc] = await Promise.all([
      encodeCanvasFallback(disp.canvas, 0.8),
      encodeCanvasFallback(ai.canvas, 0.72),
    ]);
    const t1 = performance.now();
    const { dHash, stats } = computeFallbackDHashAndStats(ai.canvas, natW / natH);
    const hashMs = performance.now() - t1;
    return {
      aiBlob: aiEnc.blob,
      aiMimeType: aiEnc.mimeType,
      displayBlob: dispEnc.blob,
      displayMimeType: dispEnc.mimeType,
      previewUrl: URL.createObjectURL(dispEnc.blob),
      dHash,
      width: disp.width,
      height: disp.height,
      originalBytes: blob.size,
      aiBytes: aiEnc.blob.size,
      displayBytes: dispEnc.blob.size,
      bytes: dispEnc.blob.size,
      stats,
      exif,
      exifGps: exif.gps,
      timings: { totalMs: performance.now() - t0, hashMs },
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function processImageInWorker(blob: Blob): Promise<ProcessedImageResult> {
  const rawBuf = await blob.arrayBuffer();
  const w = ensureImageWorker();
  if (!w) {
    return processImageCanvasFallback(blob, rawBuf);
  }

  try {
    const transferBuf = rawBuf.slice(0);
    const res = await new Promise<Extract<ImageProcessorResponse, { type: 'processed' }>>((resolve, reject) => {
      const id = ++seq;
      const timer = window.setTimeout(() => {
        pending.delete(id);
        reject(new Error('Xử lý ảnh trong Web Worker quá thời gian'));
      }, 20_000);
      pending.set(id, { resolve, reject, timer });
      const req: ImageProcessorRequest = {
        id,
        type: 'process',
        buffer: transferBuf,
        mimeType: blob.type || 'image/jpeg',
        size: blob.size,
      };
      w.postMessage(req, [transferBuf]);
    });

    const aiBlob = new Blob([res.aiBuffer], { type: res.aiMimeType });
    const displayBlob = new Blob([res.displayBuffer], { type: res.displayMimeType });
    return {
      aiBlob,
      aiMimeType: res.aiMimeType,
      displayBlob,
      displayMimeType: res.displayMimeType,
      previewUrl: URL.createObjectURL(displayBlob),
      dHash: res.dHash,
      width: res.width,
      height: res.height,
      originalBytes: res.originalBytes,
      aiBytes: res.aiBytes,
      displayBytes: res.displayBytes,
      bytes: res.displayBytes,
      stats: res.stats,
      exif: res.exif,
      exifGps: res.exif.gps,
      timings: res.timings,
    };
  } catch (err) {
    if (err && typeof err === 'object' && 'unsupported' in err && (err as { unsupported?: boolean }).unsupported) {
      workerUnsupported = true;
      worker?.terminate();
      worker = null;
      return processImageCanvasFallback(blob, rawBuf);
    }
    throw err;
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Không đọc được dữ liệu ảnh'));
    reader.readAsDataURL(blob);
  });
}

export function terminateImageWorker(): void {
  worker?.terminate();
  worker = null;
}
