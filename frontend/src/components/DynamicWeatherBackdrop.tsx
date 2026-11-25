import type { WeatherKind } from '../lib/weather';

const RAIN_DROPS = [
  { left: '6%', top: '-12%', delay: '0s', dur: '1.05s', h: 18 },
  { left: '14%', top: '-8%', delay: '0.35s', dur: '1.2s', h: 22 },
  { left: '22%', top: '-15%', delay: '0.7s', dur: '1.1s', h: 16 },
  { left: '30%', top: '-10%', delay: '0.15s', dur: '1.25s', h: 20 },
  { left: '38%', top: '-14%', delay: '0.55s', dur: '1.0s', h: 24 },
  { left: '47%', top: '-6%', delay: '0.85s', dur: '1.18s', h: 18 },
  { left: '55%', top: '-12%', delay: '0.25s', dur: '1.12s', h: 22 },
  { left: '63%', top: '-16%', delay: '0.6s', dur: '1.22s', h: 17 },
  { left: '72%', top: '-9%', delay: '0.4s', dur: '1.08s', h: 21 },
  { left: '80%', top: '-14%', delay: '0.9s', dur: '1.15s', h: 19 },
  { left: '88%', top: '-11%', delay: '0.1s', dur: '1.24s', h: 22 },
  { left: '95%', top: '-15%', delay: '0.5s', dur: '1.05s', h: 16 },
] as const;

const STARS = [
  { left: '12%', top: '18%', delay: '0s', size: 2 },
  { left: '24%', top: '34%', delay: '1.1s', size: 2.5 },
  { left: '38%', top: '14%', delay: '2.2s', size: 2 },
  { left: '52%', top: '26%', delay: '0.6s', size: 3 },
  { left: '66%', top: '16%', delay: '1.8s', size: 2 },
  { left: '78%', top: '30%', delay: '2.9s', size: 2.5 },
  { left: '89%', top: '20%', delay: '0.9s', size: 2 },
  { left: '19%', top: '58%', delay: '1.6s', size: 2 },
  { left: '44%', top: '48%', delay: '2.5s', size: 2.5 },
  { left: '71%', top: '52%', delay: '0.3s', size: 2 },
] as const;

const SUN_MOTES = [
  { left: '68%', top: '22%', delay: '0s', size: 6 },
  { left: '76%', top: '42%', delay: '1.4s', size: 4 },
  { left: '84%', top: '28%', delay: '2.3s', size: 5 },
  { left: '62%', top: '36%', delay: '0.8s', size: 4 },
  { left: '88%', top: '48%', delay: '1.9s', size: 6 },
] as const;

export function getWeatherCardGradient(kind: WeatherKind, isDay: boolean): string {
  if (!isDay) {
    if (kind === 'storm') return 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 58%, #312e81 100%)';
    return 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%)';
  }
  switch (kind) {
    case 'sun':
    case 'partlyCloudy':
      return 'linear-gradient(135deg, #0284c7 0%, #1e40af 100%)';
    case 'cloud':
      return 'linear-gradient(135deg, #334155 0%, #1e293b 100%)';
    case 'rain':
    case 'heavyRain':
      return 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)';
    case 'storm':
      return 'linear-gradient(135deg, #1e1b4b 0%, #0f172a 55%, #1e293b 100%)';
  }
}

function CloudSilhouette({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 240 100" className={className} fill="currentColor" aria-hidden="true">
      <path d="M52 84h136c20 0 36-14 36-32 0-16-12-29-28-31C190 9 175 0 156 0c-19 0-35 11-41 27-6-3-13-5-21-5-22 0-40 17-41 38-15 2-27 12-27 24 0 0 0 0 26 0z" />
    </svg>
  );
}

/**
 * Lớp nền thời tiết động thuần CSS/SVG (z-0, pointer-events-none):
 * tự động chuyển cảnh theo `kind` (nắng, nhiều mây, mưa, dông) và `isDay` (ngày/đêm).
 */
export function DynamicWeatherBackdrop({ kind, isDay }: { kind: WeatherKind; isDay: boolean }) {
  const showSun = isDay && (kind === 'sun' || kind === 'partlyCloudy');
  const showClouds = kind === 'partlyCloudy' || kind === 'cloud' || kind === 'rain' || kind === 'heavyRain' || kind === 'storm';
  const showRain = kind === 'rain' || kind === 'heavyRain' || kind === 'storm';
  const showStorm = kind === 'storm';

  return (
    <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden" aria-hidden="true">
      {/* Ban ngày trời nắng / ít mây: quầng sáng mặt trời ấm góc trên phải + hạt sáng lơ lửng */}
      {showSun && (
        <>
          <div
            className="wx-sun-glow absolute -right-14 -top-14 h-64 w-64 rounded-full"
            style={{
              background: 'radial-gradient(circle, rgba(253, 224, 71, 0.55) 0%, rgba(251, 191, 36, 0.22) 45%, transparent 72%)',
            }}
          />
          <div
            className="wx-sun-glow absolute -right-4 -top-4 h-36 w-36 rounded-full"
            style={{
              background: 'radial-gradient(circle, rgba(254, 249, 195, 0.45) 0%, transparent 70%)',
              animationDelay: '1.5s',
            }}
          />
          {SUN_MOTES.map((m, idx) => (
            <span
              key={idx}
              className="wx-float-dot absolute rounded-full bg-amber-100/50 blur-[1px]"
              style={{ left: m.left, top: m.top, width: m.size, height: m.size, animationDelay: m.delay }}
            />
          ))}
        </>
      )}

      {/* Ban đêm: bầu trời sao lấp lánh nhẹ + vầng trăng khuyết mờ */}
      {!isDay && (
        <>
          <div
            className="absolute -right-8 -top-8 h-48 w-48 rounded-full opacity-35"
            style={{
              background: 'radial-gradient(circle, rgba(199, 210, 254, 0.42) 0%, rgba(99, 102, 241, 0.14) 50%, transparent 72%)',
            }}
          />
          {STARS.map((s, idx) => (
            <span
              key={idx}
              className="wx-star absolute rounded-full bg-white"
              style={{ left: s.left, top: s.top, width: s.size, height: s.size, animationDelay: s.delay }}
            />
          ))}
        </>
      )}

      {/* Lớp mây SVG bán trong suốt trôi ngang chậm rãi */}
      {showClouds && (
        <>
          <CloudSilhouette
            className={`wx-cloud-slow absolute -left-8 top-3 w-64 text-white sm:w-80 ${
              kind === 'partlyCloudy' ? 'opacity-[0.14]' : kind === 'storm' ? 'opacity-[0.22]' : 'opacity-[0.18]'
            }`}
          />
          <CloudSilhouette
            className={`wx-cloud-med absolute right-4 top-12 w-56 text-slate-100 sm:w-72 ${
              kind === 'partlyCloudy' ? 'opacity-[0.12]' : kind === 'storm' ? 'opacity-[0.24]' : 'opacity-[0.16]'
            }`}
          />
          {(kind === 'cloud' || kind === 'heavyRain' || kind === 'storm') && (
            <CloudSilhouette className="wx-cloud-slow absolute left-1/3 -bottom-4 w-72 text-slate-200 opacity-[0.12]" />
          )}
        </>
      )}

      {/* Hạt mưa rơi nghiêng liên tục */}
      {showRain &&
        RAIN_DROPS.slice(0, kind === 'rain' ? 8 : 12).map((d, idx) => (
          <span
            key={idx}
            className="wx-rain-drop absolute w-[1.5px] rounded-full bg-gradient-to-b from-transparent via-sky-200/75 to-sky-100/20"
            style={{
              left: d.left,
              top: d.top,
              height: d.h,
              animationDelay: d.delay,
              animationDuration: d.dur,
            }}
          />
        ))}

      {/* Dông bão: chớp sáng mờ thoáng qua nhẹ nhàng ở tầng nền */}
      {showStorm && <div className="wx-lightning absolute inset-0 bg-indigo-200" />}

      {/* Lớp scrim tối nhẹ ở nửa dưới để chữ trắng luôn đạt độ tương phản cao cho người lớn tuổi */}
      <div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(180deg, rgba(15, 23, 42, 0.08) 0%, rgba(15, 23, 42, 0.34) 100%)' }}
      />
    </div>
  );
}
