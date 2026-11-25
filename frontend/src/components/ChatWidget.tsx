import { Bot, KeyRound, Mic, MicOff, RotateCcw, Send, Square, Volume2, VolumeX, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { ApiError, getStoredGeminiApiKey, NetworkError, saveStoredGeminiApiKey, streamChat } from '../lib/api';
import { speak, speechRecognitionSupported, startListening, stopSpeaking } from '../lib/speech';
import { useSettings } from '../state/settings';

interface Msg {
  role: 'user' | 'model';
  text: string;
  mode?: 'gemini' | 'ollama' | 'fallback';
  error?: boolean;
  retryPrompt?: string;
}

export { openAssistant } from '../state/settings';

/** Chatbot AI Cộng đồng: SSE streaming, micro vi-VN, đọc to câu trả lời (TTS). */
export function ChatWidget() {
  const { t, lang } = useI18n();
  const { settings, assistantOpen: open, setAssistantOpen: setOpen } = useSettings();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [tts, setTts] = useState(settings.senior);
  const [showKeyBox, setShowKeyBox] = useState(false);
  const [inlineKey, setInlineKey] = useState(() => getStoredGeminiApiKey());
  const [inlineKeySaved, setInlineKeySaved] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const stopListenRef = useRef<(() => void) | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const ttsRef = useRef(tts);
  ttsRef.current = tts;

  useEffect(() => {
    setTts(settings.senior);
  }, [settings.senior]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [msgs, open]);

  const stopAll = useCallback(() => {
    abortRef.current?.abort();
    stopListenRef.current?.();
    stopSpeaking();
  }, []);

  useEffect(() => () => stopAll(), [stopAll]);

  const close = useCallback(() => {
    stopAll();
    setOpen(false);
  }, [stopAll, setOpen]);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, close]);

  const toggleListen = useCallback(() => {
    if (listening) {
      stopListenRef.current?.();
      return;
    }
    setListening(true);
    stopListenRef.current = startListening(lang, {
      onText: (text) => setInput(text),
      onEnd: () => setListening(false),
      onError: (code) => {
        setMsgs((m) => [...m, { role: 'model', text: code === 'not-allowed' ? t('chat.micDenied') : t('chat.micError'), error: true }]);
      },
    });
  }, [lang, listening, t]);

  useEffect(() => {
    const onOpen = (e: Event): void => {
      setOpen(true);
      const voice = (e as CustomEvent<{ voice: boolean }>).detail?.voice;
      if (voice && speechRecognitionSupported()) window.setTimeout(() => toggleListen(), 350);
    };
    window.addEventListener('sc:open-chat', onOpen);
    return () => window.removeEventListener('sc:open-chat', onOpen);
  }, [setOpen, toggleListen]);

  const send = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    stopSpeaking();
    const history: Msg[] = [...msgs.filter((m) => !m.error), { role: 'user', text }];
    setMsgs([...msgs, { role: 'user', text }, { role: 'model', text: '' }]);
    setInput('');
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let acc = '';
    let errText = '';
    let mode: 'gemini' | 'ollama' | 'fallback' = 'gemini';
    const wardCode = settings.scope.startsWith('ward:') ? settings.scope.slice(5) : undefined;
    try {
      await streamChat(
        { messages: history.slice(-20).map((m) => ({ role: m.role, text: m.text })), wardCode, locale: lang },
        (c) => {
          if (c.delta) {
            acc += c.delta;
            if (c.mode) mode = c.mode;
            setMsgs((m) => [...m.slice(0, -1), { role: 'model', text: acc, mode }]);
          }
          if (c.error) {
            errText = c.error;
            if (/API Key|GEMINI_API_KEY|401|403/i.test(c.error)) {
              setShowKeyBox(true);
            }
            setMsgs((m) => [
              ...m.slice(0, -1),
              { role: 'model', text: acc || errText, error: !acc, mode: c.mode ?? 'fallback', retryPrompt: !acc ? text : undefined },
            ]);
          }
        },
        ctrl.signal,
      );
      if (!acc && !errText) {
        if (ctrl.signal.aborted) {
          setMsgs((m) => [...m.slice(0, -1), { role: 'model', text: 'Đã dừng trả lời.', error: true, retryPrompt: text }]);
        } else {
          throw new Error('empty');
        }
      }
      if (ttsRef.current && acc) speak(acc, lang);
    } catch (err) {
      const offline = err instanceof NetworkError;
      const msg = offline ? t('chat.offline') : err instanceof ApiError ? err.message : t('chat.error');
      if (/API Key|GEMINI_API_KEY|401|403|missing_gemini_key/i.test(msg)) {
        setShowKeyBox(true);
      }
      setMsgs((m) => [
        ...m.slice(0, -1),
        { role: 'model', text: acc || msg, error: !acc, mode: acc ? mode : undefined, retryPrompt: !acc ? text : undefined },
      ]);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [busy, msgs, settings.scope, lang, t]);

  const chips: Array<Parameters<typeof t>[0]> = ['chat.q1', 'chat.q2', 'chat.q3', 'chat.q4'];

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[1700] flex items-end justify-center sm:items-end sm:justify-end sm:p-4">
      <button
        type="button"
        className="absolute inset-0 bg-slate-950/45 backdrop-blur-[1px]"
        onClick={close}
        aria-label={t('common.close')}
        tabIndex={-1}
      />
      <section
        className="relative flex max-h-[85dvh] w-full animate-slideup flex-col rounded-t-3xl border border-line bg-surface shadow-lift sm:max-h-[min(80dvh,38rem)] sm:w-[26rem] sm:rounded-3xl"
        role="dialog"
        aria-modal="true"
        aria-label={t('chat.title')}
      >
        <div className="mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full bg-line sm:hidden" aria-hidden />
        <div className="flex items-center gap-2.5 border-b border-line/80 px-4 py-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand">
            <Bot className="h-5 w-5" aria-hidden />
          </span>
          <h2 className="min-w-0 flex-1 truncate font-bold text-ink">{t('chat.title')}</h2>
          <button type="button" className="btn btn-ghost !min-h-10 !min-w-10 !px-2" aria-pressed={tts} onClick={() => { setTts((v) => !v); stopSpeaking(); }} aria-label={t('chat.tts')} title={t('chat.tts')}>
            {tts ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
          </button>
          <button type="button" className="btn btn-ghost !min-h-10 !min-w-10 !px-2" onClick={close} aria-label={t('common.close')}>
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3.5" aria-live="polite">
          {msgs.length === 0 && (
            <div className="rounded-2xl border border-brand/15 bg-brand-soft/80 p-3.5 text-sm">
              <p className="font-bold text-brand">{t('chat.welcome')}</p>
              <p className="mt-1 text-ink">{t('chat.welcomeText')}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {chips.map((k) => (
                  <button key={k} type="button" className="chip" onClick={() => void send(t(k))}>{t(k)}</button>
                ))}
              </div>
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[88%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-[15px] shadow-sm ${
                  m.role === 'user'
                    ? 'rounded-br-md btn-primary'
                    : m.error
                      ? 'rounded-bl-md border border-danger/40 bg-danger-soft text-danger'
                      : 'rounded-bl-md border border-line/70 bg-surface-2 text-ink'
                }`}
              >
                {m.text ? (
                  <>
                    <span>{m.text}</span>
                    {m.error && m.retryPrompt && !busy && (
                      <div className="mt-2">
                        <button
                          type="button"
                          onClick={() => void send(m.retryPrompt!)}
                          className="btn btn-primary !min-h-9 !rounded-xl !px-3 !text-xs font-bold"
                        >
                          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                          <span>Thử lại</span>
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <span className="inline-flex items-center gap-2 text-sm text-muted" aria-label={t('chat.thinking')}>
                    <span className="inline-flex gap-1">
                      <i className="h-2 w-2 animate-pulse rounded-full bg-brand/70" />
                      <i className="h-2 w-2 animate-pulse rounded-full bg-brand/70 [animation-delay:150ms]" />
                      <i className="h-2 w-2 animate-pulse rounded-full bg-brand/70 [animation-delay:300ms]" />
                    </span>
                    <span>{t('chat.thinking')}</span>
                  </span>
                )}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>

        {showKeyBox && (
          <div className="border-t border-line/70 bg-surface-2 px-3 py-2.5">
            <div className="mb-1.5 flex items-center justify-between gap-2 text-xs font-bold text-ink">
              <span className="inline-flex items-center gap-1.5">
                <KeyRound className="h-3.5 w-3.5 text-brand" aria-hidden />
                Nhập Gemini API Key (AIzaSy...)
              </span>
              <button
                type="button"
                className="text-muted hover:text-ink"
                onClick={() => setShowKeyBox(false)}
                aria-label={t('common.close')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="password"
                value={inlineKey}
                onChange={(e) => {
                  setInlineKey(e.target.value);
                  setInlineKeySaved(false);
                }}
                placeholder="AIzaSy..."
                autoComplete="off"
                className="field min-w-0 flex-1 !py-1.5 text-xs"
              />
              <button
                type="button"
                className="btn btn-primary !min-h-9 !px-3 !text-xs"
                onClick={() => {
                  saveStoredGeminiApiKey(inlineKey);
                  setInlineKeySaved(true);
                  if (inlineKey.trim()) setShowKeyBox(false);
                }}
              >
                Lưu
              </button>
            </div>
            {inlineKeySaved && <p className="mt-1 text-[11px] font-semibold text-ok">Đã lưu API Key!</p>}
          </div>
        )}

        {msgs.length > 0 && !busy && (
          <div className="no-scrollbar flex gap-1.5 overflow-x-auto border-t border-line/60 px-3 py-2">
            {chips.map((k) => (
              <button key={k} type="button" className="chip shrink-0 text-xs" onClick={() => void send(t(k))}>
                {t(k)}
              </button>
            ))}
          </div>
        )}

        <form
          className="flex items-center gap-2 border-t border-line p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          {speechRecognitionSupported() && (
            <button type="button" onClick={toggleListen} aria-pressed={listening} className={`btn !min-h-11 !min-w-11 !px-0 ${listening ? 'btn-danger animate-ring' : 'btn-ghost'}`} aria-label={listening ? t('chat.micStop') : t('chat.micStart')}>
              {listening ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
            </button>
          )}
          <input
            className="field min-w-0 flex-1"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={listening ? t('chat.listening') : t('chat.placeholder')}
            maxLength={800}
            aria-label={t('chat.placeholder')}
          />
          {busy ? (
            <button type="button" className="btn btn-ghost !min-h-11 !min-w-11 !px-0" onClick={() => abortRef.current?.abort()} aria-label={t('chat.stop')}>
              <Square className="h-5 w-5" />
            </button>
          ) : (
            <button type="submit" className="btn btn-primary !min-h-11 !min-w-11 !px-0" disabled={!input.trim()} aria-label={t('chat.send')}>
              <Send className="h-5 w-5" />
            </button>
          )}
        </form>
      </section>
    </div>
  );
}
