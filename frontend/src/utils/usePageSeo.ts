import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useI18n } from '../i18n';

const DEFAULT_SITE_URL = 'https://smartcitizen-dongnai.onrender.com';

export interface RouteSeoEntry {
  title: string;
  description: string;
  robots: string;
  canonicalPath?: string;
}

const INDEX_ROBOTS = 'index, follow, max-image-preview:large, max-snippet:-1';
const NOINDEX_ROBOTS = 'noindex, nofollow';

const PUBLIC_SEO_VI: Record<string, RouteSeoEntry> = {
  '/': {
    title: 'SmartCitizen Đồng Nai — Cổng Phản Ánh Hiện Trường & Đô Thị Thông Minh',
    description:
      'SmartCitizen Đồng Nai — Cổng phản ánh hiện trường & đô thị thông minh 95 xã/phường Đồng Nai: chụp ảnh AI tự điền đơn, bản đồ trực tuyến, tra cứu minh bạch.',
    robots: INDEX_ROBOTS,
    canonicalPath: '/',
  },
  '/report': {
    title: 'Báo Cáo Sự Cố 3 Bước — SmartCitizen Đồng Nai',
    description:
      'Gửi phản ánh hiện trường đô thị tại Đồng Nai trong 3 bước: chụp ảnh để AI tự động phân loại, xác định vị trí GPS chính xác và theo dõi kết quả xử lý.',
    robots: INDEX_ROBOTS,
    canonicalPath: '/report',
  },
  '/map': {
    title: 'Bản Đồ Sự Cố Trực Tuyến 95 Phường/Xã — SmartCitizen Đồng Nai',
    description:
      'Xem bản đồ phản ánh hiện trường trực tuyến trên toàn Thành phố Đồng Nai (95 xã/phường): điểm ghim sự cố, bản đồ nhiệt và lọc theo bán kính gần bạn.',
    robots: INDEX_ROBOTS,
    canonicalPath: '/map',
  },
  '/mine': {
    title: 'Tra Cứu Hồ Sơ & Phản Ánh Của Tôi — SmartCitizen Đồng Nai',
    description:
      'Tra cứu mã hồ sơ phản ánh hiện trường tại Đồng Nai, theo dõi tiến độ tiếp nhận – xử lý của cơ quan chức năng và đối chiếu ảnh Trước – Sau.',
    robots: INDEX_ROBOTS,
    canonicalPath: '/mine',
  },
  '/gioi-thieu': {
    title: 'Giới Thiệu SmartCitizen Đồng Nai & Team Victer — Đô Thị Thông Minh',
    description:
      'Tìm hiểu SmartCitizen Đồng Nai do Team Victer phát triển: nền tảng phản ánh hiện trường Đồng Nai 95 phường/xã với Local AI, bản đồ trực tuyến và SMS OTP.',
    robots: INDEX_ROBOTS,
    canonicalPath: '/gioi-thieu',
  },
};

const PUBLIC_SEO_EN: Record<string, RouteSeoEntry> = {
  '/': {
    title: 'SmartCitizen Dong Nai — Civic Incident Reporting & Smart Urban Dispatch',
    description:
      'SmartCitizen Dong Nai — Citizen feedback and smart urban dispatch portal across 95 wards and communes of Dong Nai with AI triage, live map, and transparent tracking.',
    robots: INDEX_ROBOTS,
    canonicalPath: '/',
  },
  '/report': {
    title: 'Report an Incident in 3 Steps — SmartCitizen Dong Nai',
    description:
      'Submit urban incident reports in Dong Nai in 3 steps: capture a photo for AI triage, confirm GPS location, and track resolution progress.',
    robots: INDEX_ROBOTS,
    canonicalPath: '/report',
  },
  '/map': {
    title: 'Live Incident Map Across 95 Wards & Communes — SmartCitizen Dong Nai',
    description:
      'Explore the live civic incident map of Dong Nai with clustered pins, heatmaps, and radius filtering across 95 wards and communes.',
    robots: INDEX_ROBOTS,
    canonicalPath: '/map',
  },
  '/mine': {
    title: 'Track Reports & Case Lookup — SmartCitizen Dong Nai',
    description:
      'Look up incident tracking codes, follow real-time dispatch progress, and compare Before and After resolution photos in Dong Nai.',
    robots: INDEX_ROBOTS,
    canonicalPath: '/mine',
  },
  '/gioi-thieu': {
    title: 'About SmartCitizen Dong Nai & Team Victer — Smart Urban Portal',
    description:
      'Learn about SmartCitizen Dong Nai built by Team Victer: AI-powered civic incident reporting across 95 wards and communes of Dong Nai.',
    robots: INDEX_ROBOTS,
    canonicalPath: '/gioi-thieu',
  },
};

const PRIVATE_SEO: Record<string, { title: string; description: string }> = {
  '/profile': {
    title: 'Hồ Sơ Cá Nhân & Phiên — SmartCitizen Đồng Nai',
    description: 'Quản lý thông tin tài khoản công dân và phiên đăng nhập trên SmartCitizen Đồng Nai.',
  },
  '/auth': {
    title: 'Đăng Nhập Hệ Thống — SmartCitizen Đồng Nai',
    description: 'Đăng nhập tài khoản công dân hoặc cán bộ điều hành hệ thống SmartCitizen Đồng Nai.',
  },
  '/volunteer': {
    title: 'Điều Hướng Cổng Điều Hành — SmartCitizen Đồng Nai',
    description: 'Chuyển hướng tới cổng điều hành SmartCitizen Đồng Nai.',
  },
  '/rescue/login': {
    title: 'Đăng Nhập Đội Cứu Hộ — SmartCitizen Đồng Nai',
    description: 'Cổng xác thực dành cho đội cứu hộ và ứng cứu khẩn cấp Đồng Nai.',
  },
  '/rescue': {
    title: 'Cổng Tác Chiến Đội Cứu Hộ — SmartCitizen Đồng Nai',
    description: 'Không gian điều phối và dẫn đường tác chiến hiện trường dành cho đội cứu hộ.',
  },
  '/ioc': {
    title: 'Cổng Điều Hành IOC — SmartCitizen Đồng Nai',
    description: 'Bảng điều hành IOC nội bộ dành cho cán bộ phường/xã và quản trị thành phố.',
  },
  '/admin': {
    title: 'Quản Trị Hệ Thống IOC — SmartCitizen Đồng Nai',
    description: 'Cổng quản trị và điều phối sự cố nội bộ SmartCitizen Đồng Nai.',
  },
  '/dashboard': {
    title: 'Bảng Điều Hành IOC — SmartCitizen Đồng Nai',
    description: 'Bảng tổng hợp điều hành sự cố nội bộ SmartCitizen Đồng Nai.',
  },
};

function normalizePath(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed || '/';
}

export function getSiteBaseUrl(runtimeOrigin?: string): string {
  const configured = (import.meta.env.VITE_SITE_URL ?? '').trim().replace(/\/+$/, '');
  if (/^https?:\/\/[^/\s]+/i.test(configured)) return configured;
  if (runtimeOrigin && /^https?:\/\/[^/\s]+/i.test(runtimeOrigin)) {
    return runtimeOrigin.replace(/\/+$/, '');
  }
  return DEFAULT_SITE_URL;
}

export function resolveRouteSeo(pathname: string, lang: 'vi' | 'en' = 'vi'): RouteSeoEntry {
  const path = normalizePath(pathname);
  const publicMap = lang === 'en' ? PUBLIC_SEO_EN : PUBLIC_SEO_VI;
  if (path in publicMap) {
    return publicMap[path];
  }
  const caseMatch = /^\/phan-anh\/([A-Za-z0-9-]+)$/i.exec(path);
  if (caseMatch) {
    const code = caseMatch[1].toUpperCase();
    return lang === 'en'
      ? {
          title: `Incident ${code} — SmartCitizen Dong Nai`,
          description: `Live processing status and field photo verification for incident ${code} on SmartCitizen Dong Nai (Team Victer).`,
          robots: INDEX_ROBOTS,
          canonicalPath: `/phan-anh/${caseMatch[1]}`,
        }
      : {
          title: `Hồ Sơ Phản Ánh ${code} — SmartCitizen Đồng Nai`,
          description: `Chi tiết hiện trường và tiến độ xử lý hồ sơ phản ánh ${code} trên Cổng Đô thị thông minh SmartCitizen Đồng Nai (Team Victer).`,
          robots: INDEX_ROBOTS,
          canonicalPath: `/phan-anh/${caseMatch[1]}`,
        };
  }
  if (path in PRIVATE_SEO) {
    return {
      ...PRIVATE_SEO[path],
      robots: NOINDEX_ROBOTS,
      canonicalPath: path,
    };
  }
  return {
    title:
      lang === 'en'
        ? '404 — Page Not Found | SmartCitizen Dong Nai'
        : '404 — Không Tìm Thấy Trang | SmartCitizen Đồng Nai',
    description:
      lang === 'en'
        ? 'The requested page does not exist on SmartCitizen Dong Nai.'
        : 'Trang bạn tìm kiếm không tồn tại trên cổng SmartCitizen Đồng Nai.',
    robots: NOINDEX_ROBOTS,
  };
}

function upsertMeta(attr: 'name' | 'property', key: string, content: string): void {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function upsertCanonical(href: string | null): void {
  const existing = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!href) {
    existing?.remove();
    return;
  }
  const link = existing ?? document.createElement('link');
  link.setAttribute('rel', 'canonical');
  link.setAttribute('href', href);
  if (!existing) document.head.appendChild(link);
}

/** Cập nhật động `<html lang>`, `<title>`, `description`, `robots`, `canonical` và Open Graph cho từng route. */
export function usePageSeo(entry: RouteSeoEntry, lang: 'vi' | 'en' = 'vi'): void {
  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = entry.title;
    upsertMeta('name', 'description', entry.description);
    upsertMeta('name', 'robots', entry.robots);

    const baseUrl = getSiteBaseUrl(window.location.origin);
    const canonicalUrl = entry.canonicalPath
      ? `${baseUrl}${entry.canonicalPath === '/' ? '/' : entry.canonicalPath}`
      : null;

    upsertCanonical(canonicalUrl);
    upsertMeta('property', 'og:locale', lang === 'en' ? 'en_US' : 'vi_VN');
    upsertMeta('property', 'og:title', entry.title);
    upsertMeta('property', 'og:description', entry.description);
    if (canonicalUrl) {
      upsertMeta('property', 'og:url', canonicalUrl);
    }
    upsertMeta('name', 'twitter:title', entry.title);
    upsertMeta('name', 'twitter:description', entry.description);
  }, [entry.title, entry.description, entry.robots, entry.canonicalPath, lang]);
}

/** Tự động đồng bộ thẻ SEO theo route hiện tại của React Router. */
export function useRouteSeo(): void {
  const { pathname } = useLocation();
  const { lang } = useI18n();
  const seo = resolveRouteSeo(pathname, lang);
  usePageSeo(seo, lang);
}
