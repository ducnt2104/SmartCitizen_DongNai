import { Bot, Camera, ClipboardList, Home, Map as MapIcon } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { useI18n } from '../i18n';
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
    <nav aria-label={t('nav.main')} className="safe-b fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur-md md:hidden">
      <ul className="mx-auto grid max-w-lg grid-cols-5">
        {items.map(({ to, icon: Icon, label, end, tour }) => (
          <li key={to} className="min-w-0">
            <NavLink
              to={to}
              end={end}
              data-tour={tour}
              onClick={() => {
                if (assistantOpen) setAssistantOpen(false);
              }}
              className={({ isActive }) => {
                const active = isActive && !assistantOpen;
                return `flex min-h-14 w-full flex-col items-center justify-center gap-0.5 px-0.5 py-1 text-center font-semibold ${labelCls} ${
                  active ? 'text-brand' : 'text-muted'
                }`;
              }}
            >
              {({ isActive }) => {
                const active = isActive && !assistantOpen;
                return (
                  <>
                    <span className={`grid h-7 w-[min(2.75rem,85%)] place-items-center rounded-full transition-colors ${active ? 'bg-brand-soft' : ''}`}>
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
            className={`flex min-h-14 w-full flex-col items-center justify-center gap-0.5 px-0.5 py-1 text-center font-semibold ${labelCls} ${
              assistantOpen ? 'text-brand' : 'text-muted'
            }`}
          >
            <span className={`grid h-7 w-[min(2.75rem,85%)] place-items-center rounded-full transition-colors ${assistantOpen ? 'bg-brand-soft' : ''}`}>
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
    <nav aria-label={t('nav.main')} className="mx-auto hidden max-w-5xl flex-wrap items-center gap-1 px-3 pt-3 md:flex">
      {links.map((l) => (
        <NavLink
          key={l.to}
          to={l.to}
          end={l.end}
          onClick={() => {
            if (assistantOpen) setAssistantOpen(false);
          }}
          className={({ isActive }) =>
            `rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
              isActive && !assistantOpen ? 'bg-brand text-brand-ink' : 'text-muted hover:bg-surface-2'
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
        className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
          assistantOpen ? 'bg-brand text-brand-ink' : 'text-muted hover:bg-surface-2'
        }`}
      >
        <Bot className="h-4 w-4 shrink-0" aria-hidden />
        <span>{t('nav.assistant')}</span>
      </button>
    </nav>
  );
}
