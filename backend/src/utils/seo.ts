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

export const GOOGLE_VERIFICATION_FILE_RE = /^\/(google[a-z0-9_-]+\.html)$/i;

interface PublicHtmlMeta {
  readonly title: string;
  readonly description: string;
}

const PUBLIC_HTML_META: Readonly<Record<string, PublicHtmlMeta>> = {
  '/report': {
    title: 'Báo Cáo Sự Cố 3 Bước — SmartCitizen Đồng Nai',
    description:
      'Gửi phản ánh hiện trường đô thị tại Đồng Nai trong 3 bước: chụp ảnh để AI tự động phân loại, xác định vị trí GPS chính xác và theo dõi kết quả xử lý.',
  },
  '/map': {
    title: 'Bản Đồ Sự Cố Trực Tuyến 95 Phường/Xã — SmartCitizen Đồng Nai',
    description:
      'Xem bản đồ phản ánh hiện trường trực tuyến trên toàn Thành phố Đồng Nai (95 xã/phường): điểm ghim sự cố, bản đồ nhiệt và lọc theo bán kính gần bạn.',
  },
  '/mine': {
    title: 'Tra Cứu Hồ Sơ & Phản Ánh Của Tôi — SmartCitizen Đồng Nai',
    description:
      'Tra cứu mã hồ sơ phản ánh hiện trường tại Đồng Nai, theo dõi tiến độ tiếp nhận – xử lý của cơ quan chức năng và đối chiếu ảnh Trước – Sau.',
  },
};

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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
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

export function normalizeGoogleSiteVerification(raw?: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  const metaMatch = trimmed.match(/<meta\b[^>]*\bcontent=["']([^"']+)["']/i);
  return (metaMatch?.[1] ?? trimmed).trim();
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

  const token = normalizeGoogleSiteVerification(opts.googleSiteVerification);
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
  const isKnownRoute = KNOWN_SPA_ROUTES.has(normalizedPath);
  if (opts.forceNoIndex) {
    out = out.replace(
      /<meta\s+name=["']robots["']\s+content=["'][^"']*["']\s*\/?>/i,
      '<meta name="robots" content="noindex, nofollow" />',
    );
    if (!isKnownRoute) {
      out = out.replace(/[ \t]*<link\s+rel=["']canonical["']\s+href=["'][^"']*["']\s*\/?>\r?\n?/i, '');
    }
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
    const routeMeta = PUBLIC_HTML_META[normalizedPath];
    if (routeMeta) {
      const safeTitleHtml = escapeHtml(routeMeta.title);
      const safeTitleAttr = escapeHtmlAttr(routeMeta.title);
      const safeDescAttr = escapeHtmlAttr(routeMeta.description);
      out = out.replace(/<title>[\s\S]*?<\/title>/i, `<title>${safeTitleHtml}</title>`);
      out = out.replace(
        /<meta\s+name=["']description["'][\s\S]*?\/?>/i,
        `<meta name="description" content="${safeDescAttr}" />`,
      );
      out = out.replace(
        /<meta\s+property=["']og:title["'][\s\S]*?\/?>/i,
        `<meta property="og:title" content="${safeTitleAttr}" />`,
      );
      out = out.replace(
        /<meta\s+property=["']og:description["'][\s\S]*?\/?>/i,
        `<meta property="og:description" content="${safeDescAttr}" />`,
      );
      out = out.replace(
        /<meta\s+name=["']twitter:title["'][\s\S]*?\/?>/i,
        `<meta name="twitter:title" content="${safeTitleAttr}" />`,
      );
      out = out.replace(
        /<meta\s+name=["']twitter:description["'][\s\S]*?\/?>/i,
        `<meta name="twitter:description" content="${safeDescAttr}" />`,
      );
    }
  }

  return out;
}
