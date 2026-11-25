export const DEFAULT_SITE_URL = 'https://smartcitizen-dongnai.onrender.com';

export interface SitemapRoute {
  readonly path: string;
  readonly changefreq: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly';
  readonly priority: string;
}

/** Danh sách route công khai hợp lệ khớp 1:1 với frontend/src/App.tsx */
export const PUBLIC_SITEMAP_ROUTES: readonly SitemapRoute[] = [
  { path: '/', changefreq: 'daily', priority: '1.0' },
  { path: '/map', changefreq: 'hourly', priority: '0.9' },
  { path: '/report', changefreq: 'weekly', priority: '0.9' },
  { path: '/mine', changefreq: 'daily', priority: '0.8' },
];

export const NOINDEX_SPA_ROUTES: ReadonlySet<string> = new Set([
  '/profile',
  '/volunteer',
  '/auth',
  '/rescue/login',
  '/rescue',
  '/ioc',
  '/admin',
  '/dashboard',
]);

export const KNOWN_SPA_ROUTES: ReadonlySet<string> = new Set([
  ...PUBLIC_SITEMAP_ROUTES.map((r) => r.path),
  ...NOINDEX_SPA_ROUTES,
]);

export function normalizeSiteUrl(raw?: string): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^/\s]+/i.test(trimmed) ? trimmed : DEFAULT_SITE_URL;
}

export function normalizeAppPathname(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed || '/';
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function buildRobotsTxt(siteUrl: string): string {
  const base = normalizeSiteUrl(siteUrl);
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /admin',
    'Disallow: /ioc',
    '',
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n');
}

export function buildSitemapXml(siteUrl: string, lastmodIso: string): string {
  const base = normalizeSiteUrl(siteUrl);
  const lastmod = escapeXml(lastmodIso);
  const entries = PUBLIC_SITEMAP_ROUTES.map((r) => {
    const loc = escapeXml(`${base}${r.path === '/' ? '/' : r.path}`);
    return [
      '  <url>',
      `    <loc>${loc}</loc>`,
      `    <lastmod>${lastmod}</lastmod>`,
      `    <changefreq>${r.changefreq}</changefreq>`,
      `    <priority>${r.priority}</priority>`,
      '  </url>',
    ].join('\n');
  }).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entries,
    '</urlset>',
    '',
  ].join('\n');
}

export function injectHtmlSeo(
  html: string,
  opts: {
    siteUrl: string;
    googleSiteVerification?: string;
    pathname?: string;
    forceNoIndex?: boolean;
  },
): string {
  const base = normalizeSiteUrl(opts.siteUrl);
  let out = base !== DEFAULT_SITE_URL ? html.split(DEFAULT_SITE_URL).join(base) : html;

  const token = (opts.googleSiteVerification ?? '').trim();
  const hasExistingVerification = /<meta[^>]+name=["']google-site-verification["']/i.test(out);
  const verificationTag =
    token && !hasExistingVerification
      ? `<meta name="google-site-verification" content="${escapeHtmlAttr(token)}" />`
      : '';

  if (/<!--\s*google-site-verification\s*-->/i.test(out)) {
    out = out.replace(
      /[ \t]*<!--\s*google-site-verification\s*-->\r?\n?/gi,
      verificationTag ? `    ${verificationTag}\n` : '',
    );
  } else if (verificationTag) {
    out = out.replace(/<\/head>/i, `    ${verificationTag}\n  </head>`);
  }

  const normalizedPath = opts.pathname ? normalizeAppPathname(opts.pathname) : '/';
  if (opts.forceNoIndex) {
    out = out.replace(
      /<meta\s+name=["']robots["']\s+content=["'][^"']*["']\s*\/?>/i,
      '<meta name="robots" content="noindex, nofollow" />',
    );
  } else if (normalizedPath !== '/') {
    const pageUrl = escapeHtmlAttr(`${base}${normalizedPath}`);
    out = out.replace(
      /<link\s+rel=["']canonical["']\s+href=["'][^"']*["']\s*\/?>/i,
      `<link rel="canonical" href="${pageUrl}" />`,
    );
    out = out.replace(
      /<meta\s+property=["']og:url["']\s+content=["'][^"']*["']\s*\/?>/i,
      `<meta property="og:url" content="${pageUrl}" />`,
    );
  }

  return out;
}
