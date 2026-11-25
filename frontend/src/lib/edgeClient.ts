import type { EdgeRequest, EdgeResponse } from '../workers/edgeProcessor.worker';
import { processImageInWorker, type ProcessedImageResult } from './imageProcessor';

export type { ProcessedImageResult };

type Distribute<T> = T extends unknown ? Omit<T, 'id'> : never;
type Payload = Distribute<EdgeRequest>;
type Reply<T extends EdgeResponse['type']> = Extract<EdgeResponse, { type: T }>;

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (r: EdgeResponse) => void; reject: (e: Error) => void; timer: number }>();

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('../workers/edgeProcessor.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (ev: MessageEvent<EdgeResponse>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    window.clearTimeout(p.timer);
    if (ev.data.type === 'error') p.reject(new Error(ev.data.message));
    else p.resolve(ev.data);
  };
  w.onerror = (ev) => {
    const err = new Error(ev.message || 'Edge Worker gặp lỗi');
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
}

function call<T extends EdgeResponse['type']>(msg: Payload, expect: T): Promise<Reply<T>> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error('Xử lý ảnh quá thời gian'));
    }, 25000);
    pending.set(id, {
      resolve: (r) => (r.type === expect ? resolve(r as Reply<T>) : reject(new Error('Phản hồi Worker không khớp'))),
      reject,
      timer,
    });
    ensureWorker().postMessage({ ...msg, id } as EdgeRequest);
  });
}

export const edge = {
  processImage: (blob: Blob): Promise<ProcessedImageResult> => processImageInWorker(blob),
  geoScan: (p: Omit<Extract<EdgeRequest, { type: 'geo' }>, 'id' | 'type'>) => call({ type: 'geo', ...p }, 'geo'),
  hammingMatch: (hash: string, known: Array<{ id: string; hash: string }>) => call({ type: 'hamming', hash, known }, 'hamming'),
  terminate: (): void => {
    worker?.terminate();
    worker = null;
  },
};
