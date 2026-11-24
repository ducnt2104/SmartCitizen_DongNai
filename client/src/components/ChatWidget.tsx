import { Bot, Mic, MicOff, Send, Square, Volume2, VolumeX, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { ApiError, NetworkError, streamChat } from '../lib/api';
import { speak, speechRecognitionSupported, startListening, stopSpeaking } from '../lib/speech';
import { useSettings } from '../state/settings';

interface Msg {
  role: 'user' | 'model';
  text: string;
  mode?: 'gemini' | 'fallback';
  error?: boolean;
}

export function openAssistant(voice = false): void {
  window.dispatchEvent(new CustomEvent('sc:open-chat', { detail: { voice } }));
}

/** Chatbot AI Cộng đồng: SSE streaming, micro vi-VN, đọc to câu trả lời (TTS). */
export function ChatWidget() {
  const { t, lang } = useI18n();
  const { settings } = useSettings();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [tts, setTts] = useState(settings.senior);
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
  }, [toggleListen]);

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
    let mode: 'gemini' | 'fallback' = 'fallback';
    const wardCode = settings.scope.startsWith('ward:') ? settings.scope.slice(5) : undefined;
    try {
      await streamChat(
        { messages: history.map((m) => ({ role: m.role, text: m.text })), wardCode, locale: lang },
        (c) => {
          if (c.delta) {
            acc += c.delta;
            if (c.mode) mode = c.mode;
            setMsgs((m) => [...m.slice(0, -1), { role: 'model', text: acc, mode }]);
          }
          if (c.error) acc = acc || c.error;
        },
        ctrl.signal,
      );
      if (!acc && !ctrl.signal.aborted) throw new Error('empty');
      if (ttsRef.current && acc) speak(acc, lang);
    } catch (err) {
      const offline = err instanceof NetworkError;
      const msg = offline ? t('chat.offline') : err instanceof ApiError ? err.message : t('chat.error');
      setMsgs((m) => [...m.slice(0, -1), { role: 'model', text: acc || msg, error: !acc, mode: acc ? mode : undefined }]);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [busy, msgs, settings.scope, lang, t]);

  const chips: Array<Parameters<typeof t>[0]> = ['chat.q1', 'chat.q2', 'chat.q3'];

  return (
    <>
      {!open && (
        <button
          type="button"
          data-tour="assistant"
          onClick={() => setOpen(true)}
          className="fixed bottom-20 right-3 z-40 inline-flex min-h-14 items-center gap-2 rounded-full bg-brand px-4 text-brand-ink shadow-lift md:bottom-6"
          aria-label={t('chat.open')}
        >
          <Bot className="h-6 w-6" aria-hidden />
          <span className="font-semibold">{t('chat.fab')}</span>
        </button>
      )}
      {open && (
        <section
          className="fixed inset-x-0 bottom-0 z-[1700] flex max-h-[88dvh] min-h-[60dvh] animate-slideup flex-col rounded-t-3xl border border-line bg-surface shadow-lift sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-[26rem] sm:rounded-3xl"
          role="dialog"
          aria-label={t('chat.title')}
        >
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <Bot className="h-5 w-5 text-brand" aria-hidden />
            <h2 className="min-w-0 flex-1 truncate font-bold">{t('chat.title')}</h2>
            <button type="button" className="btn btn-ghost !min-h-10 !min-w-10 !px-2" aria-pressed={tts} onClick={() => { setTts((v) => !v); stopSpeaking(); }} aria-label={t('chat.tts')} title={t('chat.tts')}>
              {tts ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
            </button>
            <button type="button" className="btn btn-ghost !min-h-10 !min-w-10 !px-2" onClick={() => { stopAll(); setOpen(false); }} aria-label={t('common.close')}>
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3" aria-live="polite">
            {msgs.length === 0 && (
              <div className="rounded-2xl bg-brand-soft p-3 text-sm">
                <p className="font-semibold text-brand">{t('chat.welcome')}</p>
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
                  className={`max-w-[88%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-[15px] ${
                    m.role === 'user' ? 'bg-brand text-brand-ink' : m.error ? 'border border-danger/40 bg-danger-soft text-danger' : 'bg-surface-2 text-ink'
                  }`}
                >
                  {m.text || <span className="inline-flex gap-1" aria-label={t('chat.thinking')}><i className="h-2 w-2 animate-pulse rounded-full bg-muted" /><i className="h-2 w-2 animate-pulse rounded-full bg-muted" /><i className="h-2 w-2 animate-pulse rounded-full bg-muted" /></span>}
                  {m.mode === 'fallback' && m.text && !m.error && (
                    <span className="mt-1 block text-[11px] font-semibold text-warn">{t('ai.fallbackLabel')}</span>
                  )}
                </div>
              </div>
            ))}
            <div ref={endRef} />
          </div>

          <form
            className="flex items-center gap-2 border-t border-line p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            {speechRecognitionSupported() && (
              <button type="button" onClick={toggleListen} aria-pressed={listening} className={`btn !min-w-12 !px-0 ${listening ? 'btn-danger animate-ring' : 'btn-ghost'}`} aria-label={listening ? t('chat.micStop') : t('chat.micStart')}>
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
              <button type="button" className="btn btn-ghost !min-w-12 !px-0" onClick={() => abortRef.current?.abort()} aria-label={t('chat.stop')}>
                <Square className="h-5 w-5" />
              </button>
            ) : (
              <button type="submit" className="btn btn-primary !min-w-12 !px-0" disabled={!input.trim()} aria-label={t('chat.send')}>
                <Send className="h-5 w-5" />
              </button>
            )}
          </form>
        </section>
      )}
    </>
  );
}
