import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeCoordinates } from '@shared/coordinates';
import type { GpsErrorKind, GpsFix } from '../lib/geoClient';

export type GpsStatus = 'idle' | 'locating' | 'ok' | 'denied' | 'error';

export interface PreciseLocationState {
  fix: GpsFix | null;
  status: GpsStatus;
  errorKind: GpsErrorKind | null;
  samples: number;
  /** Tầng GPS đã khóa thành công: 1 = Vệ tinh chính xác cao, 2 = Định vị mạng/Wi-Fi trong nhà */
  tier: 1 | 2 | null;
  /** True nếu độ chính xác > 50m (nhắc người dùng kéo ghim tinh chỉnh tay) */
  isLowAccuracy: boolean;
  locate: () => Promise<GpsFix | null>;
  stop: () => void;
}

const LOW_ACCURACY_THRESHOLD_M = 50;

/**
 * Chiến lược lấy GPS 2 tầng chuẩn thực địa (Không bao giờ treo hay timeout trong nhà):
 * - Tầng 1: `getCurrentPosition` với `enableHighAccuracy: true, timeout: 6000, maximumAge: 15000`.
 * - Tầng 2 (Fallback tự động khi trong nhà / yếu sóng vệ tinh): `enableHighAccuracy: false, timeout: 8000, maximumAge: 60000`.
 * - Kiểm tra chặt bằng `normalizeCoordinates`: loại bỏ `[0, 0]`, `NaN`, và tự sửa nếu tọa độ bị đảo ngược.
 */
export function usePreciseLocation(): PreciseLocationState {
  const [fix, setFix] = useState<GpsFix | null>(null);
  const [status, setStatus] = useState<GpsStatus>('idle');
  const [errorKind, setErrorKind] = useState<GpsErrorKind | null>(null);
  const [samples, setSamples] = useState(0);
  const [tier, setTier] = useState<1 | 2 | null>(null);

  const mountedRef = useRef(true);
  const activeReqIdRef = useRef(0);

  const stop = useCallback(() => {
    activeReqIdRef.current += 1;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeReqIdRef.current += 1;
    };
  }, []);

  const locate = useCallback(async (): Promise<GpsFix | null> => {
    const reqId = ++activeReqIdRef.current;

    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      if (mountedRef.current) {
        setStatus('error');
        setErrorKind('unsupported');
      }
      return null;
    }

    if (mountedRef.current) {
      setStatus('locating');
      setErrorKind(null);
      setSamples(0);
    }

    const runAttempt = (
      opts: PositionOptions,
      tierNum: 1 | 2,
    ): Promise<{ fix: GpsFix | null; errKind: GpsErrorKind | null }> =>
      new Promise((resolve) => {
        let settled = false;
        const guardTimer = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve({ fix: null, errKind: 'timeout' });
        }, (opts.timeout ?? 7000) + 500);

        navigator.geolocation.getCurrentPosition(
          (pos) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(guardTimer);
            const norm = normalizeCoordinates(
              { lat: pos.coords.latitude, lng: pos.coords.longitude },
              { requireVietnam: false },
            );
            if (!norm.ok) {
              resolve({ fix: null, errKind: 'unavailable' });
              return;
            }
            resolve({
              fix: {
                lat: norm.lat,
                lng: norm.lng,
                accuracy: Math.max(1, Math.round(pos.coords.accuracy || (tierNum === 1 ? 15 : 85))),
                tier: tierNum,
              },
              errKind: null,
            });
          },
          (err) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(guardTimer);
            const kind: GpsErrorKind =
              err.code === err.PERMISSION_DENIED
                ? 'denied'
                : err.code === err.TIMEOUT
                  ? 'timeout'
                  : 'unavailable';
            resolve({ fix: null, errKind: kind });
          },
          opts,
        );
      });

    const watchRefine = (initialFix: GpsFix): Promise<GpsFix> =>
      new Promise((resolve) => {
        if (
          typeof navigator === 'undefined' ||
          !('watchPosition' in navigator.geolocation) ||
          initialFix.accuracy <= 20
        ) {
          resolve(initialFix);
          return;
        }
        let best = initialFix;
        let finished = false;
        let watchId: number | null = null;
        const finish = () => {
          if (finished) return;
          finished = true;
          if (watchId !== null) {
            navigator.geolocation.clearWatch(watchId);
            watchId = null;
          }
          resolve(best);
        };
        const timer = window.setTimeout(finish, 2200);
        try {
          watchId = navigator.geolocation.watchPosition(
            (pos) => {
              if (reqId !== activeReqIdRef.current) {
                window.clearTimeout(timer);
                finish();
                return;
              }
              const norm = normalizeCoordinates(
                { lat: pos.coords.latitude, lng: pos.coords.longitude },
                { requireVietnam: false },
              );
              if (!norm.ok) return;
              const acc = Math.max(1, Math.round(pos.coords.accuracy || 20));
              if (acc < best.accuracy) {
                best = { lat: norm.lat, lng: norm.lng, accuracy: acc, tier: 1 };
              }
              if (best.accuracy <= 15) {
                window.clearTimeout(timer);
                finish();
              }
            },
            () => {
              /* Giữ mẫu tốt nhất đã thu được */
            },
            { enableHighAccuracy: true, maximumAge: 0, timeout: 2200 },
          );
        } catch {
          window.clearTimeout(timer);
          finish();
        }
      });

    // Tầng 1: GPS vệ tinh độ chính xác cao (không dùng cache cũ, tinh chỉnh nhanh 2.2s nếu sai số > 20m)
    const tier1 = await runAttempt(
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 0 },
      1,
    );
    if (reqId !== activeReqIdRef.current) return null;

    if (tier1.fix) {
      const refined = await watchRefine(tier1.fix);
      if (reqId !== activeReqIdRef.current) return null;
      if (mountedRef.current) {
        setFix(refined);
        setTier(1);
        setSamples(refined.accuracy < tier1.fix.accuracy ? 2 : 1);
        setStatus('ok');
        setErrorKind(null);
      }
      return refined;
    }

    // Nếu người dùng từ chối thẳng quyền vị trí -> dừng ngay không hỏi lại tầng 2
    if (tier1.errKind === 'denied') {
      if (mountedRef.current) {
        setStatus('denied');
        setErrorKind('denied');
      }
      return null;
    }

    // Tầng 2: Fallback tự động sang định vị Wi-Fi / Trạm phát sóng trong nhà (timeout 8s)
    const tier2 = await runAttempt(
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 },
      2,
    );
    if (reqId !== activeReqIdRef.current) return null;

    if (tier2.fix) {
      if (mountedRef.current) {
        setFix(tier2.fix);
        setTier(2);
        setSamples(2);
        setStatus('ok');
        setErrorKind(null);
      }
      return tier2.fix;
    }

    const finalErr = tier2.errKind ?? tier1.errKind ?? 'unavailable';
    if (mountedRef.current) {
      setStatus(finalErr === 'denied' ? 'denied' : 'error');
      setErrorKind(finalErr);
    }
    return null;
  }, []);

  return {
    fix,
    status,
    errorKind,
    samples,
    tier,
    isLowAccuracy: fix !== null && fix.accuracy > LOW_ACCURACY_THRESHOLD_M,
    locate,
    stop,
  };
}
