import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const DEFAULT_SITE_URL = 'https://smartcitizen-dongnai.onrender.com';

function normalizeSiteUrl(raw?: string): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^/\s]+/i.test(trimmed) ? trimmed : DEFAULT_SITE_URL;
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function seoHtmlPlugin(siteUrl: string, verificationToken: string): Plugin {
  return {
    name: 'smartcitizen-seo-html',
    transformIndexHtml(html) {
      let out = siteUrl !== DEFAULT_SITE_URL ? html.split(DEFAULT_SITE_URL).join(siteUrl) : html;
      const verificationMeta = verificationToken
        ? `<meta name="google-site-verification" content="${escapeHtmlAttr(verificationToken)}" />`
        : '';
      out = out.replace(/[ \t]*<!-- google-site-verification -->\r?\n?/g, verificationMeta ? `    ${verificationMeta}\n` : '');
      return out;
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const siteUrl = normalizeSiteUrl(env.VITE_SITE_URL || env.SITE_URL);
  const verificationToken = (env.VITE_GOOGLE_SITE_VERIFICATION || env.GOOGLE_SITE_VERIFICATION || '').trim();

  return {
    base: '/',
    envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
    plugins: [react(), seoHtmlPlugin(siteUrl, verificationToken)],
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
            'google-maps': ['@vis.gl/react-google-maps', '@googlemaps/markerclusterer'],
            maplibre: ['maplibre-gl'],
            charts: ['recharts'],
            db: ['dexie', 'dexie-react-hooks'],
          },
        },
      },
    },
  };
});
