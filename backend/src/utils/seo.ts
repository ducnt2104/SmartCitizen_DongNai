export const DEFAULT_SITE_URL = 'https://smartcitizen-dongnai.onrender.com';

export interface SitemapRoute {
  readonly path: string;
  readonly changefreq: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly';
  readonly priority: string;
  readonly lastmod?: string;
}

/** Danh sách route công khai hợp lệ khớp 1:1 với frontend/src/App.tsx */
export const PUBLIC_SITEMAP_ROUTES: readonly SitemapRoute[] = [
  { path: '/', changefreq: 'daily', priority: '1.0' },
  { path: '/map', changefreq: 'hourly', priority: '0.9' },
  { path: '/alerts', changefreq: 'hourly', priority: '0.9' },
  { path: '/report', changefreq: 'weekly', priority: '0.9' },
  { path: '/mine', changefreq: 'daily', priority: '0.8' },
  { path: '/gioi-thieu', changefreq: 'weekly', priority: '0.8' },
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

const CRAWLER_UA_RE =
  /(?:Googlebot|Google-InspectionTool|AdsBot-Google|Bingbot|Slurp|DuckDuckBot|Baiduspider|YandexBot|facebookexternalhit|Facebot|Twitterbot|Zalo|ZaloPC|LinkedInBot|WhatsApp|TelegramBot|Discordbot)/i;

export function isCrawlerUserAgent(userAgent?: string | null): boolean {
  return Boolean(userAgent && CRAWLER_UA_RE.test(userAgent));
}

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
  '/alerts': {
    title: 'Cảnh Báo Thiên Tai, Ngập Lụt & Giao Thông — SmartCitizen Đồng Nai',
    description:
      'Theo dõi lượng mưa Open-Meteo, cảnh báo thiên tai/ngập lụt, tuyến đường đang thi công và bản tin chính thống toàn tỉnh Đồng Nai 24/7.',
  },
  '/mine': {
    title: 'Tra Cứu Hồ Sơ & Phản Ánh Của Tôi — SmartCitizen Đồng Nai',
    description:
      'Tra cứu mã hồ sơ phản ánh hiện trường tại Đồng Nai, theo dõi tiến độ tiếp nhận – xử lý của cơ quan chức năng và đối chiếu ảnh Trước – Sau.',
  },
  '/gioi-thieu': {
    title: 'Giới Thiệu SmartCitizen Đồng Nai & Team Victer — Đô Thị Thông Minh',
    description:
      'Tìm hiểu SmartCitizen Đồng Nai (Team Victer): nền tảng phản ánh hiện trường Đồng Nai & đô thị thông minh 95 phường/xã với Local AI tốc độ cao.',
  },
};

export interface BotSsrReportContext {
  code: string;
  title: string;
  description: string;
  wardName: string;
  categoryLabel: string;
  status: string;
  createdAt: string;
}

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

export function buildSitemapXml(
  siteUrl: string,
  lastmodIso: string,
  dynamicRoutes: readonly SitemapRoute[] = [],
): string {
  const base = normalizeSiteUrl(siteUrl);
  const combined = [...PUBLIC_SITEMAP_ROUTES, ...dynamicRoutes];
  const seen = new Set<string>();
  const entries = combined
    .filter((r) => {
      if (r.path.startsWith('/admin') || r.path.startsWith('/ioc') || r.path.startsWith('/auth')) {
        return false;
      }
      if (seen.has(r.path)) return false;
      seen.add(r.path);
      return true;
    })
    .map((r) => {
      const loc = escapeXml(`${base}${r.path === '/' ? '/' : r.path}`);
      const lastmod = escapeXml((r.lastmod ?? lastmodIso).slice(0, 10));
      return [
        '  <url>',
        `    <loc>${loc}</loc>`,
        `    <lastmod>${lastmod}</lastmod>`,
        `    <changefreq>${r.changefreq}</changefreq>`,
        `    <priority>${r.priority}</priority>`,
        '  </url>',
      ].join('\n');
    })
    .join('\n');

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

function buildCrawlerSsrShell(opts: {
  title: string;
  description: string;
  baseUrl: string;
  pathname: string;
  stats?: { total: number; resolved: number };
  reportSummary?: BotSsrReportContext;
}): string {
  const safeTitle = escapeHtml(opts.title);
  const safeDesc = escapeHtml(opts.description);
  const statsBlock = opts.stats
    ? `<p>Thống kê toàn Đồng Nai (95 Phường/Xã): <strong>${opts.stats.total}</strong> phản ánh đã tiếp nhận, <strong>${opts.stats.resolved}</strong> hồ sơ đã xử lý hoàn tất.</p>`
    : '';
  const reportBlock = opts.reportSummary
    ? `<article>
        <h2>Hồ sơ ${escapeHtml(opts.reportSummary.code)}: ${escapeHtml(opts.reportSummary.title)}</h2>
        <p>${escapeHtml(opts.reportSummary.description)}</p>
        <ul>
          <li>Địa bàn: ${escapeHtml(opts.reportSummary.wardName)}</li>
          <li>Nhóm sự cố: ${escapeHtml(opts.reportSummary.categoryLabel)}</li>
          <li>Trạng thái: ${escapeHtml(opts.reportSummary.status)}</li>
          <li>Thời điểm ghi nhận: ${escapeHtml(opts.reportSummary.createdAt)}</li>
        </ul>
      </article>`
    : '';

  return `<div id="root"><main data-ssr-crawler="true">
      <header>
        <h1>${safeTitle}</h1>
        <p>${safeDesc}</p>
        <nav aria-label="Điều hướng chính SmartCitizen Đồng Nai">
          <a href="${escapeHtmlAttr(opts.baseUrl)}/">Trang chủ SmartCitizen Đồng Nai</a> |
          <a href="${escapeHtmlAttr(opts.baseUrl)}/map">Bản đồ phản ánh Đồng Nai (95 Phường/Xã)</a> |
          <a href="${escapeHtmlAttr(opts.baseUrl)}/report">Gửi phản ánh hiện trường</a> |
          <a href="${escapeHtmlAttr(opts.baseUrl)}/mine">Tra cứu hồ sơ</a> |
          <a href="${escapeHtmlAttr(opts.baseUrl)}/gioi-thieu">Giới thiệu Team Victer</a>
        </nav>
      </header>
      ${statsBlock}
      ${reportBlock}
      <section>
        <h2>SmartCitizen Đồng Nai — Phản ánh hiện trường Đồng Nai &amp; Đô thị thông minh Đồng Nai (Team Victer)</h2>
        <p>Hệ thống tiếp nhận phản ánh công dân đa kênh (SMS OTP +84, Email OTP), phân loại sự cố tức thì bằng Hybrid Local AI &amp; Web Worker, định vị GPS chuẩn hóa 95 Phường/Xã Đồng Nai và nghiệm thu Trước – Sau minh bạch.</p>
      </section>
    </main></div>`;
}

export function injectHtmlSeo(
  html: string,
  opts: {
    siteUrl: string;
    googleSiteVerification?: string;
    pathname?: string;
    forceNoIndex?: boolean;
    userAgent?: string | null;
    stats?: { total: number; resolved: number };
    reportSummary?: BotSsrReportContext;
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
  const isReportPath = /^\/phan-anh\/([A-Za-z0-9-]+)$/i.test(normalizedPath);
  const isKnownRoute = KNOWN_SPA_ROUTES.has(normalizedPath) || isReportPath;

  let activeTitle = 'SmartCitizen Đồng Nai — Cổng Phản Ánh Hiện Trường & Đô Thị Thông Minh';
  let activeDescription =
    'SmartCitizen Đồng Nai (Team Victer) — Cổng phản ánh hiện trường Đồng Nai & đô thị thông minh 95 phường/xã: chụp ảnh AI tự điền đơn, bản đồ trực tuyến, tra cứu minh bạch.';

  if (opts.forceNoIndex) {
    out = out.replace(
      /<meta\s+name=["']robots["']\s+content=["'][^"']*["']\s*\/?>/i,
      '<meta name="robots" content="noindex, nofollow" />',
    );
    if (!isKnownRoute) {
      out = out.replace(/[ \t]*<link\s+rel=["']canonical["']\s+href=["'][^"']*["']\s*\/?>\r?\n?/i, '');
    }
  } else {
    const pageUrl = escapeHtmlAttr(`${base}${normalizedPath === '/' ? '/' : normalizedPath}`);
    if (normalizedPath !== '/') {
      out = out.replace(
        /<link\s+rel=["']canonical["']\s+href=["'][^"']*["']\s*\/?>/i,
        `<link rel="canonical" href="${pageUrl}" />`,
      );
      out = out.replace(
        /<meta\s+property=["']og:url["']\s+content=["'][^"']*["']\s*\/?>/i,
        `<meta property="og:url" content="${pageUrl}" />`,
      );
    }

    const routeMeta = PUBLIC_HTML_META[normalizedPath];
    if (opts.reportSummary) {
      activeTitle = `${opts.reportSummary.code}: ${opts.reportSummary.title} — SmartCitizen Đồng Nai`;
      activeDescription = `${opts.reportSummary.wardName} · ${opts.reportSummary.categoryLabel} — ${opts.reportSummary.description}`.slice(
        0,
        190,
      );
    } else if (routeMeta) {
      activeTitle = routeMeta.title;
      activeDescription = routeMeta.description;
    }

    if (routeMeta || opts.reportSummary) {
      const safeTitleHtml = escapeHtml(activeTitle);
      const safeTitleAttr = escapeHtmlAttr(activeTitle);
      const safeDescAttr = escapeHtmlAttr(activeDescription);
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

    // Chèn trước nội dung SSR ngữ nghĩa trong <div id="root"> cho Crawler (Googlebot, Bingbot, Facebook, Zalo)
    if (isCrawlerUserAgent(opts.userAgent) && /<div\s+id=["']root["']\s*>\s*<\/div>/i.test(out)) {
      const ssrShell = buildCrawlerSsrShell({
        title: activeTitle,
        description: activeDescription,
        baseUrl: base,
        pathname: normalizedPath,
        stats: opts.stats,
        reportSummary: opts.reportSummary,
      });
      out = out.replace(/<div\s+id=["']root["']\s*>\s*<\/div>/i, ssrShell);
    }
  }

  return out;
}
