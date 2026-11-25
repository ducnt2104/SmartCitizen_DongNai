const KEY = 'sc.device.fp.v1';

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function canvasSignature(): string {
  try {
    const c = document.createElement('canvas');
    c.width = 120;
    c.height = 30;
    const g = c.getContext('2d');
    if (!g) return 'nocanvas';
    g.textBaseline = 'top';
    g.font = '14px Arial';
    g.fillStyle = '#f60';
    g.fillRect(10, 2, 60, 20);
    g.fillStyle = '#069';
    g.fillText('SmartCitizen·Đồng Nai', 2, 8);
    return c.toDataURL().slice(-64);
  } catch (err) {
    console.warn('Canvas fingerprint không khả dụng:', err);
    return 'canvas-error';
  }
}

let cached: string | null = null;
try {
  if (typeof globalThis.localStorage !== 'undefined' && typeof globalThis.localStorage.getItem === 'function') {
    cached = globalThis.localStorage.getItem(KEY);
  }
} catch (err) {
  console.warn('Không đọc được device fingerprint từ localStorage:', err);
}

/** Device fingerprint nhẹ sinh cục bộ từ canvas + UA + màn hình + múi giờ (không dùng để định danh cá nhân). */
export async function ensureDeviceFingerprint(): Promise<string> {
  if (cached) return cached;
  const raw = [navigator.userAgent, navigator.language, screen.width, screen.height, screen.colorDepth, new Date().getTimezoneOffset(), canvasSignature()].join('|');
  cached = (await sha256Hex(raw)).slice(0, 32);
  try {
    if (typeof globalThis.localStorage !== 'undefined' && typeof globalThis.localStorage.setItem === 'function') {
      globalThis.localStorage.setItem(KEY, cached);
    }
  } catch (err) {
    console.warn('Không lưu được device fingerprint vào localStorage:', err);
  }
  return cached;
}

export function deviceFingerprintSync(): string {
  return cached ?? 'unknown000';
}
