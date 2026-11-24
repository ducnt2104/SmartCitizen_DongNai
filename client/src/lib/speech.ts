interface RecognitionEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function ctor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function speechRecognitionSupported(): boolean {
  return ctor() !== null;
}

export function speechSynthesisSupported(): boolean {
  return 'speechSynthesis' in window;
}

export interface ListenHandlers {
  onText: (text: string, final: boolean) => void;
  onEnd: () => void;
  onError: (code: string) => void;
}

/** Web Speech API (vi-VN / en-US). Trả về hàm dừng. */
export function startListening(lang: 'vi' | 'en', h: ListenHandlers): () => void {
  const C = ctor();
  if (!C) {
    h.onError('unsupported');
    h.onEnd();
    return () => undefined;
  }
  const rec = new C();
  rec.lang = lang === 'vi' ? 'vi-VN' : 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  rec.onresult = (e) => {
    const last = e.results[e.results.length - 1];
    h.onText(last[0].transcript, last.isFinal);
  };
  rec.onerror = (e) => h.onError(e.error);
  rec.onend = h.onEnd;
  try {
    rec.start();
  } catch (err) {
    h.onError(err instanceof Error ? err.message : 'start-failed');
    h.onEnd();
  }
  return () => {
    try {
      rec.stop();
    } catch (err) {
      console.warn('Không dừng được nhận dạng giọng nói:', err);
    }
  };
}

export function speak(text: string, lang: 'vi' | 'en'): void {
  if (!speechSynthesisSupported()) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang === 'vi' ? 'vi-VN' : 'en-US';
  u.rate = 0.95;
  const voices = window.speechSynthesis.getVoices();
  const v = voices.find((x) => x.lang.toLowerCase().startsWith(lang === 'vi' ? 'vi' : 'en'));
  if (v) u.voice = v;
  window.speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if (speechSynthesisSupported()) window.speechSynthesis.cancel();
}
