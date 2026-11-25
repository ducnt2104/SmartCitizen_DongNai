import compression from 'compression';
import cors from 'cors';
import express, { type Express } from 'express';
import mongoSanitize from 'express-mongo-sanitize';
import fs from 'node:fs';
import path from 'node:path';
import helmet from 'helmet';
import { env } from './config/env';
import { limits } from './middleware/rateLimit';
import { errorHandler, sanitizeInput } from './middleware/validate';
import { buildRouter } from './routes';
import type { Services } from './services/container';
import {
  buildRobotsTxt,
  buildSitemapXml,
  injectHtmlSeo,
  KNOWN_SPA_ROUTES,
  NOINDEX_SPA_ROUTES,
  normalizeAppPathname,
} from './utils/seo';

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
            'https://www.google.com',
            'https://www.gstatic.com',
            'https://apis.google.com',
          ],
          'img-src': [
            "'self'",
            'data:',
            'blob:',
            'https://*.googleapis.com',
            'https://*.gstatic.com',
            'https://*.google.com',
            'https://*.ggpht.com',
            'https://tile.openstreetmap.org',
            'https://*.tile.openstreetmap.org',
            'https://tile.openstreetmap.org',
            'https://*.basemaps.cartocdn.com',
            'https://server.arcgisonline.com',
            'https://services.arcgisonline.com',
            'https://tiles.openfreemap.org',
            'https://*.openfreemap.org',
          ],
          'connect-src': [
            "'self'",
            'https://*.googleapis.com',
            'https://*.gstatic.com',
            'https://*.google.com',
            'https://*.firebaseio.com',
            'https://*.firebaseapp.com',
            'https://nominatim.openstreetmap.org',
            'https://tile.openstreetmap.org',
            'https://*.tile.openstreetmap.org',
            'https://tile.openstreetmap.org',
            'https://*.basemaps.cartocdn.com',
            'https://server.arcgisonline.com',
            'https://services.arcgisonline.com',
            'https://geocode.arcgis.com',
            'https://photon.komoot.io',
            'https://api.bigdatacloud.net',
            'https://tiles.openfreemap.org',
            'https://*.openfreemap.org',
            'https://router.project-osrm.org',
          ],
          'worker-src': ["'self'", 'blob:'],
          'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
          'frame-src': ["'self'", 'https://*.google.com', 'https://*.firebaseapp.com'],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(
    cors((req, cb) => {
      const origin = req.header('Origin');
      const host = req.get('host');
      const sameHost = Boolean(
        origin &&
          host &&
          (origin === `https://${host}` || origin === `http://${host}`),
      );
      const isLocalDev = Boolean(origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin));
      if (!origin || sameHost || isLocalDev || env.isOriginAllowed(origin)) {
        cb(null, {
          origin: true,
          credentials: true,
          methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
          allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Fp'],
        });
        return;
      }
      cb(new Error(`Origin không được phép: ${origin}`));
    }),
  );
  // SSE & ảnh WebP đã nén sẵn không được nén lại để tiết kiệm CPU Render
  app.use(
    compression({
      level: 6,
      threshold: 512,
      filter: (req, res) => {
        if (req.path === '/api/ai/chat' || req.path.startsWith('/api/media/')) return false;
        const ct = String(res.getHeader('Content-Type') ?? '');
        if (ct.startsWith('image/')) return false;
        return compression.filter(req, res);
      },
    }),
  );
  app.use(express.json({ limit: '4mb' }));
  app.use(limits.global);
  app.use(sanitizeInput);
  app.use(mongoSanitize({ replaceWith: '_' }));

  const { api, root } = buildRouter(s, bootInfo);
  app.use(root);
  app.use('/api', api);
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Endpoint không tồn tại.' } });
  });

  // Endpoints SEO (đặt TRƯỚC express.static và SPA fallback để không trả về index.html)
  const sitemapLastMod = new Date().toISOString().slice(0, 10);
  app.get('/robots.txt', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).type('text/plain; charset=utf-8').send(buildRobotsTxt(env.siteUrl));
  });
  app.get('/sitemap.xml', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).type('application/xml; charset=utf-8').send(buildSitemapXml(env.siteUrl, sitemapLastMod));
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
    const indexHtmlPath = path.join(dist, 'index.html');
    const rawIndexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

    app.use(
      express.static(dist, {
        index: false,
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
    app.get(/^(?!\/api|\/healthz|\/robots\.txt$|\/sitemap\.xml$).*/, (req, res) => {
      if (req.path.startsWith('/assets/') || STATIC_ASSET_EXT_RE.test(req.path)) {
        res.setHeader('Cache-Control', 'no-store');
        res.status(404).type('text/plain').send('Asset not found');
        return;
      }

      const normalizedPath = normalizeAppPathname(req.path);
      const isKnownRoute = KNOWN_SPA_ROUTES.has(normalizedPath);
      const isNoIndex = !isKnownRoute || NOINDEX_SPA_ROUTES.has(normalizedPath);
      if (isNoIndex) {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      }

      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      const html = injectHtmlSeo(rawIndexHtml, {
        siteUrl: env.siteUrl,
        googleSiteVerification: env.googleSiteVerification,
        pathname: normalizedPath,
        forceNoIndex: isNoIndex,
      });

      res.status(isKnownRoute ? 200 : 404).type('text/html; charset=utf-8').send(html);
    });
  }

  app.use(errorHandler);
  return app;
}
