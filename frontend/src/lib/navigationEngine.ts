import { ARTERIAL_ROADS, haversineMeters } from '@shared/geo';
import { isGoogleMapsHealthy } from './mapConfig';

export type TravelVehicleMode = 'rescue_truck' | 'motorcycle' | 'walking';

export type TurnManeuverKind =
  | 'depart'
  | 'straight'
  | 'turn-left'
  | 'turn-slight-left'
  | 'turn-sharp-left'
  | 'turn-right'
  | 'turn-slight-right'
  | 'turn-sharp-right'
  | 'uturn-left'
  | 'uturn-right'
  | 'roundabout'
  | 'merge'
  | 'fork-left'
  | 'fork-right'
  | 'arrive';

export interface NavigationStep {
  index: number;
  instructionVi: string;
  shortRoadName: string;
  maneuver: TurnManeuverKind;
  distanceM: number;
  durationSec: number;
  startLocation: { lat: number; lng: number };
  endLocation: { lat: number; lng: number };
  roundaboutExit?: number;
}

export interface NavigationRoute {
  distanceM: number;
  distanceKm: number;
  durationSec: number;
  durationMin: number;
  path: Array<{ lat: number; lng: number }>;
  steps: NavigationStep[];
  source: 'google_directions' | 'osrm' | 'arterial_fallback';
  vehicleMode: TravelVehicleMode;
}

export interface ActiveStepProgress {
  activeStepIndex: number;
  currentStep: NavigationStep;
  nextStep: NavigationStep | null;
  distanceToTurnM: number;
  remainingDistanceKm: number;
  remainingDurationMin: number;
  suggestedBearingDeg: number | null;
  /** Độ lệch vuông góc (mét) từ vị trí xe hiện tại tới tuyến đường đang dẫn */
  offRouteMeters: number;
  /** Phần lộ trình còn lại phía trước tính từ mũi xe tới điểm sự cố */
  aheadPath: Array<{ lat: number; lng: number }>;
}

/** Độ lệch góc ngắn nhất (-180..+180 độ) phục vụ nội suy góc xoay xe mượt mà không bị lật ngược qua mốc 0°/360°. */
export function shortestAngleDeltaDeg(fromDeg: number, toDeg: number): number {
  return ((((toDeg - fromDeg) % 360) + 540) % 360) - 180;
}

export interface PolylineProjection {
  minDistanceM: number;
  closestPoint: { lat: number; lng: number };
  segmentIndex: number;
  remainingPathMeters: number;
  aheadPath: Array<{ lat: number; lng: number }>;
  forwardBearingDeg: number | null;
}

/** Chiếu vuông góc tọa độ GPS hiện tại lên đa tuyến `path` để tính độ lệch off-route (mét) và quãng đường thực còn lại. */
export function projectPointOntoPolyline(
  pos: { lat: number; lng: number },
  path: ReadonlyArray<{ lat: number; lng: number }>,
): PolylineProjection {
  if (path.length === 0) {
    return {
      minDistanceM: 0,
      closestPoint: pos,
      segmentIndex: 0,
      remainingPathMeters: 0,
      aheadPath: [pos],
      forwardBearingDeg: null,
    };
  }
  if (path.length === 1) {
    const d = haversineMeters(pos.lat, pos.lng, path[0].lat, path[0].lng);
    return {
      minDistanceM: d,
      closestPoint: path[0],
      segmentIndex: 0,
      remainingPathMeters: d,
      aheadPath: [pos, path[0]],
      forwardBearingDeg: d > 2 ? computeBearingDeg(pos, path[0]) : null,
    };
  }

  const cosLat = Math.max(0.2, Math.cos((pos.lat * Math.PI) / 180));
  const mPerDegLat = 110_574;
  const mPerDegLng = 111_320 * cosLat;

  let bestDistSq = Infinity;
  let bestSeg = 0;
  let bestProj = path[0];

  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i];
    const b = path[i + 1];
    const ax = (a.lng - pos.lng) * mPerDegLng;
    const ay = (a.lat - pos.lat) * mPerDegLat;
    const bx = (b.lng - pos.lng) * mPerDegLng;
    const by = (b.lat - pos.lat) * mPerDegLat;
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq > 1e-6 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq)) : 0;
    const px = ax + dx * t;
    const py = ay + dy * t;
    const dSq = px * px + py * py;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestSeg = i;
      bestProj = {
        lat: a.lat + (b.lat - a.lat) * t,
        lng: a.lng + (b.lng - a.lng) * t,
      };
    }
  }

  const segEnd = path[bestSeg + 1];
  let remainingM = haversineMeters(bestProj.lat, bestProj.lng, segEnd.lat, segEnd.lng);
  for (let j = bestSeg + 1; j < path.length - 1; j += 1) {
    remainingM += haversineMeters(path[j].lat, path[j].lng, path[j + 1].lat, path[j + 1].lng);
  }

  const tailVertices = path.slice(bestSeg + 1);
  const aheadPath = [bestProj, ...tailVertices];
  const lookAhead = tailVertices[0] ?? bestProj;
  const forwardBearingDeg =
    haversineMeters(bestProj.lat, bestProj.lng, lookAhead.lat, lookAhead.lng) > 1.5
      ? computeBearingDeg(bestProj, lookAhead)
      : null;

  return {
    minDistanceM: Math.sqrt(bestDistSq),
    closestPoint: bestProj,
    segmentIndex: bestSeg,
    remainingPathMeters: remainingM,
    aheadPath: aheadPath.length >= 2 ? aheadPath : [pos, path[path.length - 1]],
    forwardBearingDeg,
  };
}

/** Tính góc phương vị (0..360 độ theo chiều kim đồng hồ từ hướng Bắc) giữa 2 tọa độ GPS. */
export function computeBearingDeg(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): number {
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const dLng = ((to.lng - from.lng) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const brng = (Math.atan2(y, x) * 180) / Math.PI;
  return (brng + 360) % 360;
}

export function compassDirectionVi(bearingDeg: number): string {
  const dirs = ['Bắc', 'Đông Bắc', 'Đông', 'Đông Nam', 'Nam', 'Tây Nam', 'Tây', 'Tây Bắc'];
  const idx = Math.round(((bearingDeg % 360) + 360) % 360 / 45) % 8;
  return dirs[idx];
}

/** Định dạng khoảng cách chuẩn Google Maps tiếng Việt (`85 m`, `250 m`, `1,4 km`). */
export function formatDistanceVi(meters: number): string {
  const m = Math.max(0, Math.round(meters));
  if (m < 1000) {
    const rounded = m >= 100 ? Math.round(m / 10) * 10 : Math.max(5, Math.round(m / 5) * 5);
    return `${rounded} m`;
  }
  const km = m / 1000;
  return `${km >= 10 ? Math.round(km) : km.toFixed(1).replace('.', ',')} km`;
}

/** Định dạng giờ dự kiến đến nơi (ví dụ `12:08`). */
export function formatArrivalClock(durationMin: number): string {
  const target = new Date(Date.now() + Math.max(1, durationMin) * 60_000);
  return target.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Bóc sạch HTML từ Google Directions `instructions` mà không dùng innerHTML (an toàn XSS). */
export function stripDirectionHtml(rawHtml: string): string {
  return rawHtml
    .replace(/<div[^>]*>/gi, ' · ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Chuẩn hóa mã maneuver của Google Directions về `TurnManeuverKind`. */
export function mapGoogleManeuver(raw: string | undefined, isFirst: boolean, isLast: boolean): TurnManeuverKind {
  if (isLast && !raw) return 'arrive';
  if (isFirst && !raw) return 'depart';
  const m = (raw ?? '').toLowerCase();
  if (m.includes('roundabout') || m.includes('rotary')) return 'roundabout';
  if (m.includes('uturn-right')) return 'uturn-right';
  if (m.includes('uturn')) return 'uturn-left';
  if (m.includes('sharp-left')) return 'turn-sharp-left';
  if (m.includes('slight-left')) return 'turn-slight-left';
  if (m.includes('fork-left')) return 'fork-left';
  if (m.includes('ramp-left') || m.includes('turn-left') || m.includes('keep-left')) return 'turn-left';
  if (m.includes('sharp-right')) return 'turn-sharp-right';
  if (m.includes('slight-right')) return 'turn-slight-right';
  if (m.includes('fork-right')) return 'fork-right';
  if (m.includes('ramp-right') || m.includes('turn-right') || m.includes('keep-right')) return 'turn-right';
  if (m.includes('merge')) return 'merge';
  return 'straight';
}

interface OsrmRawStep {
  distance?: number;
  duration?: number;
  name?: string;
  ref?: string;
  destinations?: string;
  maneuver?: {
    type?: string;
    modifier?: string;
    location?: [number, number];
    bearing_after?: number;
    exit?: number;
  };
  geometry?: {
    coordinates?: Array<[number, number]>;
  };
}

function mapOsrmManeuver(typeRaw?: string, modRaw?: string): TurnManeuverKind {
  const t = (typeRaw ?? '').toLowerCase();
  const m = (modRaw ?? '').toLowerCase();
  if (t === 'arrive') return 'arrive';
  if (t === 'depart') return 'depart';
  if (t === 'roundabout' || t === 'rotary' || t === 'exit roundabout' || t === 'exit rotary') return 'roundabout';
  if (t === 'merge') return 'merge';
  if (t === 'fork') return m.includes('left') ? 'fork-left' : 'fork-right';
  if (m === 'uturn') return 'uturn-left';
  if (m === 'sharp left') return 'turn-sharp-left';
  if (m === 'slight left') return 'turn-slight-left';
  if (m === 'left') return 'turn-left';
  if (m === 'sharp right') return 'turn-sharp-right';
  if (m === 'slight right') return 'turn-slight-right';
  if (m === 'right') return 'turn-right';
  return 'straight';
}

function formatRoadTarget(step: OsrmRawStep): string {
  const name = (step.name ?? '').trim();
  const ref = (step.ref ?? '').trim();
  if (name && ref && !name.toLowerCase().includes(ref.toLowerCase())) {
    return `${name} (${ref})`;
  }
  return name || ref || '';
}

function modifierActionVi(modifier?: string): string {
  switch ((modifier ?? '').toLowerCase()) {
    case 'left':
      return 'Rẽ trái';
    case 'slight left':
      return 'Rẽ chếch trái';
    case 'sharp left':
      return 'Rẽ gắt bên trái';
    case 'right':
      return 'Rẽ phải';
    case 'slight right':
      return 'Rẽ chếch phải';
    case 'sharp right':
      return 'Rẽ gắt bên phải';
    case 'uturn':
      return 'Quay đầu xe';
    case 'straight':
    default:
      return 'Đi thẳng';
  }
}

/** Biên dịch bước rẽ OSRM sang câu chỉ đường tiếng Việt tự nhiên chuẩn Google Maps. */
export function buildVietnameseOsrmInstruction(step: OsrmRawStep): { instructionVi: string; shortRoadName: string } {
  const t = (step.maneuver?.type ?? '').toLowerCase();
  const mod = (step.maneuver?.modifier ?? '').toLowerCase();
  const road = formatRoadTarget(step);
  const exit = step.maneuver?.exit;
  const intoRoad = road ? ` vào ${road}` : '';
  const alongRoad = road ? ` theo ${road}` : '';

  if (t === 'depart') {
    const dir =
      typeof step.maneuver?.bearing_after === 'number'
        ? ` về hướng ${compassDirectionVi(step.maneuver.bearing_after)}`
        : '';
    return {
      instructionVi: road ? `Xuất phát${dir} trên ${road}` : `Xuất phát${dir} theo lộ trình`,
      shortRoadName: road || 'Điểm xuất phát',
    };
  }

  if (t === 'arrive') {
    const side =
      mod === 'left'
        ? ' (bên trái)'
        : mod === 'right'
          ? ' (bên phải)'
          : '';
    return {
      instructionVi: `Đến hiện trường sự cố${road ? ` tại ${road}` : ''}${side}`,
      shortRoadName: road || 'Hiện trường sự cố',
    };
  }

  if (t === 'roundabout' || t === 'rotary' || t === 'roundabout turn') {
    const exitStr = exit ? ` và ra ở lối thứ ${exit}` : '';
    return {
      instructionVi: `Đi vào vòng xoay${exitStr}${intoRoad}`,
      shortRoadName: road || 'Vòng xoay',
    };
  }

  if (t === 'exit roundabout' || t === 'exit rotary') {
    return {
      instructionVi: `Ra khỏi vòng xoay${intoRoad}`,
      shortRoadName: road || 'Lối ra vòng xoay',
    };
  }

  if (t === 'merge') {
    return {
      instructionVi: `Nhập làn${intoRoad || ' vào trục đường chính'}`,
      shortRoadName: road || 'Nhập làn',
    };
  }

  if (t === 'on ramp' || t === 'off ramp') {
    return {
      instructionVi: `${modifierActionVi(mod)} vào nhánh dẫn${road ? ` ${road}` : ''}`,
      shortRoadName: road || 'Nhánh dẫn',
    };
  }

  if (t === 'fork') {
    const keepSide = mod.includes('left') ? 'Đi chếch bên trái tại ngã ba' : 'Đi chếch bên phải tại ngã ba';
    return {
      instructionVi: `${keepSide}${intoRoad}`,
      shortRoadName: road || 'Ngã rẽ',
    };
  }

  if (t === 'end of road') {
    return {
      instructionVi: `Cuối đường, ${modifierActionVi(mod).toLowerCase()}${intoRoad}`,
      shortRoadName: road || 'Cuối đường',
    };
  }

  if (t === 'new name' || t === 'continue') {
    if (mod && mod !== 'straight') {
      return {
        instructionVi: `${modifierActionVi(mod)} để tiếp tục${alongRoad}`,
        shortRoadName: road || 'Tiếp tục lộ trình',
      };
    }
    return {
      instructionVi: road ? `Tiếp tục đi thẳng trên ${road}` : 'Tiếp tục đi thẳng',
      shortRoadName: road || 'Đi thẳng',
    };
  }

  const act = modifierActionVi(mod);
  if (act === 'Đi thẳng') {
    return {
      instructionVi: road ? `Đi thẳng trên ${road}` : 'Đi thẳng theo tuyến đường',
      shortRoadName: road || 'Đi thẳng',
    };
  }

  return {
    instructionVi: `${act}${intoRoad}`,
    shortRoadName: road || act,
  };
}

function adjustDurationByVehicle(baseDrivingSeconds: number, distanceM: number, mode: TravelVehicleMode): number {
  if (mode === 'walking') {
    // Tốc độ đi bộ tiếp cận hiện trường trung bình ~4.8 km/h (1.33 m/s)
    return Math.max(60, Math.round(distanceM / 1.33));
  }
  if (mode === 'motorcycle') {
    // Xe máy cơ động trong đô thị Việt Nam thường linh hoạt hơn ô tô ~12% ở đường hẹp
    return Math.max(45, Math.round(baseDrivingSeconds * 0.88));
  }
  return Math.max(45, Math.round(baseDrivingSeconds));
}

/** Ưu tiên 1: Truy vấn Google Maps `DirectionsService` (language: 'vi', region: 'VN'). */
export async function fetchGoogleNavigationRoute(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  vehicleMode: TravelVehicleMode,
  signal?: AbortSignal,
): Promise<NavigationRoute | null> {
  if (
    !isGoogleMapsHealthy() ||
    typeof window === 'undefined' ||
    !Boolean((window as Window & { google?: typeof google }).google?.maps?.DirectionsService) ||
    signal?.aborted
  ) {
    return null;
  }

  try {
    const svc = new google.maps.DirectionsService();
    const tm = google.maps.TravelMode as unknown as Record<string, google.maps.TravelMode>;
    const travelMode =
      vehicleMode === 'walking'
        ? google.maps.TravelMode.WALKING
        : vehicleMode === 'motorcycle' && tm.TWO_WHEELER
          ? tm.TWO_WHEELER
          : google.maps.TravelMode.DRIVING;

    const res = await svc.route({
      origin,
      destination,
      travelMode,
      region: 'VN',
      language: 'vi',
    });
    if (signal?.aborted) return null;

    const route0 = res.routes?.[0];
    const leg = route0?.legs?.[0];
    if (!route0 || !leg || !leg.steps || leg.steps.length === 0) return null;

    const detailedPath: Array<{ lat: number; lng: number }> = [];
    const steps: NavigationStep[] = leg.steps.map((s, idx) => {
      for (const pt of s.path ?? []) {
        const lat = pt.lat();
        const lng = pt.lng();
        const prev = detailedPath[detailedPath.length - 1];
        if (!prev || prev.lat !== lat || prev.lng !== lng) {
          detailedPath.push({ lat, lng });
        }
      }
      const cleanVi = stripDirectionHtml(s.instructions || '');
      const maneuver = mapGoogleManeuver(s.maneuver, idx === 0, idx === leg.steps.length - 1);
      const startLoc = s.start_location
        ? { lat: s.start_location.lat(), lng: s.start_location.lng() }
        : origin;
      const endLoc = s.end_location
        ? { lat: s.end_location.lat(), lng: s.end_location.lng() }
        : destination;
      return {
        index: idx,
        instructionVi: cleanVi || 'Đi tiếp theo lộ trình dẫn đường',
        shortRoadName: cleanVi.split('·')[0]?.trim() || 'Lộ trình chính',
        maneuver,
        distanceM: Math.max(5, Math.round(s.distance?.value ?? haversineMeters(startLoc.lat, startLoc.lng, endLoc.lat, endLoc.lng))),
        durationSec: Math.max(5, Math.round(s.duration?.value ?? 15)),
        startLocation: startLoc,
        endLocation: endLoc,
      };
    });

    // Thêm điểm đích rõ ràng ở cuối danh sách bước nếu Google chưa gắn bước arrive riêng
    const lastStep = steps[steps.length - 1];
    if (lastStep && lastStep.maneuver !== 'arrive') {
      steps.push({
        index: steps.length,
        instructionVi: `Đến hiện trường sự cố${leg.end_address ? ` (${leg.end_address.split(',')[0]})` : ''}`,
        shortRoadName: leg.end_address?.split(',')[0]?.trim() || 'Hiện trường sự cố',
        maneuver: 'arrive',
        distanceM: 0,
        durationSec: 0,
        startLocation: destination,
        endLocation: destination,
      });
    }

    const overviewFallback = (route0.overview_path ?? []).map((p) => ({ lat: p.lat(), lng: p.lng() }));
    const path = detailedPath.length >= 2 ? detailedPath : overviewFallback.length >= 2 ? overviewFallback : [origin, destination];
    const distM = Math.max(20, Math.round(leg.distance?.value ?? haversineMeters(origin.lat, origin.lng, destination.lat, destination.lng)));
    const rawDurSec = Math.max(30, Math.round(leg.duration?.value ?? distM / 10));
    const adjustedDurSec =
      vehicleMode === 'motorcycle' && travelMode === google.maps.TravelMode.DRIVING
        ? adjustDurationByVehicle(rawDurSec, distM, 'motorcycle')
        : rawDurSec;

    return {
      distanceM: distM,
      distanceKm: Math.max(0.1, Math.round((distM / 1000) * 100) / 100),
      durationSec: adjustedDurSec,
      durationMin: Math.max(1, Math.round(adjustedDurSec / 60)),
      path,
      steps,
      source: 'google_directions',
      vehicleMode,
    };
  } catch {
    return null;
  }
}

/** Ưu tiên 2 (Dự phòng tự động 100%): OSRM Public Routing API với `steps=true` & `geometries=geojson`. */
export async function fetchOsrmNavigationRoute(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  vehicleMode: TravelVehicleMode,
  signal?: AbortSignal,
): Promise<NavigationRoute | null> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return null;

  const profile = vehicleMode === 'walking' ? 'foot' : 'driving';
  const coordsStr = `${origin.lng.toFixed(6)},${origin.lat.toFixed(6)};${destination.lng.toFixed(6)},${destination.lat.toFixed(6)}`;
  const url = `https://router.project-osrm.org/route/v1/${profile}/${coordsStr}?overview=full&geometries=geojson&steps=true`;

  const ctrl = new AbortController();
  const timer = typeof window !== 'undefined' ? window.setTimeout(() => ctrl.abort(), 5500) : null;
  const onParentAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onParentAbort);

  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      code?: string;
      routes?: Array<{
        distance?: number;
        duration?: number;
        geometry?: { coordinates?: Array<[number, number]> };
        legs?: Array<{ steps?: OsrmRawStep[] }>;
      }>;
    };

    const r0 = json.routes?.[0];
    const coords = r0?.geometry?.coordinates;
    if (!r0 || !coords || coords.length < 2) return null;

    const rawSteps = r0.legs?.[0]?.steps ?? [];
    const steps: NavigationStep[] = rawSteps.map((s, idx) => {
      const stepCoords = s.geometry?.coordinates ?? [];
      const firstPt = stepCoords[0] ?? s.maneuver?.location ?? [origin.lng, origin.lat];
      const lastPt = stepCoords[stepCoords.length - 1] ?? [destination.lng, destination.lat];
      const { instructionVi, shortRoadName } = buildVietnameseOsrmInstruction(s);
      const stepDistM = Math.max(0, Math.round(s.distance ?? 0));
      const stepDurSec = adjustDurationByVehicle(Math.round(s.duration ?? 10), stepDistM, vehicleMode);

      return {
        index: idx,
        instructionVi,
        shortRoadName,
        maneuver: mapOsrmManeuver(s.maneuver?.type, s.maneuver?.modifier),
        distanceM: stepDistM,
        durationSec: stepDurSec,
        startLocation: { lat: firstPt[1], lng: firstPt[0] },
        endLocation: { lat: lastPt[1], lng: lastPt[0] },
        roundaboutExit: s.maneuver?.exit,
      };
    });

    const distM = Math.max(20, Math.round(r0.distance ?? haversineMeters(origin.lat, origin.lng, destination.lat, destination.lng)));
    const durSec = adjustDurationByVehicle(Math.round(r0.duration ?? distM / 10), distM, vehicleMode);

    return {
      distanceM: distM,
      distanceKm: Math.max(0.1, Math.round((distM / 1000) * 100) / 100),
      durationSec: durSec,
      durationMin: Math.max(1, Math.round(durSec / 60)),
      path: coords.map(([lng, lat]) => ({ lat, lng })),
      steps: steps.length > 0 ? steps : buildFallbackSteps(origin, destination, vehicleMode).steps,
      source: 'osrm',
      vehicleMode,
    };
  } catch {
    return null;
  } finally {
    if (timer !== null) window.clearTimeout(timer);
    signal?.removeEventListener('abort', onParentAbort);
  }
}

/** Dự phòng Cấp 3 (Offline hoàn toàn): Nội suy qua trục đường huyết mạch gần nhất để 100% luôn có chỉ đường. */
export function buildFallbackSteps(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  vehicleMode: TravelVehicleMode,
): NavigationRoute {
  const straightM = Math.max(30, haversineMeters(origin.lat, origin.lng, destination.lat, destination.lng));
  const distM = Math.round(straightM * 1.24);
  const baseDriveSec = Math.round(distM / 10.5);
  const durSec = adjustDurationByVehicle(baseDriveSec, distM, vehicleMode);

  // Tìm điểm trung gian qua trục đường chính gần đó để lộ trình bám lưới đô thị tự nhiên
  let midPoint = {
    lat: origin.lat + (destination.lat - origin.lat) * 0.52,
    lng: destination.lng + (origin.lng - destination.lng) * 0.18,
  };
  let roadLabel = 'Trục đường liên phường';
  let bestArtDist = Infinity;
  for (const road of ARTERIAL_ROADS) {
    for (const [rLat, rLng] of road.points) {
      const d = haversineMeters(origin.lat, origin.lng, rLat, rLng) + haversineMeters(rLat, rLng, destination.lat, destination.lng);
      if (d < straightM * 1.65 && d < bestArtDist) {
        bestArtDist = d;
        midPoint = { lat: rLat, lng: rLng };
        roadLabel = road.name;
      }
    }
  }

  const b1 = computeBearingDeg(origin, midPoint);
  const b2 = computeBearingDeg(midPoint, destination);
  const turnDiff = ((b2 - b1 + 540) % 360) - 180;
  const midManeuver: TurnManeuverKind =
    turnDiff > 25 ? 'turn-right' : turnDiff < -25 ? 'turn-left' : 'straight';
  const midAction =
    midManeuver === 'turn-right' ? 'Rẽ phải' : midManeuver === 'turn-left' ? 'Rẽ trái' : 'Đi thẳng';

  const d1 = Math.round(distM * 0.55);
  const d2 = Math.max(10, distM - d1);

  const steps: NavigationStep[] = [
    {
      index: 0,
      instructionVi: `Xuất phát về hướng ${compassDirectionVi(b1)} tiến ra ${roadLabel}`,
      shortRoadName: roadLabel,
      maneuver: 'depart',
      distanceM: d1,
      durationSec: Math.round(durSec * 0.55),
      startLocation: origin,
      endLocation: midPoint,
    },
    {
      index: 1,
      instructionVi: `${midAction} theo hướng ${compassDirectionVi(b2)} tới khu vực sự cố`,
      shortRoadName: 'Đường tiếp cận hiện trường',
      maneuver: midManeuver,
      distanceM: d2,
      durationSec: Math.round(durSec * 0.45),
      startLocation: midPoint,
      endLocation: destination,
    },
    {
      index: 2,
      instructionVi: 'Đến hiện trường sự cố — giảm tốc độ và bật đèn cảnh báo',
      shortRoadName: 'Hiện trường sự cố',
      maneuver: 'arrive',
      distanceM: 0,
      durationSec: 0,
      startLocation: destination,
      endLocation: destination,
    },
  ];

  return {
    distanceM: distM,
    distanceKm: Math.max(0.1, Math.round((distM / 1000) * 100) / 100),
    durationSec: durSec,
    durationMin: Math.max(1, Math.round(durSec / 60)),
    path: [origin, midPoint, destination],
    steps,
    source: 'arterial_fallback',
    vehicleMode,
  };
}

/**
 * Engine dẫn đường hợp nhất 3 tầng (0% lỗi):
 *  1) Google Maps `DirectionsService` (`language: 'vi'`, `region: 'VN'`)
 *  2) OSRM Public Routing API (`steps=true`, `geometries=geojson`)
 *  3) Nội suy trục đường đô thị Offline
 */
export async function computeNavigationRoute(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  vehicleMode: TravelVehicleMode = 'rescue_truck',
  signal?: AbortSignal,
): Promise<NavigationRoute> {
  const googleRoute = await fetchGoogleNavigationRoute(origin, destination, vehicleMode, signal);
  if (googleRoute) return googleRoute;

  const osrmRoute = await fetchOsrmNavigationRoute(origin, destination, vehicleMode, signal);
  if (osrmRoute) return osrmRoute;

  return buildFallbackSteps(origin, destination, vehicleMode);
}

/**
 * Xác định chặng rẽ hiện tại, bước kế tiếp và khoảng cách thực tế tới điểm rẽ theo Live GPS.
 */
export function computeActiveStepProgress(
  route: NavigationRoute,
  currentPos: { lat: number; lng: number },
): ActiveStepProgress {
  const proj = projectPointOntoPolyline(currentPos, route.path);
  const steps = route.steps;
  if (steps.length === 0) {
    const fallbackStep: NavigationStep = {
      index: 0,
      instructionVi: 'Di chuyển tới hiện trường sự cố',
      shortRoadName: 'Hiện trường',
      maneuver: 'straight',
      distanceM: Math.round(proj.remainingPathMeters),
      durationSec: 60,
      startLocation: currentPos,
      endLocation: route.path[route.path.length - 1] ?? currentPos,
    };
    return {
      activeStepIndex: 0,
      currentStep: fallbackStep,
      nextStep: null,
      distanceToTurnM: Math.round(proj.remainingPathMeters),
      remainingDistanceKm: Math.max(0.05, Math.round((proj.remainingPathMeters / 1000) * 100) / 100),
      remainingDurationMin: route.durationMin,
      suggestedBearingDeg: proj.forwardBearingDeg,
      offRouteMeters: Math.round(proj.minDistanceM),
      aheadPath: proj.aheadPath,
    };
  }

  // Chiếu vị trí xe lên từng đoạn step [startLocation -> endLocation] để chọn đúng chặng ngay cả trên quốc lộ dài
  let bestIdx = 0;
  let bestScore = Infinity;
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    const stepProj = projectPointOntoPolyline(currentPos, [s.startLocation, s.endLocation]);
    const dEnd = haversineMeters(currentPos.lat, currentPos.lng, s.endLocation.lat, s.endLocation.lng);
    if (stepProj.minDistanceM < bestScore) {
      bestScore = stepProj.minDistanceM;
      bestIdx = dEnd < 22 && i + 1 < steps.length ? i + 1 : i;
    }
  }

  const displayIdx =
    bestIdx === 0 && steps.length > 1 && steps[0].maneuver === 'depart' && steps[0].distanceM < 45
      ? 1
      : bestIdx;

  const currentStep = steps[displayIdx];
  const nextStep = displayIdx + 1 < steps.length ? steps[displayIdx + 1] : null;
  const maneuverTarget =
    currentStep.maneuver === 'depart' && nextStep ? nextStep.startLocation : currentStep.endLocation;

  const rawTurnDist = haversineMeters(
    currentPos.lat,
    currentPos.lng,
    maneuverTarget.lat,
    maneuverTarget.lng,
  );
  const distanceToTurnM =
    currentStep.maneuver === 'arrive' ? Math.round(rawTurnDist) : Math.max(5, Math.round(rawTurnDist));

  // Quãng đường và thời gian còn lại bám chính xác theo phần đa tuyến phía trước
  const effectiveRemainingM = Math.max(
    currentStep.maneuver === 'arrive' ? rawTurnDist : 15,
    proj.remainingPathMeters > 0 ? proj.remainingPathMeters : rawTurnDist,
  );
  const totalRouteM = Math.max(1, route.distanceM);
  const ratio = Math.min(1.25, effectiveRemainingM / totalRouteM);
  const remainingDurSec = Math.max(20, Math.round(route.durationSec * ratio));

  const suggestedBearingDeg =
    proj.forwardBearingDeg ?? (rawTurnDist > 4 ? computeBearingDeg(currentPos, maneuverTarget) : null);

  return {
    activeStepIndex: displayIdx,
    currentStep:
      currentStep.maneuver === 'depart' && nextStep && distanceToTurnM <= currentStep.distanceM + 80
        ? {
            ...nextStep,
            distanceM: distanceToTurnM,
          }
        : currentStep,
    nextStep:
      currentStep.maneuver === 'depart' && nextStep
        ? displayIdx + 2 < steps.length
          ? steps[displayIdx + 2]
          : null
        : nextStep,
    distanceToTurnM,
    remainingDistanceKm: Math.max(0.05, Math.round((effectiveRemainingM / 1000) * 100) / 100),
    remainingDurationMin: Math.max(1, Math.round(remainingDurSec / 60)),
    suggestedBearingDeg,
    offRouteMeters: Math.round(proj.minDistanceM),
    aheadPath: proj.aheadPath,
  };
}
