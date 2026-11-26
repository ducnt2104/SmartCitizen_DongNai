import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Danh sách cứng các tên miền chính thống được phép truy cập cho bộ tổng hợp dữ liệu
 * (Chống tuyệt đối SSRF: không cho phép user truyền URL tùy ý hay truy cập host ngoài whitelist).
 */
export const ALLOWED_OFFICIAL_DOMAINS: readonly string[] = [
  'api.weatherapi.com',
  'api.open-meteo.com',
  'air-quality-api.open-meteo.com',
  'baodongnai.com.vn',
  'www.baodongnai.com.vn',
  'dongnai.gov.vn',
  'www.dongnai.gov.vn',
  'nchmf.gov.vn',
  'vnexpress.net',
  'tuoitre.vn',
  'thanhnien.vn',
  'evnspc.vn',
  'cskh.evnspc.vn',
];

const ALLOWED_DOMAIN_SET = new Set(ALLOWED_OFFICIAL_DOMAINS.map((d) => d.toLowerCase()));

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a >= 224) return true; // Multicast & reserved
  return false;
}

export function isPrivateOrInternalIp(rawIp: string): boolean {
  const ip = rawIp.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!ip) return true;

  if (ip.startsWith('::ffff:')) {
    return isPrivateOrReservedIpv4(ip.slice(7));
  }
  const ver = net.isIP(ip);
  if (ver === 4) return isPrivateOrReservedIpv4(ip);
  if (ver === 6) {
    if (ip === '::' || ip === '::1') return true;
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // fc00::/7 ULA
    if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) return true; // fe80::/10 link-local
    return false;
  }
  return true;
}

export function isAllowedOfficialHostname(hostname: string): boolean {
  const clean = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!clean) return false;
  if (net.isIP(clean) !== 0) return false; // Cấm truy cập trực tiếp bằng địa chỉ IP
  return ALLOWED_DOMAIN_SET.has(clean);
}

/**
 * Kiểm tra chặt chẽ URL trước khi gửi HTTP request:
 * 1) Chỉ chấp nhận HTTPS (hoặc HTTP nếu test local mock? KHÔNG — chỉ HTTPS!).
 * 2) Hostname phải nằm chính xác trong `ALLOWED_OFFICIAL_DOMAINS`.
 * 3) Cấm username/password nhúng trong URL, cấm cổng lạ ngoài 443/80.
 * 4) Phân giải DNS thực tế và chặn tuyệt đối mọi IP nội bộ / loopback / metadata cloud (`127.x`, `10.x`, `169.254.x`, `192.168.x`, `172.16-31.x`, `::1`).
 */
export async function assertSafeOfficialUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`SSRF Guard: URL không hợp lệ (${rawUrl}).`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`SSRF Guard: Chỉ cho phép giao thức HTTPS (${parsed.protocol}).`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('SSRF Guard: Không cho phép nhúng thông tin xác thực trong URL.');
  }
  if (parsed.port && parsed.port !== '443') {
    throw new Error(`SSRF Guard: Không cho phép cổng tùy biến (${parsed.port}).`);
  }
  if (!isAllowedOfficialHostname(parsed.hostname)) {
    throw new Error(`SSRF Guard: Tên miền "${parsed.hostname}" không nằm trong ALLOWED_OFFICIAL_DOMAINS.`);
  }

  const records = await dns.lookup(parsed.hostname, { all: true });
  if (!records || records.length === 0) {
    throw new Error(`SSRF Guard: Không phân giải được DNS cho ${parsed.hostname}.`);
  }
  for (const rec of records) {
    if (isPrivateOrInternalIp(rec.address)) {
      throw new Error(`SSRF Guard: Chặn địa chỉ IP nội bộ/metadata (${rec.address}) của ${parsed.hostname}.`);
    }
  }

  return parsed;
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  maxRedirects?: number;
  fetchImpl?: typeof fetch;
  skipDnsLookupForTest?: boolean;
}

/**
 * Fetch an toàn có bảo vệ chống SSRF cho mọi bước (kể cả redirect), timeout mặc định 6000ms.
 */
export async function safeFetchOfficial(rawUrl: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const timeoutMs = Math.min(Math.max(1000, opts.timeoutMs ?? 6000), 15_000);
  const maxRedirects = opts.maxRedirects ?? 2;
  const fetchImpl = opts.fetchImpl ?? fetch;

  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (opts.skipDnsLookupForTest) {
      const u = new URL(currentUrl);
      if (u.protocol !== 'https:' || !isAllowedOfficialHostname(u.hostname)) {
        throw new Error(`SSRF Guard: URL bị từ chối (${currentUrl}).`);
      }
    } else {
      await assertSafeOfficialUrl(currentUrl);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': 'SmartCitizenDongNai-OfficialAggregator/2.0 (+https://smartcitizen-dongnai.onrender.com)',
          Accept: 'application/json, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
          ...(opts.headers ?? {}),
        },
        signal: ctrl.signal,
      });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc || hop === maxRedirects) {
          throw new Error(`SSRF Guard: Vượt quá số lần chuyển hướng hoặc thiếu Location (${res.status}).`);
        }
        currentUrl = new URL(loc, currentUrl).toString();
        continue;
      }

      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error('SSRF Guard: Không thể hoàn tất yêu cầu.');
}
