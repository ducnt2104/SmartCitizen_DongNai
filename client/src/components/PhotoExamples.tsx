import { Check, X } from 'lucide-react';
import { useI18n } from '../i18n';

function Frame({ children, ok, caption }: { children: React.ReactNode; ok: boolean; caption: string }) {
  return (
    <figure className="min-w-0">
      <div className={`relative aspect-[4/3] overflow-hidden rounded-xl border-2 ${ok ? 'border-ok' : 'border-danger'}`}>
        {children}
        <span className={`absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full text-white ${ok ? 'bg-ok' : 'bg-danger'}`}>
          {ok ? <Check className="h-4 w-4" aria-hidden /> : <X className="h-4 w-4" aria-hidden />}
        </span>
      </div>
      <figcaption className={`mt-1 break-words text-center text-xs font-semibold ${ok ? 'text-ok' : 'text-danger'}`}>{caption}</figcaption>
    </figure>
  );
}

/** Ví dụ trực quan: Ảnh đạt chuẩn vs. Ảnh mờ / chụp màn hình / không liên quan (minh họa vector, không dùng ảnh thật). */
export function PhotoExamples() {
  const { t } = useI18n();
  return (
    <section aria-label={t('photo.examplesTitle')} className="rounded-2xl border border-line bg-surface p-3">
      <h3 className="mb-2 text-sm font-bold">{t('photo.examplesTitle')}</h3>
      <div className="grid grid-cols-3 gap-2">
        <Frame ok caption={t('photo.good')}>
          <svg viewBox="0 0 160 120" className="h-full w-full" aria-hidden>
            <rect width="160" height="120" fill="#cbd5e1" />
            <rect y="70" width="160" height="50" fill="#475569" />
            <rect x="20" y="95" width="30" height="4" fill="#e2e8f0" />
            <rect x="85" y="95" width="30" height="4" fill="#e2e8f0" />
            <ellipse cx="70" cy="86" rx="30" ry="9" fill="#1e293b" />
            <ellipse cx="70" cy="85" rx="20" ry="5" fill="#0b1220" />
            <path d="M40 84 30 80M100 88l12-3" stroke="#0f172a" strokeWidth="2" />
          </svg>
        </Frame>
        <Frame ok={false} caption={t('photo.blurry')}>
          <svg viewBox="0 0 160 120" className="h-full w-full" aria-hidden>
            <defs><filter id="blr"><feGaussianBlur stdDeviation="5" /></filter></defs>
            <g filter="url(#blr)">
              <rect width="160" height="120" fill="#cbd5e1" />
              <rect y="70" width="160" height="50" fill="#475569" />
              <ellipse cx="70" cy="86" rx="30" ry="9" fill="#1e293b" />
            </g>
          </svg>
        </Frame>
        <Frame ok={false} caption={t('photo.screen')}>
          <svg viewBox="0 0 160 120" className="h-full w-full" aria-hidden>
            <rect width="160" height="120" fill="#0f172a" />
            <rect x="8" y="8" width="144" height="92" rx="4" fill="#e2e8f0" />
            <rect x="8" y="8" width="144" height="10" rx="4" fill="#94a3b8" />
            <circle cx="16" cy="13" r="2" fill="#ef4444" /><circle cx="23" cy="13" r="2" fill="#f59e0b" /><circle cx="30" cy="13" r="2" fill="#22c55e" />
            <rect x="20" y="30" width="60" height="6" fill="#cbd5e1" /><rect x="20" y="42" width="110" height="40" fill="#cbd5e1" />
            <rect x="60" y="104" width="40" height="8" fill="#334155" />
          </svg>
        </Frame>
      </div>
      <ul className="mt-2 space-y-0.5 text-xs text-muted">
        <li>• {t('photo.tip1')}</li>
        <li>• {t('photo.tip2')}</li>
        <li>• {t('photo.tip3')}</li>
      </ul>
    </section>
  );
}
