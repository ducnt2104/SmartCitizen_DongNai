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
  isSimulating: boolean;
  updatedAt: number;
}

export interface LiveNavigationGpsState {
  pos: LiveNavPosition;
  watching: boolean;
  permissionDenied: boolean;
  refreshNow: () => Promise<void>;
  startSimulation: (path: Array<{ lat: number; lng: number }>) => void;
  stopSimulation: () => void;
}

function buildDefaultBasePos(wardCode?: string | null): LiveNavPosition {
  if (wardCode && WARD_BY_CODE[wardCode]) {
    const w = WARD_BY_CODE[wardCode];
    return {
      lat: w.centerLat,
      lng: w.centerLng,
      accuracy: 35,
      heading: null,
      speedKmh: null,
      isFallback: true,
      isSimulating: false,
      updatedAt: Date.now(),
    };
  }
  return {
    lat: TRAN_BIEN_FALLBACK_COORDS.lat,
    lng: TRAN_BIEN_FALLBACK_COORDS.lng,
    accuracy: 35,
    heading: null,
    speedKmh: null,
    isFallback: true,
    isSimulating: false,
    updatedAt: Date.now(),
  };
}

/**
 * Live GPS Tracking chuẩn Google Maps Navigation:
 * - Chạy `navigator.geolocation.watchPosition` liên tục (kèm hướng di chuyển `heading` & vận tốc).
 * - Tự động suy luận góc quay đầu xe (`bearing`) khi thiết bị không có la bàn từ kế phần cứng.
 * - Hỗ trợ chế độ mô phỏng di chuyển dọc lộ trình (`startSimulation`) rõ ràng để kiểm thử thực tế trên máy trạm.
 */
export function useLiveNavigationGps(wardCode?: string | null): LiveNavigationGpsState {
  const [pos, setPos] = useState<LiveNavPosition>(() => buildDefaultBasePos(wardCode));
  const [watching, setWatching] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const prevCoordsRef = useRef<{ lat: number; lng: number; heading: number | null } | null>(null);
  const simTimerRef = useRef<number | null>(null);
  const simulatingRef = useRef(false);

  const stopSimulation = useCallback(() => {
    if (simTimerRef.current !== null) {
      window.clearInterval(simTimerRef.current);
      simTimerRef.current = null;
    }
    simulatingRef.current = false;
    setPos((cur) => (cur.isSimulating ? { ...cur, isSimulating: false, speedKmh: null } : cur));
  }, []);

  const applyHardwareCoords = useCallback(
    (latRaw: number, lngRaw: number, accuracyRaw: number, headingRaw: number | null, speedMs: number | null) => {
      if (simulatingRef.current) return;
      const norm = normalizeCoordinates({ lat: latRaw, lng: lngRaw }, { requireVietnam: false });
      if (!norm.ok) return;

      let nextHeading: number | null =
        typeof headingRaw === 'number' && Number.isFinite(headingRaw) && headingRaw >= 0
          ? Math.round(headingRaw) % 360
          : null;

      const prev = prevCoordsRef.current;
      if (nextHeading === null && prev) {
        const movedM = haversineMeters(prev.lat, prev.lng, norm.lat, norm.lng);
        if (movedM >= 3) {
          nextHeading = Math.round(computeBearingDeg(prev, norm));
        } else {
          nextHeading = prev.heading;
        }
      }

      prevCoordsRef.current = { lat: norm.lat, lng: norm.lng, heading: nextHeading };
      setPos({
        lat: norm.lat,
        lng: norm.lng,
        accuracy: Math.max(3, Math.round(accuracyRaw || 15)),
        heading: nextHeading,
        speedKmh:
          typeof speedMs === 'number' && Number.isFinite(speedMs) && speedMs >= 0
            ? Math.round(speedMs * 3.6)
            : null,
        isFallback: false,
        isSimulating: false,
        updatedAt: Date.now(),
      });
    },
    [],
  );

  const refreshNow = useCallback(async () => {
    stopSimulation();
    try {
      const fix = await getGps();
      setPermissionDenied(false);
      applyHardwareCoords(fix.lat, fix.lng, fix.accuracy, null, null);
    } catch (err) {
      if (err && typeof err === 'object' && 'kind' in err && (err as { kind?: string }).kind === 'denied') {
        setPermissionDenied(true);
      }
    }
  }, [applyHardwareCoords, stopSimulation]);

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
        maximumAge: 2500,
        timeout: 12000,
      },
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
      if (simTimerRef.current !== null) {
        window.clearInterval(simTimerRef.current);
        simTimerRef.current = null;
      }
      setWatching(false);
    };
  }, [applyHardwareCoords, refreshNow]);

  const startSimulation = useCallback(
    (rawPath: Array<{ lat: number; lng: number }>) => {
      if (rawPath.length < 2) return;
      stopSimulation();
      simulatingRef.current = true;

      // Chia nhỏ lộ trình thành các bước ~35m để chuyển động 60FPS mượt mà
      const dense: Array<{ lat: number; lng: number }> = [rawPath[0]];
      for (let i = 1; i < rawPath.length; i += 1) {
        const a = rawPath[i - 1];
        const b = rawPath[i];
        const segM = haversineMeters(a.lat, a.lng, b.lat, b.lng);
        const slices = Math.max(1, Math.min(25, Math.ceil(segM / 35)));
        for (let s = 1; s <= slices; s += 1) {
          const t = s / slices;
          dense.push({
            lat: a.lat + (b.lat - a.lat) * t,
            lng: a.lng + (b.lng - a.lng) * t,
          });
        }
      }

      let cursor = 0;
      simTimerRef.current = window.setInterval(() => {
        if (cursor >= dense.length) {
          stopSimulation();
          return;
        }
        const curPt = dense[cursor];
        const nextPt = dense[Math.min(dense.length - 1, cursor + 1)];
        const heading =
          curPt.lat !== nextPt.lat || curPt.lng !== nextPt.lng
            ? Math.round(computeBearingDeg(curPt, nextPt))
            : prevCoordsRef.current?.heading ?? 0;

        prevCoordsRef.current = { lat: curPt.lat, lng: curPt.lng, heading };
        setPos({
          lat: curPt.lat,
          lng: curPt.lng,
          accuracy: 8,
          heading,
          speedKmh: cursor === dense.length - 1 ? 0 : 42,
          isFallback: false,
          isSimulating: true,
          updatedAt: Date.now(),
        });
        cursor += 1;
      }, 900);
    },
    [stopSimulation],
  );

  return {
    pos,
    watching,
    permissionDenied,
    refreshNow,
    startSimulation,
    stopSimulation,
  };
}
