import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeCoordinates, TRAN_BIEN_FALLBACK_COORDS } from '@shared/coordinates';
import { haversineMeters } from '@shared/geo';
import { WARD_BY_CODE } from '../data/dongNaiWards';
import { getGps } from '../lib/geoClient';
import { computeBearingDeg } from '../lib/navigationEngine';

export interface LiveNavPosition {
  lat: number;
  lng: number;
  accuracy: number;
  heading: number | null;
  speedKmh: number | null;
  isFallback: boolean;
  updatedAt: number;
}

export interface LiveNavigationGpsState {
  pos: LiveNavPosition;
  watching: boolean;
  permissionDenied: boolean;
  refreshNow: () => Promise<void>;
}

function buildDefaultBasePos(wardCode?: string | null): LiveNavPosition {
  if (wardCode && WARD_BY_CODE[wardCode]) {
    const w = WARD_BY_CODE[wardCode];
    return {
      lat: w.centerLat,
      lng: w.centerLng,
      accuracy: 30,
      heading: null,
      speedKmh: null,
      isFallback: true,
      updatedAt: Date.now(),
    };
  }
  return {
    lat: TRAN_BIEN_FALLBACK_COORDS.lat,
    lng: TRAN_BIEN_FALLBACK_COORDS.lng,
    accuracy: 30,
    heading: null,
    speedKmh: null,
    isFallback: true,
    updatedAt: Date.now(),
  };
}

/**
 * Live GPS Tracking ổn định & lọc nhiễu chuẩn ứng dụng điều hướng tài xế:
 * - Sử dụng `navigator.geolocation.watchPosition({ enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 })`
 *   và dọn dẹp `clearWatch` triệt để khi unmount.
 * - Loại bỏ các điểm GPS nhiễu (`[0, 0]`, `NaN`, sai số vọt bất thường hoặc nhảy cóc phi vật lý).
 * - Tự động suy luận góc hướng di chuyển (`bearing` 0–360°) từ 2 tọa độ hợp lệ liên tiếp khi thiết bị không trả về `coords.heading`.
 */
export function useLiveNavigationGps(wardCode?: string | null): LiveNavigationGpsState {
  const [pos, setPos] = useState<LiveNavPosition>(() => buildDefaultBasePos(wardCode));
  const [watching, setWatching] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const lastAcceptedRef = useRef<{
    lat: number;
    lng: number;
    accuracy: number;
    heading: number | null;
    isFallback: boolean;
    at: number;
  } | null>(null);
  const outlierCandidateRef = useRef<{ lat: number; lng: number; count: number } | null>(null);

  const applyHardwareCoords = useCallback(
    (
      latRaw: number,
      lngRaw: number,
      accuracyRaw: number,
      headingRaw: number | null,
      speedMs: number | null,
    ) => {
      if (!Number.isFinite(latRaw) || !Number.isFinite(lngRaw)) return;
      if (Math.abs(latRaw) < 0.0001 && Math.abs(lngRaw) < 0.0001) return;

      const norm = normalizeCoordinates({ lat: latRaw, lng: lngRaw }, { requireVietnam: false });
      if (!norm.ok) return;

      const now = Date.now();
      const safeAccuracy =
        typeof accuracyRaw === 'number' && Number.isFinite(accuracyRaw) && accuracyRaw > 0
          ? Math.max(3, Math.round(accuracyRaw))
          : 15;

      const prev = lastAcceptedRef.current;

      if (prev && !prev.isFallback) {
        // Bỏ qua mẫu sai số quá kém (> 500m) khi đang có khóa GPS tốt (< 65m)
        if (safeAccuracy > 500 && prev.accuracy <= 65 && now - prev.at < 20_000) {
          return;
        }

        const movedM = haversineMeters(prev.lat, prev.lng, norm.lat, norm.lng);
        const dtSec = Math.max(0.2, (now - prev.at) / 1000);
        const impliedSpeedMs = movedM / dtSec;

        // Lọc điểm nhảy đột ngột phi vật lý (> 350m với vận tốc suy diễn > 60 m/s ~ 216 km/h);
        // chỉ chấp nhận nếu 2 mẫu liên tiếp cùng xác nhận vị trí mới (ví dụ đổi vị trí thực sự)
        if (movedM > 350 && impliedSpeedMs > 60 && dtSec < 12) {
          const cand = outlierCandidateRef.current;
          if (cand && haversineMeters(cand.lat, cand.lng, norm.lat, norm.lng) < 120) {
            if (cand.count + 1 < 2) {
              outlierCandidateRef.current = { lat: norm.lat, lng: norm.lng, count: cand.count + 1 };
              return;
            }
          } else {
            outlierCandidateRef.current = { lat: norm.lat, lng: norm.lng, count: 1 };
            return;
          }
        }
        outlierCandidateRef.current = null;

        // Bỏ qua nhiễu dao động đứng yên (< 1.2m khi vận tốc gần 0) để mũi tên xe không rung lắc tại chỗ
        const stationary = speedMs !== null && Number.isFinite(speedMs) ? speedMs < 0.4 : movedM < 1.2;
        if (movedM < 1.2 && stationary && now - prev.at < 8_000) {
          return;
        }
      }

      let nextHeading: number | null =
        typeof headingRaw === 'number' &&
        Number.isFinite(headingRaw) &&
        headingRaw >= 0 &&
        (speedMs === null || !Number.isFinite(speedMs) || speedMs >= 0.5)
          ? ((Math.round(headingRaw) % 360) + 360) % 360
          : null;

      if (nextHeading === null && prev) {
        const movedFromPrevM = haversineMeters(prev.lat, prev.lng, norm.lat, norm.lng);
        if (movedFromPrevM >= 2.0 && !prev.isFallback) {
          nextHeading = Math.round(computeBearingDeg(prev, norm)) % 360;
        } else {
          nextHeading = prev.heading;
        }
      }

      const computedSpeedKmh =
        typeof speedMs === 'number' && Number.isFinite(speedMs) && speedMs >= 0
          ? Math.round(speedMs * 3.6)
          : prev && !prev.isFallback && now - prev.at >= 800 && now - prev.at <= 15_000
            ? Math.min(
                130,
                Math.round(
                  (haversineMeters(prev.lat, prev.lng, norm.lat, norm.lng) / ((now - prev.at) / 1000)) * 3.6,
                ),
              )
            : null;

      lastAcceptedRef.current = {
        lat: norm.lat,
        lng: norm.lng,
        accuracy: safeAccuracy,
        heading: nextHeading,
        isFallback: false,
        at: now,
      };

      setPos({
        lat: norm.lat,
        lng: norm.lng,
        accuracy: safeAccuracy,
        heading: nextHeading,
        speedKmh: computedSpeedKmh !== null && computedSpeedKmh >= 2 ? computedSpeedKmh : 0,
        isFallback: false,
        updatedAt: now,
      });
    },
    [],
  );

  const refreshNow = useCallback(async () => {
    try {
      const fix = await getGps();
      setPermissionDenied(false);
      applyHardwareCoords(fix.lat, fix.lng, fix.accuracy, null, null);
    } catch (err) {
      if (err && typeof err === 'object' && 'kind' in err && (err as { kind?: string }).kind === 'denied') {
        setPermissionDenied(true);
      }
    }
  }, [applyHardwareCoords]);

  useEffect(() => {
    void refreshNow();

    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      return undefined;
    }

    setWatching(true);
    const watchId = navigator.geolocation.watchPosition(
      (p) => {
        setPermissionDenied(false);
        applyHardwareCoords(
          p.coords.latitude,
          p.coords.longitude,
          p.coords.accuracy,
          p.coords.heading,
          p.coords.speed,
        );
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setPermissionDenied(true);
          setWatching(false);
        }
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 10000,
      },
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
      setWatching(false);
    };
  }, [applyHardwareCoords, refreshNow]);

  return {
    pos,
    watching,
    permissionDenied,
    refreshNow,
  };
}
