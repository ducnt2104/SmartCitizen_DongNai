import fs from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const PRECOMPRESS_EXTS = new Set(['.js', '.mjs', '.css', '.html', '.svg', '.json']);
const PRECOMPRESS_MIN_BYTES = 1024;

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Tạo sẵn file .br (Brotli q11) & .gz (Gzip level 9) sau khi Vite build xong */
function staticPrecompressPlugin(): Plugin {
  let outDir = path.resolve(process.cwd(), 'dist');
  return {
    name: 'static-precompress-br-gz',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      for (const file of walkFiles(outDir)) {
        if (!PRECOMPRESS_EXTS.has(path.extname(file).toLowerCase())) continue;
        const raw = fs.readFileSync(file);
        if (raw.byteLength < PRECOMPRESS_MIN_BYTES) continue;
        const br = brotliCompressSync(raw, {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
            [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
          },
        });
        if (br.byteLength < raw.byteLength) fs.writeFileSync(`${file}.br`, br);
        const gz = gzipSync(raw, { level: 9 });
        if (gz.byteLength < raw.byteLength) fs.writeFileSync(`${file}.gz`, gz);
      }
    },
  };
}

const DEFAULT_SITE_URL = 'https://smartcitizen-dongnai.onrender.com';
const GOOGLE_VERIFICATION_FILE_NAME_RE = /^google[a-z0-9_-]+\.html$/i;

function normalizeSiteUrl(raw?: string): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^/\s]+/i.test(trimmed) ? trimmed : DEFAULT_SITE_URL;
}

function normalizeGoogleSiteVerification(raw?: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  const metaMatch = trimmed.match(/<meta\b[^>]*\bcontent=["']([^"']+)["']/i);
  return (metaMatch?.[1] ?? trimmed).trim();
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function seoHtmlPlugin(siteUrl: string, verificationToken: string): Plugin {
  let publicDir = path.resolve(__dirname, 'public');
  let outDir = path.resolve(__dirname, 'dist');

  return {
    name: 'smartcitizen-seo-html',
    configResolved(config) {
      if (config.publicDir) publicDir = config.publicDir;
      outDir = path.resolve(config.root, config.build.outDir);
    },
    transformIndexHtml(html, ctx) {
      let out = siteUrl !== DEFAULT_SITE_URL ? html.split(DEFAULT_SITE_URL).join(siteUrl) : html;
      const verificationMeta = verificationToken
        ? `<meta name="google-site-verification" content="${escapeHtmlAttr(verificationToken)}" />`
        : '';
      out = out.replace(/[ \t]*<!-- google-site-verification -->\r?\n?/g, verificationMeta ? `    ${verificationMeta}\n` : '');

      // Core Web Vitals (LCP/CLS): Preload font tiếng Việt chính & logo nhận diện trong bản build production
      if (ctx?.bundle) {
        const preloads: string[] = [];
        for (const fileName of Object.keys(ctx.bundle)) {
          if (/be-vietnam-pro-vietnamese-(?:400|700)-.*\.woff2$/i.test(fileName)) {
            preloads.push(`<link rel="preload" as="font" type="font/woff2" href="/${fileName}" crossorigin />`);
          } else if (/logo-mark-.*\.png$/i.test(fileName)) {
            preloads.push(`<link rel="preload" as="image" href="/${fileName}" />`);
          }
        }
        if (preloads.length > 0) {
          out = out.replace(/<\/head>/i, `    ${preloads.join('\n    ')}\n  </head>`);
        }
      }
      return out;
    },
    closeBundle() {
      if (!fs.existsSync(publicDir) || !fs.existsSync(outDir)) return;
      for (const fileName of fs.readdirSync(publicDir)) {
        if (!GOOGLE_VERIFICATION_FILE_NAME_RE.test(fileName)) continue;
        const src = path.join(publicDir, fileName);
        if (!fs.statSync(src).isFile()) continue;
        fs.copyFileSync(src, path.join(outDir, fileName));
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const siteUrl = normalizeSiteUrl(
    env.VITE_SITE_URL || env.SITE_URL || process.env.VITE_SITE_URL || process.env.SITE_URL,
  );
  const verificationToken = normalizeGoogleSiteVerification(
    env.VITE_GOOGLE_SITE_VERIFICATION ||
      env.GOOGLE_SITE_VERIFICATION ||
      process.env.VITE_GOOGLE_SITE_VERIFICATION ||
      process.env.GOOGLE_SITE_VERIFICATION,
  );

  return {
    base: '/',
    envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
    plugins: [react(), seoHtmlPlugin(siteUrl, verificationToken), staticPrecompressPlugin()],
    esbuild:
      mode === 'production'
        ? { drop: ['debugger'], pure: ['console.log', 'console.debug', 'console.info'] }
        : undefined,
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'src/shared'),
        '@': path.resolve(__dirname, 'src'),
      },
    },
    server: {
      port: 5173,
      fs: { allow: ['..'] },
      proxy: {
        '/api': { target: 'http://localhost:8080', changeOrigin: true },
        '/healthz': { target: 'http://localhost:8080', changeOrigin: true },
      },
    },
    worker: { format: 'es' },
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 1100,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom'],
            firebase: ['firebase/app', 'firebase/auth'],
            'google-maps': ['@vis.gl/react-google-maps', '@googlemaps/markerclusterer'],
            maplibre: ['maplibre-gl'],
            charts: ['recharts'],
            db: ['dexie', 'dexie-react-hooks'],
            icons: ['lucide-react'],
          },
        },
      },
    },
  };
});
