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

const TARGET_ACCURACY_M = 18;
const LOW_ACCURACY_THRESHOLD_M = 50;
const SAMPLE_WINDOW_MS = 4000;
const HARD_TIMEOUT_MS = 12000;

/**
 * Định vị GPS độ chính xác cao (`watchPosition` với `enableHighAccuracy: true`):
 * - Thu mẫu liên tục trong cửa sổ 4 giây, dừng ngay khi đạt `accuracy <= 18m`.
 * - Luôn giữ mẫu có sai số (`accuracy`) tốt nhất thay vì lấy mẫu đầu tiên bị lệch trạm phát sóng.
 * - Giải phóng triệt để `clearWatch` và mọi timer khi hoàn tất hoặc khi component unmount.
 */
export function usePreciseLocation(): PreciseLocationState {
  const [fix, setFix] = useState<GpsFix | null>(null);
  const [status, setStatus] = useState<GpsStatus>('idle');
  const [errorKind, setErrorKind] = useState<GpsErrorKind | null>(null);
  const [samples, setSamples] = useState(0);

  const watchIdRef = useRef<number | null>(null);
  const sampleTimerRef = useRef<number | null>(null);
  const hardTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const stop = useCallback(() => {
    if (watchIdRef.current !== null && typeof navigator !== 'undefined' && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (sampleTimerRef.current !== null) {
      window.clearTimeout(sampleTimerRef.current);
      sampleTimerRef.current = null;
    }
    if (hardTimerRef.current !== null) {
      window.clearTimeout(hardTimerRef.current);
      hardTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stop();
    };
  }, [stop]);

  const locate = useCallback((): Promise<GpsFix | null> => {
    stop();
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      if (mountedRef.current) {
        setStatus('error');
        setErrorKind('unsupported');
      }
      return Promise.resolve(null);
    }

    if (mountedRef.current) {
      setStatus('locating');
      setErrorKind(null);
      setSamples(0);
    }

    return new Promise((resolve) => {
      let best: GpsFix | null = null;
      let count = 0;
      let settled = false;

      const finish = (result: GpsFix | null, err: GpsErrorKind | null): void => {
        if (settled) return;
        settled = true;
        stop();
        if (mountedRef.current) {
          if (result) {
            setFix(result);
            setStatus('ok');
            setErrorKind(null);
          } else {
            setStatus(err === 'denied' ? 'denied' : 'error');
            setErrorKind(err ?? 'unavailable');
          }
        }
        resolve(result);
      };

      const startSampleWindow = (): void => {
        if (sampleTimerRef.current !== null) return;
        sampleTimerRef.current = window.setTimeout(
          () => finish(best, best ? null : 'timeout'),
          SAMPLE_WINDOW_MS,
        );
      };

      hardTimerRef.current = window.setTimeout(
        () => finish(best, best ? null : 'timeout'),
        HARD_TIMEOUT_MS,
      );

      watchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          if (hardTimerRef.current !== null) {
            window.clearTimeout(hardTimerRef.current);
            hardTimerRef.current = null;
          }
          const candidate: GpsFix = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: Math.max(1, Math.round(pos.coords.accuracy)),
          };
          count += 1;
          if (mountedRef.current) setSamples(count);
          if (!best || candidate.accuracy < best.accuracy) {
            best = candidate;
            if (mountedRef.current) setFix(candidate);
          }
          if (candidate.accuracy <= TARGET_ACCURACY_M) {
            finish(best, null);
          } else {
            startSampleWindow();
          }
        },
        (err) => {
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
