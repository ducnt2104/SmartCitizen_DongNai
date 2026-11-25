import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { putSetting } from '../db/localDb';

export type DisplayMode = 'light' | 'dark' | 'contrast';
export type ColorTheme = 'gov' | 'youth';
export type FontScale = 100 | 125 | 150;
export type Lang = 'vi' | 'en';

export interface Settings {
  mode: DisplayMode;
  theme: ColorTheme;
  fontScale: FontScale;
  lang: Lang;
  senior: boolean;
  /** Phạm vi địa bàn: 'city' hoặc 'ward:DN-XXX' */
  scope: string;
  tourSeen: boolean;
  /** Cỡ chữ trước khi bật Senior để khôi phục */
  prevFontScale: FontScale;
}

const KEY = 'sc.settings.v2';
const DEFAULTS: Settings = {
  mode: 'light', theme: 'gov', fontScale: 100, lang: 'vi', senior: false, scope: 'city', tourSeen: false, prevFontScale: 100,
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch (err) {
    console.warn('Cài đặt cục bộ bị hỏng, dùng mặc định:', err);
  }
  return DEFAULTS;
}

interface Ctx {
  settings: Settings;
  set: (patch: Partial<Settings>) => void;
  toggleSenior: () => void;
  drawerOpen: boolean;
  setDrawerOpen: (v: boolean) => void;
  tourOpen: boolean;
  setTourOpen: (v: boolean) => void;
  assistantOpen: boolean;
  setAssistantOpen: (v: boolean) => void;
}

const SettingsContext = createContext<Ctx | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(load);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.mode = settings.mode;
    root.dataset.theme = settings.theme;
    root.dataset.senior = String(settings.senior);
    root.lang = settings.lang;
    root.style.setProperty('--font-px', `${(16 * (settings.senior ? 150 : settings.fontScale)) / 100}px`);
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute('content', settings.mode === 'dark' ? '#0B1220' : settings.theme === 'youth' ? '#0284C7' : '#0B57D0');
    localStorage.setItem(KEY, JSON.stringify(settings));
    putSetting('ui', settings).catch((err) => console.warn('Không đồng bộ cài đặt vào IndexedDB:', err));
  }, [settings]);

  const set = useCallback((patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })), []);
  const toggleSenior = useCallback(() => {
    setSettings((s) =>
      s.senior
        ? { ...s, senior: false, fontScale: s.prevFontScale }
        : { ...s, senior: true, prevFontScale: s.fontScale, fontScale: 150 },
    );
  }, []);

  const value = useMemo(
    () => ({ settings, set, toggleSenior, drawerOpen, setDrawerOpen, tourOpen, setTourOpen, assistantOpen, setAssistantOpen }),
    [settings, set, toggleSenior, drawerOpen, tourOpen, assistantOpen],
  );
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): Ctx {
  const c = useContext(SettingsContext);
  if (!c) throw new Error('useSettings phải nằm trong <SettingsProvider>');
  return c;
}
