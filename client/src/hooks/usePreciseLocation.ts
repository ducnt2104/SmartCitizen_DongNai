import { useCallback, useEffect, useRef, useState } from 'react';
import type { GpsErrorKind, GpsFix } from '../lib/geoClient';

export type GpsStatus = 'idle' | 'locating' | 'ok' | 'denied' | 'error';

export interface PreciseLocationState {
  fix: GpsFix | null;
  status: GpsStatus;
  errorKind: GpsErrorKind | null;
  samples: number;
  /** True nếu độ chính xác > 50m (nhắc người dùng kéo ghim tinh chỉnh tay) */
  isLowAccuracy: boolean;
  locate: () => Promise<GpsFix | null>;
  stop: () => void;
}

const TARGET_ACCURACY_M = 20;
const LOW_ACCURACY_THRESHOLD_M = 50;
const SAMPLE_WINDOW_MS = 4500;
const HARD_TIMEOUT_MS = 12000;

/**
 * Định vị GPS độ chính xác cao (`watchPosition`):
 * - Thu mẫu liên tục tối đa 4.5 giây, dừng ngay lập tức khi đạt `accuracy <= 20m`.
 * - Luôn chọn tọa độ có sai số (`accuracy`) nhỏ nhất thay vì lấy mẫu đầu tiên bị lệch cell-tower.
 * - Giải phóng watcher khi hoàn tất hoặc component unmount.
 */
export function usePreciseLocation(): PreciseLocationState {
  const [fix, setFix] = useState<GpsFix | null>(null);
  const [status, setStatus] = useState<GpsStatus>('idle');
  const [errorKind, setErrorKind] = useState<GpsErrorKind | null>(null);
  const [samples, setSamples] = useState(0);

  const watchIdRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (watchIdRef.current !== null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => () => stop(), [stop]);

  const locate = useCallback((): Promise<GpsFix | null> => {
    stop();
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setStatus('error');
      setErrorKind('unsupported');
      return Promise.resolve(null);
    }

    setStatus('locating');
    setErrorKind(null);
    setSamples(0);

    return new Promise((resolve) => {
      let best: GpsFix | null = null;
      let count = 0;
      let settled = false;

      const finish = (result: GpsFix | null, err: GpsErrorKind | null): void => {
        if (settled) return;
        settled = true;
        stop();
        if (result) {
          setFix(result);
          setStatus('ok');
          setErrorKind(null);
        } else {
          setStatus(err === 'denied' ? 'denied' : 'error');
          setErrorKind(err ?? 'unavailable');
        }
        resolve(result);
      };

      const startSampleWindow = (): void => {
        if (timerRef.current !== null) return;
        timerRef.current = window.setTimeout(() => finish(best, best ? null : 'timeout'), SAMPLE_WINDOW_MS);
      };

      // Hard timeout nếu thiết bị không trả về bất kỳ mẫu nào trong 12 giây
      const hardTimer = window.setTimeout(() => finish(best, best ? null : 'timeout'), HARD_TIMEOUT_MS);

      watchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          window.clearTimeout(hardTimer);
          const candidate: GpsFix = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: Math.round(pos.coords.accuracy),
          };
          count += 1;
          setSamples(count);
          if (!best || candidate.accuracy < best.accuracy) {
            best = candidate;
            setFix(candidate);
          }
          if (candidate.accuracy <= TARGET_ACCURACY_M) {
            finish(best, null);
          } else {
            startSampleWindow();
          }
        },
        (err) => {
          window.clearTimeout(hardTimer);
          const kind: GpsErrorKind =
            err.code === err.PERMISSION_DENIED ? 'denied' : err.code === err.TIMEOUT ? 'timeout' : 'unavailable';
          finish(best, kind);
        },
        { enableHighAccuracy: true, timeout: HARD_TIMEOUT_MS, maximumAge: 0 },
      );
    });
  }, [stop]);

  return {
    fix,
    status,
    errorKind,
    samples,
    isLowAccuracy: fix !== null && fix.accuracy > LOW_ACCURACY_THRESHOLD_M,
    locate,
    stop,
  };
}
