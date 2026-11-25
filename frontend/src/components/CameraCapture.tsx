import { Camera, CameraOff, FlipHorizontal2, ImagePlus, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';

interface Props {
  onFile: (file: File) => void;
  disabled?: boolean;
  /** Mở camera ngay khi hiển thị (dùng cho nút "Chụp ảnh báo cáo ngay" của chế độ Senior) */
  autoStart?: boolean;
}

type CamState = 'idle' | 'starting' | 'live' | 'denied' | 'unsupported' | 'error';

/**
 * Chụp ảnh bằng getUserMedia. MediaStream được dừng hoàn toàn khi: chụp xong, đóng camera,
 * đổi tab ẩn, hoặc component unmount (chống rò rỉ camera/bộ nhớ). Luôn có đường lui: tải ảnh từ thư viện.
 */
export function CameraCapture({ onFile, disabled, autoStart }: Props) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<CamState>('idle');
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setState((s) => (s === 'live' || s === 'starting' ? 'idle' : s));
  }, []);

  const start = useCallback(async (face: 'environment' | 'user') => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setState('unsupported');
      return;
    }
    stop();
    setState('starting');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: face }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      streamRef.current = s;
      const v = videoRef.current;
      if (!v) {
        s.getTracks().forEach((tr) => tr.stop());
        return;
      }
      v.srcObject = s;
      await v.play();
      setState('live');
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      setState(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' ? 'unsupported' : 'error');
    }
  }, [stop]);

  useEffect(() => {
    const onHide = (): void => {
      if (document.hidden) stop();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      stop(); // unmount → giải phóng camera
    };
  }, [stop]);

  useEffect(() => {
    if (autoStart) void start('environment');
  }, [autoStart, start]);

  const snap = (): void => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')?.drawImage(v, 0, 0);
    c.toBlob(
      (blob) => {
        if (!blob) return;
        stop();
        onFile(new File([blob], `capture-${Date.now()}.jpg`, { type: 'image/jpeg' }));
      },
      'image/jpeg',
      0.92,
    );
  };

  return (
    <div className="space-y-3">
      <div className={`relative overflow-hidden rounded-2xl bg-slate-900 ${state === 'live' || state === 'starting' ? 'aspect-[4/3]' : 'hidden'}`}>
        <video ref={videoRef} playsInline muted className="h-full w-full object-cover" aria-label={t('cam.preview')} />
        {state === 'starting' && (
          <div className="absolute inset-0 grid place-items-center text-white"><Loader2 className="h-8 w-8 animate-spin" /></div>
        )}
        {state === 'live' && (
          <div className="absolute inset-x-0 bottom-3 flex items-center justify-center gap-4">
            <button type="button" className="btn !bg-white/90 !text-slate-900" onClick={() => { const f = facing === 'environment' ? 'user' : 'environment'; setFacing(f); void start(f); }} aria-label={t('cam.flip')}>
              <FlipHorizontal2 className="h-5 w-5" />
            </button>
            <button type="button" onClick={snap} className="grid h-16 w-16 place-items-center rounded-full border-4 border-white bg-danger shadow-lift" aria-label={t('cam.shutter')} />
            <button type="button" className="btn !bg-white/90 !text-slate-900" onClick={stop} aria-label={t('cam.close')}>
              <CameraOff className="h-5 w-5" />
            </button>
          </div>
        )}
      </div>

      {state !== 'live' && state !== 'starting' && (
        <div className="grid gap-2.5 rounded-2xl border border-dashed border-brand/30 bg-brand-soft/30 p-3 sm:grid-cols-2">
          <button type="button" className="btn btn-primary !min-h-14" disabled={disabled} onClick={() => void start(facing)}>
            <Camera className="h-6 w-6" aria-hidden /> {t('cam.open')}
          </button>
          <button type="button" className="btn btn-ghost !min-h-14" disabled={disabled} onClick={() => fileRef.current?.click()}>
            <ImagePlus className="h-6 w-6 text-brand" aria-hidden /> {t('cam.upload')}
          </button>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
      {(state === 'denied' || state === 'unsupported' || state === 'error') && (
        <p role="alert" className="rounded-xl bg-warn-soft p-3 text-sm font-semibold text-warn">
          {state === 'denied' ? t('cam.denied') : state === 'unsupported' ? t('cam.unsupported') : t('cam.error')}
        </p>
      )}
    </div>
  );
}
