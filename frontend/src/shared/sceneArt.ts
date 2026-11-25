import type { Category } from './types';

/**
 * Ảnh minh họa dạng SVG cho dữ liệu mẫu (seed). Đây KHÔNG phải ảnh hiện trường thật;
 * mỗi ảnh được gắn nhãn "Ảnh minh họa dữ liệu mẫu" để minh bạch với Ban Giám Khảo.
 */
export type SceneKind = 'before' | 'after' | 'angle';

function svgWrap(inner: string, bg1: string, bg2: string, label: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400" width="640" height="400">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/></linearGradient></defs>` +
    `<rect width="640" height="400" fill="url(#g)"/>${inner}` +
    `<rect x="0" y="372" width="640" height="28" fill="#0f172a" opacity="0.72"/>` +
    `<text x="12" y="391" font-family="sans-serif" font-size="13" fill="#e2e8f0">${label}</text></svg>`
  );
}

function road(y = 250): string {
  return `<rect y="${y}" width="640" height="${400 - y}" fill="#475569"/><rect x="40" y="${y + 60}" width="80" height="8" fill="#e2e8f0"/><rect x="240" y="${y + 60}" width="80" height="8" fill="#e2e8f0"/><rect x="440" y="${y + 60}" width="80" height="8" fill="#e2e8f0"/>`;
}

function trash(v: number, after: boolean): string {
  if (after) return `${road(260)}<rect x="500" y="200" width="18" height="60" fill="#334155"/><circle cx="509" cy="196" r="14" fill="#22c55e"/>`;
  let s = `${road(260)}`;
  const n = 7 + (v % 4);
  for (let i = 0; i < n; i++) {
    const x = 180 + ((i * 53 + v * 31) % 260);
    const y = 235 + ((i * 29 + v * 17) % 70);
    const r = 16 + ((i * 7 + v) % 18);
    const c = ['#0f172a', '#16a34a', '#a16207', '#1e3a8a', '#7f1d1d'][(i + v) % 5];
    s += `<ellipse cx="${x}" cy="${y}" rx="${r + 8}" ry="${r}" fill="${c}"/>`;
  }
  return s;
}

function lamp(v: number, after: boolean): string {
  const glow = after
    ? `<circle cx="330" cy="92" r="70" fill="#fde68a" opacity="0.55"/><circle cx="330" cy="92" r="16" fill="#fef08a"/>`
    : `<circle cx="330" cy="92" r="14" fill="#64748b"/><path d="M322 100 l16 40" stroke="#0f172a" stroke-width="3"/>`;
  return `${road(290)}<rect x="326" y="90" width="8" height="200" fill="#334155"/><rect x="326" y="84" width="60" height="8" fill="#334155"/>${glow}` +
    (v % 2 ? `<rect x="120" y="150" width="6" height="140" fill="#334155"/>` : '');
}

function flood(v: number, after: boolean): string {
  if (after) return `${road(250)}<rect x="420" y="170" width="100" height="80" fill="#94a3b8"/><rect x="440" y="190" width="24" height="60" fill="#475569"/>`;
  return `${road(250)}<rect y="${270 - (v % 3) * 6}" width="640" height="130" fill="#0ea5e9" opacity="0.75"/>` +
    `<path d="M0 300 q40 -12 80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0" stroke="#e0f2fe" stroke-width="3" fill="none"/>` +
    `<rect x="420" y="170" width="100" height="100" fill="#94a3b8"/>`;
}

function pothole(v: number, after: boolean): string {
  if (after) return `${road(200)}<ellipse cx="320" cy="320" rx="90" ry="22" fill="#334155"/>`;
  return `${road(200)}<ellipse cx="${300 + (v % 5) * 12}" cy="320" rx="70" ry="22" fill="#1e293b"/><path d="M240 318 l-30 -10 M390 322 l32 -8 M330 296 l6 -18" stroke="#0f172a" stroke-width="3"/>` +
    `<ellipse cx="${300 + (v % 5) * 12}" cy="318" rx="52" ry="14" fill="#0b1220"/>`;
}

export function sceneSvg(category: Category, variant: number, kind: SceneKind): string {
  const after = kind === 'after';
  const label = after ? 'Ảnh minh họa dữ liệu mẫu — SAU xử lý' : 'Ảnh minh họa dữ liệu mẫu — hiện trường';
  const sky = after ? ['#bae6fd', '#e0f2fe'] : ['#cbd5e1', '#94a3b8'];
  const inner =
    category === 'rac_thai' ? trash(variant, after)
    : category === 'den_duong' ? lamp(variant, after)
    : category === 'ngap_nuoc' ? flood(variant, after)
    : pothole(variant, after);
  const angleShift = kind === 'angle' ? `<g transform="translate(${(variant % 3) * 26 - 26} 0) rotate(${(variant % 5) - 2} 320 200)">${inner}</g>` : inner;
  return svgWrap(angleShift, sky[0], sky[1], label);
}

export function sceneDataUrl(category: Category, variant: number, kind: SceneKind): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(sceneSvg(category, variant, kind))}`;
}
