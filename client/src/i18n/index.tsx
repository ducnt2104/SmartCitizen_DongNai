import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useSettings } from '../state/settings';
import { vi } from './vi';
import { en } from './en';

export type I18nKey = keyof typeof vi;
const dict = { vi, en } as const;

type Vars = Record<string, string | number>;

function interpolate(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`));
}

interface Ctx {
  t: (key: I18nKey, vars?: Vars) => string;
  lang: 'vi' | 'en';
  /** Định dạng ngày giờ theo ngôn ngữ đang chọn */
  fmtDate: (iso: string, withTime?: boolean) => string;
  fmtNum: (n: number, digits?: number) => string;
}

const I18nContext = createContext<Ctx | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const lang = settings.lang;
  const t = useCallback((key: I18nKey, vars?: Vars) => interpolate(dict[lang][key] ?? dict.vi[key] ?? key, vars), [lang]);
  const value = useMemo<Ctx>(() => {
    const locale = lang === 'vi' ? 'vi-VN' : 'en-GB';
    return {
      t,
      lang,
      fmtDate: (iso, withTime = true) =>
        new Date(iso).toLocaleString(locale, withTime
          ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
          : { day: '2-digit', month: '2-digit', year: 'numeric' }),
      fmtNum: (n, digits = 0) => n.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }),
    };
  }, [lang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): Ctx {
  const c = useContext(I18nContext);
  if (!c) throw new Error('useI18n phải nằm trong <I18nProvider>');
  return c;
}
