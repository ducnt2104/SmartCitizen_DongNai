import { useRef, useState } from 'react';

/** Thanh kéo so sánh ảnh Trước – Sau (chuột, cảm ứng và bàn phím ←/→). */
export function BeforeAfterSlider({
  before,
  after,
  labelBefore,
  labelAfter,
}: {
  before: string;
  after: string;
  labelBefore: string;
  labelAfter: string;
}) {
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
      onPointerUp={() => {
        dragging.current = false;
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
    >
      <img
        src={after}
        alt={labelAfter}
        width={800}
        height={500}
        loading="lazy"
        decoding="async"
        className="absolute inset-0 h-full w-full object-cover"
        draggable={false}
      />
      <div className="absolute inset-0 overflow-hidden" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
        <img
          src={before}
          alt={labelBefore}
          width={800}
          height={500}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
          draggable={false}
        />
      </div>
      <span className="absolute left-2 top-2 rounded-full bg-slate-900/80 px-2.5 py-1 text-xs font-bold text-white">
        {labelBefore}
      </span>
      <span className="absolute right-2 top-2 rounded-full bg-ok px-2.5 py-1 text-xs font-bold text-white">
        {labelAfter}
      </span>
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
        <span aria-hidden className="text-sm font-black">
          ⇆
        </span>
      </button>
    </div>
  );
}
