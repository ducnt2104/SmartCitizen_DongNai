import { Camera, Home, Map as MapIcon, ClipboardList } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { useI18n } from '../i18n';
import { useSettings } from '../state/settings';

export function BottomNav() {
  const { t } = useI18n();
  const { settings } = useSettings();
  const items = [
    { to: '/', icon: Home, label: t('nav.home'), end: true, tour: undefined },
    { to: '/map', icon: MapIcon, label: t('nav.map'), end: false, tour: 'map' },
    { to: '/report', icon: Camera, label: t('nav.report'), end: false, tour: undefined },
    { to: '/mine', icon: ClipboardList, label: t('nav.mine'), end: false, tour: undefined },
  ] as const;
  return (
    <nav aria-label={t('nav.main')} className="safe-b fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 md:hidden">
      <ul className="mx-auto grid max-w-md grid-cols-4">
        {items.map(({ to, icon: Icon, label, end }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-center font-semibold ${settings.senior ? 'text-sm' : 'text-[11px]'} ${
                  isActive ? 'text-brand' : 'text-muted'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <span className={`grid h-8 w-14 place-items-center rounded-full ${isActive ? 'bg-brand-soft' : ''}`}>
                    <Icon className="h-5 w-5" aria-hidden />
                  </span>
                  <span className="max-w-full truncate">{label}</span>
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Thanh điều hướng ngang cho màn hình rộng (desktop). */
export function TopNav() {
  const { t } = useI18n();
  const links = [
    { to: '/', label: t('nav.home'), end: true },
    { to: '/map', label: t('nav.map'), end: false },
    { to: '/report', label: t('nav.report'), end: false },
    { to: '/mine', label: t('nav.mine'), end: false },
  ];
  return (
    <nav aria-label={t('nav.main')} className="mx-auto hidden max-w-5xl gap-1 px-3 pt-3 md:flex">
      {links.map((l) => (
        <NavLink
          key={l.to}
          to={l.to}
          end={l.end}
          className={({ isActive }) => `rounded-full px-4 py-2 text-sm font-semibold ${isActive ? 'bg-brand text-brand-ink' : 'text-muted hover:bg-surface-2'}`}
        >
          {l.label}
        </NavLink>
      ))}
    </nav>
  );
}
