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

export function createApp(s: Services, bootInfo: { fallbackReason: string | null }): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render đặt sau reverse proxy

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'img-src': [
            "'self'",
            'data:',
            'blob:',
            'https://*.tile.openstreetmap.org',
            'https://*.basemaps.cartocdn.com',
            'https://server.arcgisonline.com',
            'https://unpkg.com',
          ],
          'connect-src': [
            "'self'",
            'https://nominatim.openstreetmap.org',
            'https://*.tile.openstreetmap.org',
            'https://*.basemaps.cartocdn.com',
            'https://server.arcgisonline.com',
          ],
          'worker-src': ["'self'", 'blob:'],
          'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin || env.isOriginAllowed(origin)) return cb(null, true);
        cb(new Error(`Origin không được phép: ${origin}`));
      },
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Fp'],
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

  // Phục vụ client đã build (single-service trên Render); nếu chưa build thì chỉ chạy API.
  const clientDist = path.resolve(__dirname, env.isProd ? '../../../../client/dist' : '../../client/dist');
  const candidates = [
    clientDist,
    path.resolve(process.cwd(), '../client/dist'),
    path.resolve(process.cwd(), 'client/dist'),
  ];
  const dist = candidates.find((p) => fs.existsSync(path.join(p, 'index.html')));
  if (dist) {
    app.use(
      express.static(dist, {
        maxAge: '1h',
        setHeaders: (res, file) => {
          if (file.endsWith('sw.js') || file.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
    app.get(/^(?!\/api|\/healthz).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
