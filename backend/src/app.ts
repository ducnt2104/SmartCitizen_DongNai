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
import { canSee } from './services/access';
import type { Services } from './services/container';
import type { Category } from './shared/types';
import { WARD_BY_CODE } from './shared/dongNaiWards';
import { smartCompressionMiddleware } from './utils/compression';
import {
  buildRobotsTxt,
  buildSitemapXml,
  injectHtmlSeo,
  isCrawlerUserAgent,
  KNOWN_SPA_ROUTES,
  NOINDEX_SPA_ROUTES,
  normalizeAppPathname,
  type BotSsrReportContext,
  type SitemapRoute,
} from './utils/seo';

const CATEGORY_VI: Record<Category, string> = {
  rac_thai: 'Rác thải & Môi trường',
  den_duong: 'Đèn chiếu sáng & Điện',
  ngap_nuoc: 'Ngập nước & Thoát nước',
  mat_duong: 'Hư hỏng mặt đường',
  khac: 'Sự cố đô thị khác',
};

const STATIC_ASSET_EXT_RE = /\.(?:js|mjs|cjs|css|map|wasm|json|webmanifest|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|eot)$/i;
const LEGACY_JSON_IMAGE_ROUTE_RE =
  /^\/api\/(?:reports(?:\/[^/]+\/attach-photo)?|volunteer\/(?:proxy-report|tasks\/[^/]+\/verify)|rescue\/missions\/[^/]+\/(?:status|complete)|admin\/reports\/[^/]+\/resolve|ai\/(?:analyze-image|verify-resolution))$/;

function isTrustedCorsOrigin(origin: string, host: string | undefined): boolean {
  const sameHost = Boolean(
    host && (origin === `https://${host}` || origin === `http://${host}`),
  );
  if (sameHost) return true;

  const normalized = origin.replace(/\/+$/, '').toLowerCase();
  if (normalized === 'https://smartcitizen-dongnai.onrender.com') return true;
  if (env.siteUrl && normalized === env.siteUrl.toLowerCase()) return true;

  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(normalized);
  if (isLocal) return !env.isProd;

  // Chỉ cho phép các origin khai báo tường minh (không mở wildcard *.onrender.com cho bên thứ ba)
  return env.allowedOrigins.some((allowed) => {
    const clean = allowed.trim().replace(/\/+$/, '').toLowerCase();
    if (!clean || clean.includes('*')) return false;
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(clean) && env.isProd) return false;
    return clean === normalized;
  });
}

export function createApp(
  s: Services,
  bootInfo: { fallbackReason: string | null; dbState?: string; lastError?: string | null },
): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render đặt sau reverse proxy

  // Gắn Server-Timing: total;dur=<ms> trước khi header được đẩy ra socket cho mọi endpoint
  app.use((_req, res, next) => {
    const startNs = process.hrtime.bigint();
    const origWriteHead = res.writeHead.bind(res) as (...args: unknown[]) => typeof res;
    res.writeHead = ((...args: unknown[]) => {
      if (!res.headersSent && !res.hasHeader('Server-Timing')) {
        const durMs = Number(process.hrtime.bigint() - startNs) / 1e6;
        res.setHeader('Server-Timing', `total;dur=${durMs.toFixed(2)}`);
      }
      return origWriteHead(...args);
    }) as typeof res.writeHead;
    next();
  });

  app.use(
    helmet({
      frameguard: { action: 'deny' },
      noSniff: true,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      hsts: env.isProd
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
        : false,
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
            'https://*.basemaps.cartocdn.com',
            'https://server.arcgisonline.com',
            'https://services.arcgisonline.com',
            'https://geocode.arcgis.com',
            'https://photon.komoot.io',
            'https://api.bigdatacloud.net',
            'https://tiles.openfreemap.org',
            'https://*.openfreemap.org',
            'https://router.project-osrm.org',
            'https://api.weatherapi.com',
            'https://api.open-meteo.com',
            'https://geocoding-api.open-meteo.com',
          ],
          'worker-src': ["'self'", 'blob:'],
          'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
          'frame-src': ["'self'", 'https://*.google.com', 'https://*.firebaseapp.com'],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'frame-ancestors': ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(
    cors((req, cb) => {
      const origin = req.header('Origin');
      const host = req.get('host');
      if (!origin || isTrustedCorsOrigin(origin, host)) {
        cb(null, {
          origin: true,
          credentials: true,
          methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
          allowedHeaders: [
            'Content-Type',
            'Authorization',
            'X-Device-Fp',
            'X-PoW-Solution',
            'X-Reauth-Token',
            'X-Reauth-Password',
            'X-Gemini-Api-Key',
            'X-Weather-Api-Key',
          ],
        });
        return;
      }
      cb(new Error(`Origin không được phép: ${origin}`));
    }),
  );
  // Fast-path health ping (không đi qua JSON body parser / rate limiter nặng -> phản hồi < 5ms)
  app.get('/api/health/ping', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, ts: Date.now() });
  });

  // Nén Brotli (`br`) & Gzip đa chuẩn, bỏ qua SSE và ảnh WebP đã nén
  app.use(smartCompressionMiddleware());
  const strictJsonParser = express.json({ limit: '100kb' });
  const legacyImageJsonParser = express.json({ limit: '2mb' });
  app.use((req, res, next) => {
    if (LEGACY_JSON_IMAGE_ROUTE_RE.test(req.path)) {
      legacyImageJsonParser(req, res, next);
      return;
    }
    strictJsonParser(req, res, next);
  });
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
  app.get('/sitemap.xml', async (_req, res) => {
    try {
      let cached = s.cache.getReportCached('sitemap_xml');
      if (!cached) {
        const publicReports = await s.repos.reports
          .list({
            statuses: ['received', 'verifying', 'processing', 'resolved'],
            limit: 1000,
            projection: 'summary',
          })
          .catch(() => []);
        const dynamicRoutes: SitemapRoute[] = publicReports.map((r) => ({
          path: `/phan-anh/${encodeURIComponent(r.code)}`,
          changefreq: r.status === 'resolved' ? 'monthly' : 'daily',
          priority: r.isEmergency ? '0.8' : '0.7',
          lastmod: r.updatedAt?.slice(0, 10) || sitemapLastMod,
        }));
        const xml = buildSitemapXml(env.siteUrl, sitemapLastMod, dynamicRoutes);
        cached = s.cache.setReportCached('sitemap_xml', xml, 60_000);
      }
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
      res.status(200).type('application/xml; charset=utf-8').send(String(cached.body));
    } catch {
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.status(200).type('application/xml; charset=utf-8').send(buildSitemapXml(env.siteUrl, sitemapLastMod));
    }
  });

  // Phục vụ frontend đã build (single-service trên Render); nếu chưa build thì chỉ chạy API.
  const frontendDist = path.resolve(__dirname, '../../frontend/dist');
  const candidates = [
    frontendDist,
    path.resolve(process.cwd(), '../frontend/dist'),
    path.resolve(process.cwd(), 'frontend/dist'),
  ];
  const dist = candidates.find((p) => fs.existsSync(path.join(p, 'index.html')));

  // Phục vụ nguyên bản file xác minh Google Search Console (/google:id.html) TRƯỚC express.static & SPA fallback
  const verificationSearchDirs = [
    ...(dist ? [dist] : []),
    path.resolve(__dirname, '../../frontend/public'),
    path.resolve(process.cwd(), '../frontend/public'),
    path.resolve(process.cwd(), 'frontend/public'),
  ];
  app.get('/google:id.html', (req, res) => {
    const rawId = typeof req.params.id === 'string' ? req.params.id : '';
    if (!/^[a-z0-9_-]+$/i.test(rawId)) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(404).type('text/plain; charset=utf-8').send('Verification file not found');
      return;
    }

    const candidateNames = Array.from(new Set([`google${rawId}.html`, `google${rawId.toLowerCase()}.html`]));
    const foundPath = verificationSearchDirs
      .flatMap((dir) => candidateNames.map((name) => path.join(dir, name)))
      .find((candidatePath) => {
        try {
          return fs.statSync(candidatePath).isFile();
        } catch {
          return false;
        }
      });

    if (!foundPath) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(404).type('text/plain; charset=utf-8').send('Verification file not found');
      return;
    }

    const rawBytes = fs.readFileSync(foundPath);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(200).type('text/html; charset=utf-8').send(rawBytes);
  });

  if (dist) {
    const assetsDir = path.join(dist, 'assets') + path.sep;
    const indexHtmlPath = path.join(dist, 'index.html');
    const rawIndexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

    const PRECOMPRESSED_MIME: Record<string, string> = {
      '.js': 'application/javascript; charset=utf-8',
      '.mjs': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml; charset=utf-8',
    };

    // Phục vụ trực tiếp bản nén tĩnh .br / .gz do Vite precompress sinh ra để tiết kiệm CPU Render
    app.use('/assets', (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
      }
      const ext = path.extname(req.path).toLowerCase();
      const mime = PRECOMPRESSED_MIME[ext];
      if (!mime) {
        next();
        return;
      }
      const rel = req.path.replace(/^\/+/, '');
      const fullPath = path.resolve(assetsDir, rel);
      if (!fullPath.startsWith(assetsDir)) {
        next();
        return;
      }
      const ae = String(req.headers['accept-encoding'] ?? '');
      const tryVariants: Array<{ suffix: '.br' | '.gz'; enc: 'br' | 'gzip' }> = [];
      if (/\bbr\b/i.test(ae)) tryVariants.push({ suffix: '.br', enc: 'br' });
      if (/\bgzip\b/i.test(ae)) tryVariants.push({ suffix: '.gz', enc: 'gzip' });

      for (const variant of tryVariants) {
        const encodedPath = `${fullPath}${variant.suffix}`;
        if (fs.existsSync(encodedPath)) {
          res.setHeader('Content-Encoding', variant.enc);
          res.setHeader('Vary', 'Accept-Encoding');
          res.setHeader('Content-Type', mime);
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          res.sendFile(encodedPath);
          return;
        }
      }
      next();
    });

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

    // Tuyệt đối KHÔNG trả index.html cho request .js/.css/.svg/.json/.woff2 hoặc google*.html bị thiếu (tránh lỗi MIME/soft-404)
    app.get(/^(?!\/api|\/healthz|\/robots\.txt$|\/sitemap\.xml$|\/google[a-z0-9_-]+\.html$).*/i, async (req, res) => {
      if (req.path.startsWith('/assets/') || STATIC_ASSET_EXT_RE.test(req.path)) {
        res.setHeader('Cache-Control', 'no-store');
        res.status(404).type('text/plain').send('Asset not found');
        return;
      }

      const normalizedPath = normalizeAppPathname(req.path);
      const caseMatch = /^\/phan-anh\/([A-Za-z0-9-]+)$/i.exec(normalizedPath);
      let reportSummary: BotSsrReportContext | undefined;
      let isKnownRoute = KNOWN_SPA_ROUTES.has(normalizedPath);
      if (caseMatch) {
        const found = await s.repos.reports.getByCode(caseMatch[1]).catch(() => null);
        if (found && canSee(null, found)) {
          isKnownRoute = true;
          reportSummary = {
            code: found.code,
            title: found.title,
            description: found.description,
            wardName: WARD_BY_CODE[found.wardCode]?.name ?? found.wardCode,
            categoryLabel: CATEGORY_VI[found.category] ?? found.category,
            status: found.status,
            createdAt: found.createdAt,
          };
        }
      }

      const isNoIndex = !isKnownRoute || NOINDEX_SPA_ROUTES.has(normalizedPath);
      if (isNoIndex) {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      }

      const userAgent = req.get('user-agent') ?? '';
      const isBot = isCrawlerUserAgent(userAgent);
      let botStats: { total: number; resolved: number } | undefined;
      if (isBot && !isNoIndex) {
        const cachedStats = s.cache.getReportCached('bot_ssr_stats');
        if (cachedStats) {
          botStats = cachedStats.body as { total: number; resolved: number };
        } else {
          const st = await s.reports.stats('city').catch(() => null);
          if (st) {
            botStats = { total: st.total, resolved: st.resolved };
            s.cache.setReportCached('bot_ssr_stats', botStats, 30_000);
          }
        }
      }

      res.setHeader('Vary', 'User-Agent');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      const html = injectHtmlSeo(rawIndexHtml, {
        siteUrl: env.siteUrl,
        googleSiteVerification: env.googleSiteVerification,
        pathname: normalizedPath,
        forceNoIndex: isNoIndex,
        userAgent,
        stats: botStats,
        reportSummary,
      });

      res.status(isKnownRoute ? 200 : 404).type('text/html; charset=utf-8').send(html);
    });
  }

  app.use(errorHandler);
  return app;
}
