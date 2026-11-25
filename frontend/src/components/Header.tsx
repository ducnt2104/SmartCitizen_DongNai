import { CircleHelp, Globe2, LogIn, LogOut, MapPin, Settings as SettingsIcon, ShieldCheck, UserCog, UserRound, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { DONG_NAI_WARDS, getWard } from '../data/dongNaiWards';
import { useStats } from '../db/hooks';
import { useI18n } from '../i18n';
import { authStore, useSession } from '../lib/authStore';
import { useSettings } from '../state/settings';
import { Logo } from './Logo';

const WARDS_PHUONG = DONG_NAI_WARDS.filter((w) => w.kind === 'Phường');
const WARDS_XA = DONG_NAI_WARDS.filter((w) => w.kind === 'Xã');

export function ScopePicker({ dark = false }: { dark?: boolean }) {
  const { t } = useI18n();
  const { settings, set } = useSettings();
  const cityStats = useStats('city');
  const isCity = settings.scope === 'city';
  const selectedWardCode = settings.scope.startsWith('ward:') ? settings.scope.slice(5) : '';
  const selectedWard = selectedWardCode ? getWard(selectedWardCode) : undefined;
  const base = dark ? 'ioc-btn' : 'btn btn-ghost !min-h-10 !px-3 !text-sm';
  const active = dark ? 'ioc-btn-cyan' : '!border-brand !bg-brand !text-brand-ink';

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('scope.label')}>
      <button type="button" aria-pressed={isCity} className={`${base} ${isCity ? active : ''}`} onClick={() => set({ scope: 'city' })}>
        <Globe2 className="h-4 w-4" aria-hidden />
        {t('scope.cityAll', { n: cityStats?.total ?? 80 })}
      </button>
      {selectedWard && (
        <span className={`inline-flex items-center gap-1 rounded-xl px-2.5 py-1.5 text-xs font-bold ${dark ? 'border border-ioc-cyan/40 bg-ioc-raised text-ioc-cyan' : 'bg-brand-soft text-brand'}`}>
          <MapPin className="h-3.5 w-3.5" aria-hidden />
          {selectedWard.name}
        </span>
      )}
      <label className="sr-only" htmlFor="scope-ward">{t('scope.other')}</label>
      <select
        id="scope-ward"
        value={settings.scope.startsWith('ward:') ? settings.scope : ''}
        onChange={(e) => set({ scope: e.target.value || 'city' })}
        className={dark ? 'ioc-field' : 'field !min-h-10 !w-auto !px-2.5 !py-1 !text-sm'}
      >
        <option value="">{t('scope.other')}</option>
        <optgroup label={t('scope.groupPhuong')}>
          {WARDS_PHUONG.map((w) => (
            <option key={w.wardCode} value={`ward:${w.wardCode}`}>{w.name}</option>
          ))}
        </optgroup>
        <optgroup label={t('scope.groupXa')}>
          {WARDS_XA.map((w) => (
            <option key={w.wardCode} value={`ward:${w.wardCode}`}>{w.name}</option>
          ))}
        </optgroup>
      </select>
    </div>
  );
}

function UserMenu() {
  const { t } = useI18n();
  const session = useSession();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (!session) {
    return (
      <Link to="/auth" className="btn btn-primary !min-h-10 !px-3 !text-sm">
        <LogIn className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">{t('nav.login')}</span>
      </Link>
    );
  }
  const u = session.user;
  return (
    <div className="relative" ref={ref}>
      <button type="button" className="btn btn-ghost !min-h-10 !px-2" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((v) => !v)} aria-label={t('nav.account')}>
        <UserRound className="h-5 w-5" aria-hidden />
        <span className="hidden max-w-[8rem] truncate text-sm sm:inline">{u.name}</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-50 mt-2 w-64 animate-pop rounded-2xl border border-line bg-surface p-2 shadow-lift">
          <div className="px-3 py-2">
            <p className="truncate font-semibold">{u.name}</p>
            <p className="text-xs text-muted">{t(`role.${u.role}`)} · {t('auth.trust')}: <span className="mono">{u.trustScore}</span></p>
            {u.supervised && <p className="mt-1 text-xs font-semibold text-danger">{t('auth.supervised')}</p>}
          </div>
          <button role="menuitem" type="button" className="btn btn-ghost mb-1 w-full !justify-start" onClick={() => { setOpen(false); nav('/profile'); }}>
            <UserCog className="h-4 w-4" aria-hidden /> {t('nav.profile')}
          </button>
          {u.role === 'volunteer' && (
            <button role="menuitem" type="button" className="btn btn-ghost mb-1 w-full !justify-start" onClick={() => { setOpen(false); nav('/volunteer'); }}>
              <Users className="h-4 w-4" aria-hidden /> {t('nav.volunteer')}
            </button>
          )}
          {(u.role === 'ward_officer' || u.role === 'city_admin' || u.role === 'super_admin') && (
            <button role="menuitem" type="button" className="btn btn-ghost mb-1 w-full !justify-start" onClick={() => { setOpen(false); nav('/admin'); }}>
              <ShieldCheck className="h-4 w-4" aria-hidden /> {t('nav.admin')}
            </button>
          )}
          <button
            role="menuitem"
            type="button"
            className="btn btn-ghost w-full !justify-start"
            onClick={() => {
              setOpen(false);
              void authStore.signOut().then(() => nav('/'));
            }}
          >
            <LogOut className="h-4 w-4" aria-hidden /> {t('nav.logout')}
          </button>
        </div>
      )}
    </div>
  );
}

export function Header({ showScope = true }: { showScope?: boolean }) {
  const { t } = useI18n();
  const { settings, toggleSenior, setDrawerOpen, setTourOpen } = useSettings();
  const nav = useNavigate();
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/95">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
        <Link to="/" className="min-w-0 shrink" aria-label={t('nav.home')}>
          <Logo />
        </Link>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            data-tour="senior"
            aria-pressed={settings.senior}
            onClick={toggleSenior}
            className={`btn !min-h-10 !px-3 !text-sm ${settings.senior ? 'btn-primary' : 'btn-soft'}`}
            title={t('senior.toggleHint')}
          >
            <span className="font-extrabold">Aa+</span> <span className="hidden sm:inline">{t('senior.toggle')}</span>
          </button>
          <button type="button" className="btn btn-ghost !min-h-10 !px-2.5" onClick={() => { nav('/'); setTourOpen(true); }} aria-label={t('tour.open')} title={t('tour.open')}>
            <CircleHelp className="h-5 w-5" aria-hidden /> <span className="hidden text-sm md:inline">{t('tour.open')}</span>
          </button>
          <button type="button" className="btn btn-ghost !min-h-10 !px-2.5" onClick={() => setDrawerOpen(true)} aria-label={t('settings.title')} title={t('settings.title')}>
            <SettingsIcon className="h-5 w-5" aria-hidden />
          </button>
          <UserMenu />
        </div>
        {showScope && (
          <div className="w-full">
            <ScopePicker />
          </div>
        )}
      </div>
    </header>
  );
}
