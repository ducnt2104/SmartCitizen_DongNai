import { Eye, EyeOff, KeyRound, Languages, Moon, Palette, Sun, SunMedium, Type, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { getStoredGeminiApiKey, saveStoredGeminiApiKey } from '../lib/api';
import { useSettings, type ColorTheme, type DisplayMode, type FontScale, type Lang } from '../state/settings';

function Seg<T extends string | number>({
  label, value, options, onChange, icon,
}: {
  label: string;
  value: T;
  options: Array<{ v: T; label: string; icon?: React.ReactNode }>;
  onChange: (v: T) => void;
  icon: React.ReactNode;
}) {
  return (
    <fieldset className="mb-5">
      <legend className="mb-2 flex items-center gap-2 text-sm font-bold">{icon} {label}</legend>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
        {options.map((o) => (
          <button
            key={String(o.v)}
            type="button"
            aria-pressed={value === o.v}
            onClick={() => onChange(o.v)}
            className={`btn !px-2 !text-sm ${value === o.v ? 'btn-primary' : 'btn-ghost'}`}
          >
            {o.icon}
            <span className="min-w-0 break-words text-center leading-tight">{o.label}</span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function SettingsDrawer() {
  const { t } = useI18n();
  const { settings, set, toggleSenior, drawerOpen, setDrawerOpen } = useSettings();
  const ref = useRef<HTMLDivElement>(null);
  const [geminiKey, setGeminiKey] = useState(() => getStoredGeminiApiKey());
  const [showKey, setShowKey] = useState(false);
  const [keySaved, setKeySaved] = useState(false);

  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [drawerOpen, setDrawerOpen]);

  if (!drawerOpen) return null;
  return (
    <div className="fixed inset-0 z-[1600]" role="dialog" aria-modal="true" aria-label={t('settings.title')}>
      <button type="button" className="absolute inset-0 bg-slate-950/55" onClick={() => setDrawerOpen(false)} aria-label={t('common.close')} tabIndex={-1} />
      <aside ref={ref} tabIndex={-1} className="absolute inset-y-0 right-0 flex w-full max-w-sm animate-slideup flex-col bg-surface shadow-lift outline-none">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-lg font-bold">{t('settings.title')}</h2>
          <button type="button" className="btn btn-ghost !min-h-10 !min-w-10 !px-2" onClick={() => setDrawerOpen(false)} aria-label={t('common.close')}>
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <button type="button" aria-pressed={settings.senior} onClick={toggleSenior} className={`btn mb-5 w-full ${settings.senior ? 'btn-primary' : 'btn-soft'}`}>
            <span className="font-extrabold">Aa+</span> {t('senior.toggle')} {settings.senior ? `· ${t('common.on')}` : ''}
          </button>

          <Seg<DisplayMode>
            label={t('settings.mode')}
            icon={<Sun className="h-4 w-4" aria-hidden />}
            value={settings.mode}
            onChange={(mode) => set({ mode })}
            options={[
              { v: 'light', label: t('settings.mode.light'), icon: <Sun className="h-4 w-4" aria-hidden /> },
              { v: 'dark', label: t('settings.mode.dark'), icon: <Moon className="h-4 w-4" aria-hidden /> },
              { v: 'contrast', label: t('settings.mode.contrast'), icon: <SunMedium className="h-4 w-4" aria-hidden /> },
            ]}
          />
          <Seg<ColorTheme>
            label={t('settings.theme')}
            icon={<Palette className="h-4 w-4" aria-hidden />}
            value={settings.theme}
            onChange={(theme) => set({ theme })}
            options={[
              { v: 'gov', label: t('settings.theme.gov') },
              { v: 'youth', label: t('settings.theme.youth') },
            ]}
          />
          <Seg<FontScale>
            label={t('settings.font')}
            icon={<Type className="h-4 w-4" aria-hidden />}
            value={settings.senior ? 150 : settings.fontScale}
            onChange={(fontScale) => set({ fontScale })}
            options={[
              { v: 100, label: '100%' },
              { v: 125, label: '125%' },
              { v: 150, label: '150%' },
            ]}
          />
          <Seg<Lang>
            label={t('settings.lang')}
            icon={<Languages className="h-4 w-4" aria-hidden />}
            value={settings.lang}
            onChange={(lang) => set({ lang })}
            options={[
              { v: 'vi', label: 'Tiếng Việt (VI)' },
              { v: 'en', label: 'English (EN)' },
            ]}
          />
          <div className="mb-4 rounded-2xl border border-line bg-surface-2 p-3">
            <label htmlFor="gemini-api-key-input" className="mb-1.5 flex items-center gap-2 text-sm font-bold">
              <KeyRound className="h-4 w-4 text-brand" aria-hidden />
              <span>Gemini API Key (Trợ lý AI)</span>
            </label>
            <div className="flex items-center gap-1.5">
              <input
                id="gemini-api-key-input"
                type={showKey ? 'text' : 'password'}
                value={geminiKey}
                onChange={(e) => {
                  setGeminiKey(e.target.value);
                  setKeySaved(false);
                }}
                placeholder="AIza..."
                autoComplete="off"
                className="field min-w-0 flex-1 !py-2 text-xs"
              />
              <button
                type="button"
                className="btn btn-ghost !min-h-10 !min-w-10 !px-2"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? 'Ẩn API Key' : 'Hiện API Key'}
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                className="btn btn-primary !min-h-9 !px-3 !text-xs"
                onClick={() => {
                  saveStoredGeminiApiKey(geminiKey);
                  setKeySaved(true);
                }}
              >
                Lưu Key
              </button>
              {geminiKey.trim() && (
                <button
                  type="button"
                  className="btn btn-ghost !min-h-9 !px-3 !text-xs"
                  onClick={() => {
                    setGeminiKey('');
                    setKeySaved(false);
                    saveStoredGeminiApiKey('');
                  }}
                >
                  Xóa
                </button>
              )}
              {keySaved && <span className="text-xs font-semibold text-ok">Đã lưu trên trình duyệt</span>}
            </div>
            <p className="mt-1.5 text-[11px] leading-snug text-muted">
              Dùng khi máy chủ chưa cấu hình biến môi trường GEMINI_API_KEY. Chỉ lưu cục bộ trên thiết bị của bạn.
            </p>
          </div>
          <p className="text-xs text-muted">{t('settings.note')}</p>
        </div>
      </aside>
    </div>
  );
}
