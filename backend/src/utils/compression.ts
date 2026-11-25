import compression from 'compression';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import zlib from 'node:zlib';

const DEFAULT_THRESHOLD = 512;

function shouldSkipCompression(req: Request, res: Response): boolean {
  if (req.method === 'HEAD') return true;
  if (req.path === '/api/ai/chat' || req.path === '/api/chat' || req.path === '/api/auth/session-events' || req.path.startsWith('/api/media/')) return true;
  if (res.getHeader('Content-Encoding')) return true;
  const ct = String(res.getHeader('Content-Type') ?? '');
  if (ct.startsWith('image/') || ct.startsWith('video/') || ct.includes('text/event-stream')) return true;
  return false;
}

/**
 * Middleware nén đa chuẩn tốc độ cao:
 *  - Ưu tiên **Brotli (`br`)** (quality 4: tỷ lệ nén cao hơn Gzip 15–25%, tốc độ < 2ms trên JSON/HTML/JS)
 *  - Tự động fallback sang **Gzip / Deflate** khi client không quảng cáo `br`
 *  - Bỏ qua SSE stream (`/api/ai/chat`) và ảnh WebP đã nén (`/api/media/*`)
 */
export function smartCompressionMiddleware(): RequestHandler {
  const gzipFallback = compression({
    level: 6,
    threshold: DEFAULT_THRESHOLD,
    filter: (req, res) => {
      if (shouldSkipCompression(req, res)) return false;
      return compression.filter(req, res);
    },
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    if (shouldSkipCompression(req, res)) {
      next();
      return;
    }

    const ae = String(req.headers['accept-encoding'] ?? '');
    if (!/\bbr\b/i.test(ae)) {
      gzipFallback(req, res, next);
      return;
    }

    let decided = false;
    let brotliStream: zlib.BrotliCompress | null = null;
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    const origOn = res.on.bind(res);

    const pendingChunks: Array<{ chunk: Buffer; encoding?: BufferEncoding }> = [];

    const setupBrotli = (): zlib.BrotliCompress => {
      const stream = zlib.createBrotliCompress({
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
        },
      });
      res.removeHeader('Content-Length');
      res.setHeader('Content-Encoding', 'br');
      res.append?.('Vary', 'Accept-Encoding');

      stream.on('data', (compressed: Buffer) => {
        origWrite(compressed);
      });
      stream.on('end', () => {
        origEnd();
      });
      res.once('close', () => {
        if (!stream.destroyed) stream.destroy();
      });
      return stream;
    };

    const flushDecision = (finalChunk?: Buffer): boolean => {
      if (decided) return true;
      decided = true;

      if (res.statusCode === 204 || res.statusCode === 304 || shouldSkipCompression(req, res)) {
        return false;
      }

      const ct = String(res.getHeader('Content-Type') ?? '').toLowerCase();
      const compressibleType =
        !ct ||
        /(?:text\/|json|javascript|ecmascript|xml|svg\+xml|x-font|wasm)/i.test(ct);
      if (!compressibleType) return false;

      const bufferedLen =
        pendingChunks.reduce((acc, c) => acc + c.chunk.byteLength, 0) + (finalChunk?.byteLength ?? 0);
      const declaredLen = Number(res.getHeader('Content-Length') ?? 0);
      if (finalChunk && bufferedLen < DEFAULT_THRESHOLD && declaredLen < DEFAULT_THRESHOLD) {
        return false;
      }

      brotliStream = setupBrotli();
      for (const item of pendingChunks.splice(0)) {
        brotliStream.write(item.chunk);
      }
      return true;
    };

    res.write = ((
      chunk: unknown,
      encodingOrCb?: BufferEncoding | ((error: Error | null | undefined) => void),
      cb?: (error: Error | null | undefined) => void,
    ): boolean => {
      if (!chunk) return true;
      const enc = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), enc ?? 'utf8');

      if (!decided) {
        pendingChunks.push({ chunk: buf, encoding: enc });
        const bufferedLen = pendingChunks.reduce((acc, c) => acc + c.chunk.byteLength, 0);
        if (bufferedLen >= DEFAULT_THRESHOLD) {
          if (flushDecision()) {
            callback?.(null);
            return true;
          }
          for (const item of pendingChunks.splice(0)) {
            origWrite(item.chunk);
          }
          callback?.(null);
          return true;
        }
        callback?.(null);
        return true;
      }

      if (brotliStream) {
        return brotliStream.write(buf, callback as never);
      }
      return origWrite(buf, callback as never);
    }) as Response['write'];

    res.end = ((
      chunk?: unknown,
      encodingOrCb?: BufferEncoding | (() => void),
      cb?: () => void,
    ): Response => {
      const enc = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
      const finalBuf =
        chunk !== undefined && chunk !== null && typeof chunk !== 'function'
          ? Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(String(chunk), enc ?? 'utf8')
          : undefined;

      if (!decided) {
        if (flushDecision(finalBuf)) {
          if (finalBuf && finalBuf.byteLength > 0) {
            brotliStream!.write(finalBuf);
          }
          if (callback) res.once('finish', callback);
          brotliStream!.end();
          return res;
        }
        for (const item of pendingChunks.splice(0)) {
          origWrite(item.chunk);
        }
        return origEnd(finalBuf ?? (undefined as never), callback as never);
      }

      if (brotliStream) {
        if (finalBuf && finalBuf.byteLength > 0) brotliStream.write(finalBuf);
        if (callback) res.once('finish', callback);
        brotliStream.end();
        return res;
      }

      return origEnd(finalBuf ?? (undefined as never), callback as never);
    }) as Response['end'];

    // Giữ nguyên `.on`
    res.on = origOn;
    next();
  };
}
