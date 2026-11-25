import { Bot, Camera, ClipboardList, Home, Map as MapIcon } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { useI18n } from '../i18n';
import { onIntentPrefetch } from '../lib/prefetch';
import { useSettings } from '../state/settings';

export function BottomNav() {
  const { t } = useI18n();
  const { settings, assistantOpen, setAssistantOpen } = useSettings();
  const items = [
    { to: '/', icon: Home, label: t('nav.home'), end: true, tour: undefined },
    { to: '/map', icon: MapIcon, label: t('nav.map'), end: false, tour: 'map' },
    { to: '/report', icon: Camera, label: t('nav.report'), end: false, tour: undefined },
    { to: '/mine', icon: ClipboardList, label: t('nav.mine'), end: false, tour: undefined },
  ] as const;

  const labelCls = settings.senior ? 'text-[12px]' : 'text-[10.5px] sm:text-[11px]';

  return (
    <nav
      aria-label={t('nav.main')}
      className="safe-b fixed inset-x-0 bottom-0 z-40 border-t border-line/80 bg-surface/90 shadow-[0_-6px_24px_rgb(15_23_42/0.07)] backdrop-blur-xl md:hidden"
    >
      <ul className="mx-auto grid max-w-lg grid-cols-5">
        {items.map(({ to, icon: Icon, label, end, tour }) => (
          <li key={to} className="min-w-0">
            <NavLink
              to={to}
              end={end}
              data-tour={tour}
              onMouseEnter={() => onIntentPrefetch(to)}
              onFocus={() => onIntentPrefetch(to)}
              onClick={() => {
                if (assistantOpen) setAssistantOpen(false);
              }}
              className={({ isActive }) => {
                const active = isActive && !assistantOpen;
                return `flex min-h-14 w-full flex-col items-center justify-center gap-0.5 px-0.5 py-1 text-center font-semibold transition-colors ${labelCls} ${
                  active ? 'text-brand' : 'text-muted hover:text-ink'
                }`;
              }}
            >
              {({ isActive }) => {
                const active = isActive && !assistantOpen;
                return (
                  <>
                    <span className={`grid h-7 w-[min(2.75rem,85%)] place-items-center rounded-full transition-all ${active ? 'bg-brand-soft ring-1 ring-brand/20' : ''}`}>
                      <Icon className="h-5 w-5" aria-hidden />
                    </span>
                    <span className="w-full truncate leading-tight">{label}</span>
                  </>
                );
              }}
            </NavLink>
          </li>
        ))}
        <li className="min-w-0">
          <button
            type="button"
            data-tour="assistant"
            aria-pressed={assistantOpen}
            aria-expanded={assistantOpen}
            aria-label={t('chat.open')}
            onClick={() => setAssistantOpen(!assistantOpen)}
            className={`flex min-h-14 w-full flex-col items-center justify-center gap-0.5 px-0.5 py-1 text-center font-semibold transition-colors ${labelCls} ${
              assistantOpen ? 'text-brand' : 'text-muted hover:text-ink'
            }`}
          >
            <span className={`grid h-7 w-[min(2.75rem,85%)] place-items-center rounded-full transition-all ${assistantOpen ? 'bg-brand-soft ring-1 ring-brand/20' : ''}`}>
              <Bot className="h-5 w-5" aria-hidden />
            </span>
            <span className="w-full truncate leading-tight">{t('nav.assistant')}</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}

/** Thanh điều hướng ngang cho màn hình rộng (desktop). */
export function TopNav() {
  const { t } = useI18n();
  const { assistantOpen, setAssistantOpen } = useSettings();
  const links = [
    { to: '/', label: t('nav.home'), end: true },
    { to: '/map', label: t('nav.map'), end: false },
    { to: '/report', label: t('nav.report'), end: false },
    { to: '/mine', label: t('nav.mine'), end: false },
  ];
  return (
    <nav aria-label={t('nav.main')} className="mx-auto hidden w-full max-w-5xl px-3 pt-3 md:flex">
      <div className="inline-flex flex-wrap items-center gap-1 rounded-full border border-line/85 bg-surface/90 p-1 shadow-card backdrop-blur-md">
        {links.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.end}
            onMouseEnter={() => onIntentPrefetch(l.to)}
            onFocus={() => onIntentPrefetch(l.to)}
            onClick={() => {
              if (assistantOpen) setAssistantOpen(false);
            }}
            className={({ isActive }) =>
              `rounded-full px-4 py-1.5 text-sm font-semibold transition-all ${
                isActive && !assistantOpen ? 'btn-primary' : 'text-muted hover:bg-surface-2 hover:text-ink'
              }`
            }
          >
            {l.label}
          </NavLink>
        ))}
        <button
          type="button"
          data-tour="assistant"
          aria-pressed={assistantOpen}
          aria-expanded={assistantOpen}
          aria-label={t('chat.open')}
          onClick={() => setAssistantOpen(!assistantOpen)}
          className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold transition-all ${
            assistantOpen ? 'btn-primary' : 'text-muted hover:bg-surface-2 hover:text-ink'
          }`}
        >
          <Bot className="h-4 w-4 shrink-0" aria-hidden />
          <span>{t('nav.assistant')}</span>
        </button>
      </div>
    </nav>
  );
}
