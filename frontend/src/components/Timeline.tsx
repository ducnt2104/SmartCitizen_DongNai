import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Circle, Flame, Radio, ShieldAlert } from 'lucide-react';
import type { ClientReport, TimelineEvent, TimelineStage } from '@shared/types';
import { useI18n, type I18nKey } from '../i18n';

const STAGES: TimelineStage[] = ['received', 'verifying', 'processing', 'resolved'];
const STAGE_KEY: Record<TimelineStage, I18nKey> = {
  received: 'timeline.received',
  verifying: 'timeline.verifying',
  processing: 'timeline.processing',
  resolved: 'timeline.resolved',
};

function reached(r: ClientReport): number {
  switch (r.status) {
    case 'received': return 0;
    case 'verifying': return 1;
    case 'processing': return 2;
    case 'resolved': return 3;
    default: return 0;
  }
}

/** Timeline 4 chặng + nhật ký sự kiện chi tiết. */
export function Timeline({ r }: { r: ClientReport }) {
  const { t, fmtDate } = useI18n();
  const idx = reached(r);
  const first = (s: TimelineStage): TimelineEvent | undefined => r.timeline.find((e) => e.stage === s);
  return (
    <div>
      <ol className="grid grid-cols-4 gap-1" aria-label={t('timeline.title')}>
        {STAGES.map((s, i) => {
          const done = i <= idx && r.status !== 'quarantined' && r.status !== 'rejected';
          const ev = first(s);
          return (
            <li key={s} className="min-w-0 text-center">
              <div className="relative flex items-center justify-center">
                {i > 0 && <span className={`absolute right-1/2 top-1/2 h-0.5 w-full -translate-y-1/2 ${done ? 'bg-brand' : 'bg-line'}`} aria-hidden />}
                <span className={`relative z-10 grid h-8 w-8 place-items-center rounded-full ${done ? 'bg-brand text-brand-ink' : 'bg-surface-2 text-muted'}`}>
                  {done ? <CheckCircle2 className="h-5 w-5" aria-hidden /> : <Circle className="h-5 w-5" aria-hidden />}
                </span>
              </div>
              <p className={`mt-1 break-words text-xs font-semibold ${done ? 'text-ink' : 'text-muted'}`}>{t(STAGE_KEY[s])}</p>
              {ev && done && <p className="mono text-[10px] text-muted">{fmtDate(ev.at, false)}</p>}
            </li>
          );
        })}
      </ol>
      {(r.status === 'quarantined' || r.status === 'rejected') && (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-sm">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
          <span>{r.status === 'quarantined' ? t('timeline.quarantinedNote') : t('timeline.rejectedNote')}</span>
        </p>
      )}
      <ul className="mt-4 space-y-2 border-l-2 border-line pl-4">
        {[...r.timeline].reverse().map((e, i) => (
          <li key={`${e.at}-${i}`} className="relative text-sm">
            <span className="absolute -left-[1.4rem] top-1.5 grid h-3 w-3 place-items-center rounded-full bg-surface ring-2 ring-line">
              {e.stage === 'escalated' ? <Flame className="h-2.5 w-2.5 text-danger" aria-hidden /> : e.stage === 'dispatched' ? <Radio className="h-2.5 w-2.5 text-brand" aria-hidden /> : null}
            </span>
            <p className="mono text-[11px] text-muted">{fmtDate(e.at)}</p>
            <p className="break-words">{e.note}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Đồng hồ đếm ngược SLA (cập nhật mỗi giây khi còn dưới 1 giờ, ngược lại mỗi phút). */
export function useCountdown(iso: string | null): { label: string; overdue: boolean; ms: number } | null {
  const [now, setNow] = useState(Date.now());
  const target = iso ? Date.parse(iso) : null;
  const ms = target === null ? null : target - now;
  const fast = ms !== null && Math.abs(ms) < 3600_000;
  useEffect(() => {
    if (target === null) return;
    const id = window.setInterval(() => setNow(Date.now()), fast ? 1000 : 30_000);
    return () => window.clearInterval(id);
  }, [target, fast]);
  if (ms === null) return null;
  const abs = Math.abs(ms);
  const d = Math.floor(abs / 86400000);
  const h = Math.floor((abs % 86400000) / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  const s = Math.floor((abs % 60000) / 1000);
  const label = d > 0 ? `${d}d ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m` : `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return { label, overdue: ms < 0, ms };
}

export function SlaClock({ iso, dark = false }: { iso: string | null; dark?: boolean }) {
  const { t } = useI18n();
  const c = useCountdown(iso);
  if (!c) return <span className="mono text-xs text-muted">—</span>;
  const tone = c.overdue ? (dark ? 'text-ioc-red' : 'text-danger') : c.ms < 4 * 3600_000 ? (dark ? 'text-ioc-amber' : 'text-warn') : dark ? 'text-ioc-green' : 'text-ok';
  return (
    <span className={`mono text-xs font-semibold ${tone}`} title={t('sla.title')}>
      {c.overdue ? `${t('sla.overdue')} ` : ''}{c.label}
    </span>
  );
}

/** Thanh kéo so sánh ảnh Trước – Sau (chuột, cảm ứng và bàn phím ←/→). */
export function BeforeAfterSlider({ before, after, labelBefore, labelAfter }: { before: string; after: string; labelBefore: string; labelAfter: string }) {
  const [pos, setPos] = useState(50);
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const move = (clientX: number): void => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)));
  };

  return (
    <div
      ref={box}
      className="ba-slider relative aspect-[16/10] w-full overflow-hidden rounded-2xl border border-line bg-surface-2"
      onPointerDown={(e) => {
        dragging.current = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        move(e.clientX);
      }}
      onPointerMove={(e) => dragging.current && move(e.clientX)}
      onPointerUp={() => { dragging.current = false; }}
      onPointerCancel={() => { dragging.current = false; }}
    >
      <img src={after} alt={labelAfter} width={800} height={500} decoding="async" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
      <div className="absolute inset-0 overflow-hidden" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
        <img src={before} alt={labelBefore} width={800} height={500} decoding="async" className="h-full w-full object-cover" draggable={false} />
      </div>
      <span className="absolute left-2 top-2 rounded-full bg-slate-900/80 px-2.5 py-1 text-xs font-bold text-white">{labelBefore}</span>
      <span className="absolute right-2 top-2 rounded-full bg-ok px-2.5 py-1 text-xs font-bold text-white">{labelAfter}</span>
      <div className="absolute inset-y-0 w-0.5 bg-white shadow" style={{ left: `${pos}%` }} aria-hidden />
      <button
        type="button"
        role="slider"
        aria-label={`${labelBefore} / ${labelAfter}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pos)}
        className="absolute top-1/2 grid h-11 w-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-white bg-brand text-brand-ink shadow-lift"
        style={{ left: `${pos}%` }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') setPos((p) => Math.max(0, p - 5));
          if (e.key === 'ArrowRight') setPos((p) => Math.min(100, p + 5));
        }}
      >
        <span aria-hidden className="text-sm font-black">⇆</span>
      </button>
    </div>
  );
}
