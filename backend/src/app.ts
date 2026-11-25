import compression from 'compression';
import cors from 'cors';
import express, { type Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import helmet from 'helmet';
import { env } from './config/env';
import { limits } from './middleware/rateLimit';
import { errorHandler, sanitizeInput } from './middleware/validate';
import { buildRouter } from './routes';
import type { Services } from './services/container';

const STATIC_ASSET_EXT_RE = /\.(?:js|mjs|cjs|css|map|wasm|json|webmanifest|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|eot)$/i;

export function createApp(
  s: Services,
  bootInfo: { fallbackReason: string | null; dbState?: string; lastError?: string | null },
): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render đặt sau reverse proxy

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'script-src': [
            "'self'",
            'https://maps.googleapis.com',
            'https://maps.gstatic.com',
          ],
          'img-src': [
            "'self'",
            'data:',
            'blob:',
            'https://*.googleapis.com',
            'https://*.gstatic.com',
            'https://*.google.com',
            'https://*.ggpht.com',
            'https://*.tile.openstreetmap.org',
            'https://*.basemaps.cartocdn.com',
            'https://server.arcgisonline.com',
          ],
          'connect-src': [
            "'self'",
            'https://*.googleapis.com',
            'https://*.gstatic.com',
            'https://*.google.com',
            'https://nominatim.openstreetmap.org',
            'https://*.tile.openstreetmap.org',
            'https://*.basemaps.cartocdn.com',
            'https://server.arcgisonline.com',
          ],
          'worker-src': ["'self'", 'blob:'],
          'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
          'frame-src': ["'self'", 'https://*.google.com'],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(
    cors((req, cb) => {
      const origin = req.header('Origin');
      const host = req.get('host');
      const sameOrigin = Boolean(origin && host && origin === `${req.protocol}://${host}`);
      if (!origin || sameOrigin || env.isOriginAllowed(origin)) {
        cb(null, {
          origin: true,
          credentials: true,
          allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Fp'],
        });
        return;
      }
      cb(new Error(`Origin không được phép: ${origin}`));
    }),
  );
  // SSE không được nén/buffer
  app.use(compression({ filter: (req, res) => (req.path === '/api/ai/chat' ? false : compression.filter(req, res)) }));
  app.use(express.json({ limit: '4mb' }));
  app.use(limits.global);
  app.use(sanitizeInput);

  const { api, root } = buildRouter(s, bootInfo);
  app.use(root);
  app.use('/api', api);
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Endpoint không tồn tại.' } });
  });

  // Phục vụ frontend đã build (single-service trên Render); nếu chưa build thì chỉ chạy API.
  const frontendDist = path.resolve(__dirname, '../../frontend/dist');
  const candidates = [
    frontendDist,
    path.resolve(process.cwd(), '../frontend/dist'),
    path.resolve(process.cwd(), 'frontend/dist'),
  ];
  const dist = candidates.find((p) => fs.existsSync(path.join(p, 'index.html')));
  if (dist) {
    const assetsDir = path.join(dist, 'assets') + path.sep;
    app.use(
      express.static(dist, {
        etag: true,
        setHeaders: (res, file) => {
          if (file.startsWith(assetsDir)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else if (file.endsWith('sw.js') || file.endsWith('index.html') || file.endsWith('manifest.webmanifest')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
          } else {
            res.setHeader('Cache-Control', 'public, max-age=3600');
          }
        },
      }),
    );

    // Tuyệt đối KHÔNG trả index.html cho request .js/.css/.svg/.json/.woff2 bị thiếu sau khi redeploy (tránh lỗi MIME type gây trắng trang)
    app.get(/^(?!\/api|\/healthz).*/, (req, res) => {
      if (req.path.startsWith('/assets/') || STATIC_ASSET_EXT_RE.test(req.path)) {
        res.setHeader('Cache-Control', 'no-store');
        res.status(404).type('text/plain').send('Asset not found');
        return;
      }
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
