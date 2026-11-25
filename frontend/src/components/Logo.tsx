import { useId } from 'react';

/** Logo SVG tùy biến: Khiên + ghim bản đồ + sóng số (xanh dương – vàng cam). */
export function LogoMark({ size = 36, className = '' }: { size?: number; className?: string }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="SmartCitizen_DongNai" className={className}>
      <defs>
        <clipPath id={`${id}-c`}>
          <path d="M32 3 8 12v18c0 15 10 26 24 31 14-5 24-16 24-31V12L32 3Z" />
        </clipPath>
      </defs>
      <path d="M32 3 8 12v18c0 15 10 26 24 31 14-5 24-16 24-31V12L32 3Z" fill="#0B57D0" />
      <g clipPath={`url(#${id}-c)`}>
        <rect x="32" y="0" width="30" height="64" fill="#0A4BB5" />
      </g>
      <path d="M32 15c-7 0-12.5 5.2-12.5 11.8C19.5 35.200 32 46 32 46s12.5-10.800 12.500-19.200C44.500 20.200 39 15 32 15Z" fill="#fff" />
      <circle cx="32" cy="26.500" r="5" fill="#F59E0B" />
      <path d="M13 51c4.500-3.500 8.500-3.500 13 0s8.500 3.500 13 0 8.500-3.500 12 0" fill="none" stroke="#F59E0B" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ compact = false, dark = false }: { compact?: boolean; dark?: boolean }) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 sm:gap-2">
      <LogoMark size={compact ? 30 : 36} className={compact ? 'shrink-0' : 'h-8 w-8 shrink-0 sm:h-9 sm:w-9'} />
      {!compact && (
        <span className="min-w-0 leading-tight">
          <span className={`block truncate text-[12.5px] font-bold tracking-tight sm:text-base ${dark ? 'text-ioc-text' : 'text-ink'}`}>
            SmartCitizen<span className="text-accent">_</span>DongNai
          </span>
          <span className={`block truncate text-[11px] font-medium ${dark ? 'text-ioc-dim' : 'text-muted'}`}>Team Victer</span>
        </span>
      )}
    </span>
  );
}
