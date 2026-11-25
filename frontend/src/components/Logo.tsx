import logoMark from '../assets/logo-mark.png';

/** Logo chính thức SMARTCITIZEN ĐỒNG NAI (huy hiệu tròn tách nền từ bộ nhận diện mới). */
export function LogoMark({
  size = 36,
  className = '',
  decorative = false,
}: {
  size?: number;
  className?: string;
  decorative?: boolean;
}) {
  return (
    <img
      src={logoMark}
      alt={decorative ? '' : 'SMARTCITIZEN ĐỒNG NAI'}
      aria-hidden={decorative || undefined}
      width={size}
      height={size}
      decoding="async"
      className={`rounded-full bg-white/95 object-contain shadow-sm ring-1 ring-brand/15 select-none ${className}`}
    />
  );
}

export function Logo({
  compact = false,
  dark = false,
  stacked = false,
}: {
  compact?: boolean;
  dark?: boolean;
  stacked?: boolean;
}) {
  if (stacked) {
    return (
      <span className="inline-flex flex-col items-center gap-1.5 text-center">
        <LogoMark size={56} className="h-14 w-14 shrink-0" decorative />
        <span className="leading-tight">
          <span className="block text-sm font-extrabold tracking-tight sm:text-base">
            <span className={dark ? 'text-ioc-cyan' : 'text-brand'}>SMARTCITIZEN</span>{' '}
            <span className={dark ? 'text-ioc-text' : 'text-ink'}>ĐỒNG NAI</span>
          </span>
          <span className={`mt-0.5 block text-[11px] font-medium ${dark ? 'text-ioc-dim' : 'text-muted'}`}>
            Kết nối - Sáng tạo - Phát triển
          </span>
        </span>
      </span>
    );
  }

  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-2">
      <LogoMark
        size={compact ? 44 : 40}
        className={compact ? 'h-11 w-11 shrink-0' : 'h-9 w-9 shrink-0 sm:h-10 sm:w-10'}
        decorative={!compact}
      />
      {!compact && (
        <span className="min-w-0 leading-tight">
          <span className="block truncate text-[11px] font-extrabold tracking-tight sm:text-[13.5px]">
            <span className={dark ? 'text-ioc-cyan' : 'text-brand'}>SMARTCITIZEN</span>{' '}
            <span className={dark ? 'text-ioc-text' : 'text-ink'}>ĐỒNG NAI</span>
          </span>
          <span className={`block truncate text-[9.5px] font-medium sm:text-[11px] ${dark ? 'text-ioc-dim' : 'text-muted'}`}>
            Kết nối - Sáng tạo - Phát triển
          </span>
        </span>
      )}
    </span>
  );
}
