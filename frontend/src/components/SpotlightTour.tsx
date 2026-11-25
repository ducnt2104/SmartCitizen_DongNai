import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useI18n, type I18nKey } from '../i18n';
import { useSettings } from '../state/settings';

interface Step {
  target: string;
  title: I18nKey;
  text: I18nKey;
}

const STEPS: Step[] = [
  { target: 'report', title: 'tour.s1.title', text: 'tour.s1.text' },
  { target: 'senior', title: 'tour.s2.title', text: 'tour.s2.text' },
  { target: 'map', title: 'tour.s3.title', text: 'tour.s3.text' },
  { target: 'assistant', title: 'tour.s4.title', text: 'tour.s4.text' },
];

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function findTarget(name: string): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`)];
  return all.find((el) => el.getClientRects().length > 0) ?? null;
}

/** Spotlight Tour 4 bước: làm tối nền, khoét lỗ sáng quanh nút quan trọng. Tự bật 1 lần cho người mới. */
export function SpotlightTour() {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const { settings, set, tourOpen, setTourOpen } = useSettings();
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);

  // Tự động bật 1 lần cho người mới khi đang đứng ở Trang chủ
  useEffect(() => {
    if (settings.tourSeen || pathname !== '/') return;
    const id = window.setTimeout(() => {
      if (window.location.pathname === '/') setTourOpen(true);
    }, 1200);
    return () => window.clearTimeout(id);
  }, [settings.tourSeen, pathname, setTourOpen]);

  // Tự động đóng lớp phủ hướng dẫn nếu người dùng bấm chuyển sang route khác (/report, /map...)
  useEffect(() => {
    if (tourOpen && pathname !== '/') {
      setTourOpen(false);
    }
  }, [tourOpen, pathname, setTourOpen]);

  const finish = useCallback(() => {
    setTourOpen(false);
    setI(0);
    set({ tourSeen: true });
  }, [set, setTourOpen]);

  const measure = useCallback(() => {
    const el = findTarget(STEPS[i].target);
    if (!el) {
      setRect(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setRect({ top: r.top - 6, left: r.left - 6, width: r.width + 12, height: r.height + 12 });
  }, [i]);

  useLayoutEffect(() => {
    if (!tourOpen) return;
    const el = findTarget(STEPS[i].target);
    if (el && !el.closest('nav.fixed, header.sticky')) {
      el.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
    measure();
    const onResize = (): void => measure();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    const id = window.setTimeout(measure, 250);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
      window.clearTimeout(id);
    };
  }, [tourOpen, i, measure]);

  useEffect(() => {
    if (!tourOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') finish();
      if (e.key === 'ArrowRight') setI((v) => Math.min(STEPS.length - 1, v + 1));
      if (e.key === 'ArrowLeft') setI((v) => Math.max(0, v - 1));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [tourOpen, finish]);

  if (!tourOpen) return null;
  const step = STEPS[i];
  const vh = window.innerHeight;
  const below = rect ? rect.top + rect.height + 190 < vh : true;
  const tipTop = rect ? (below ? rect.top + rect.height + 12 : Math.max(8, rect.top - 12 - 170)) : vh / 2 - 85;

  return (
    <div className="fixed inset-0 z-[3000]" role="dialog" aria-modal="true" aria-label={t('tour.open')}>
      {rect ? <div className="spot-hole" style={rect} /> : <div className="absolute inset-0 bg-slate-950/70" />}
      <div
        className="absolute left-1/2 w-[min(92vw,22rem)] -translate-x-1/2 rounded-2xl bg-surface p-4 text-ink shadow-lift"
        style={{ top: tipTop }}
      >
        <p className="text-xs font-semibold text-muted">{t('tour.step', { i: i + 1, n: STEPS.length })}</p>
        <h3 className="mt-1 text-base font-bold">{t(step.title)}</h3>
        <p className="mt-1 text-sm text-muted">{t(step.text)}</p>
        <div className="mt-3 flex items-center justify-between gap-2">
          <button type="button" className="btn btn-ghost !min-h-10 !text-sm" onClick={finish}>{t('tour.skip')}</button>
          <div className="flex gap-2">
            {i > 0 && (
              <button type="button" className="btn btn-ghost !min-h-10 !text-sm" onClick={() => setI(i - 1)}>{t('common.back')}</button>
            )}
            {i < STEPS.length - 1 ? (
              <button type="button" className="btn btn-primary !min-h-10 !text-sm" onClick={() => setI(i + 1)}>{t('common.next')}</button>
            ) : (
              <button type="button" className="btn btn-primary !min-h-10 !text-sm" onClick={finish}>{t('tour.done')}</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
