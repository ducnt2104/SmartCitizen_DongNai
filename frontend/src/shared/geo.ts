import { DONG_NAI_BBOX } from './constants';
import { DONG_NAI_WARDS, matchWardByAddressText } from './dongNaiWards';
import type { ReverseGeocodeResult, Ward } from './types';

const R = 6371000;
const toRad = (d: number): number => (d * Math.PI) / 180;

/** Khoảng cách Haversine (mét). */
export function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

export function inDongNaiBBox(lat: number, lng: number): boolean {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < DONG_NAI_BBOX.latMin ||
    lat > DONG_NAI_BBOX.latMax ||
    lng < DONG_NAI_BBOX.lngMin ||
    lng > DONG_NAI_BBOX.lngMax
  ) {
    return false;
  }
  // Loại trừ góc Tây Nam (TP.HCM & phía Nam Bình Dương cũ) nằm ngoài ranh giới thực của TP. Đồng Nai
  if (lat < 11.12 && lng < 106.74) return false;
  return true;
}

/** Trục đường huyết mạch toàn Thành phố Đồng Nai (bao gồm cả trục Bắc Đồng Nai QL13/QL14/ĐT741). */
export interface ArterialRoad {
  name: string;
  points: ReadonlyArray<readonly [lat: number, lng: number]>;
}

export const ARTERIAL_ROADS: readonly ArterialRoad[] = [
  {
    name: 'Nguyễn Ái Quốc',
    points: [
      [10.93846, 106.80429], [10.94141, 106.80410], [10.95341, 106.80789], [10.95441, 106.80848],
      [10.95547, 106.80992], [10.95607, 106.81174], [10.95603, 106.82350], [10.95606, 106.82662],
      [10.95669, 106.82846], [10.95822, 106.83070], [10.96037, 106.83278], [10.96257, 106.83625],
      [10.96861, 106.86159], [10.96898, 106.86496], [10.96947, 106.86608], [10.97108, 106.86804],
      [10.97178, 106.86969], [10.97246, 106.88093], [10.97251, 106.88782], [10.97214, 106.88952],
    ],
  },
  {
    name: 'Quốc lộ 1A',
    points: [
      [10.95504, 106.78975], [10.95195, 106.81160], [10.93717, 106.82766], [10.91443, 106.84562],
      [10.90397, 106.84136], [10.92356, 106.86639], [10.94686, 106.86909], [10.96167, 106.88128],
      [10.95871, 106.90424], [10.95306, 106.90727], [10.95550, 106.91252], [10.95671, 106.92245],
      [10.96530, 106.92347], [10.96583, 106.93120], [10.95629, 106.96506], [10.94722, 106.97891],
      [10.95679, 107.03386], [10.94603, 107.05367], [10.93542, 107.11693], [10.94243, 107.13186],
      [10.94147, 107.23374], [10.93422, 107.25297], [10.90041, 107.27287], [10.90781, 107.38651],
      [10.91795, 107.41937], [10.88366, 107.42925], [10.86290, 107.48797], [10.88958, 107.50555],
      [10.88670, 107.50920],
    ],
  },
  {
    name: 'Quốc lộ 51',
    points: [
      [10.90397, 106.84136], [10.90561, 106.84862], [10.90225, 106.85103], [10.89439, 106.86469],
      [10.89428, 106.87320], [10.89773, 106.88445], [10.89747, 106.88892], [10.89420, 106.89373],
      [10.88783, 106.89786], [10.87964, 106.90741], [10.87362, 106.91065], [10.86879, 106.91972],
      [10.85849, 106.92650], [10.85212, 106.92867], [10.84273, 106.92940], [10.82127, 106.94187],
      [10.78552, 106.95563], [10.77952, 106.95787], [10.76518, 106.95911], [10.75544, 106.96367],
      [10.73513, 106.98171], [10.72852, 106.99308], [10.71004, 107.00596], [10.71312, 107.03498],
    ],
  },
  {
    name: 'Quốc lộ 20',
    points: [
      [10.94277, 107.14300], [10.94371, 107.14046], [10.96294, 107.14034], [10.98626, 107.15387],
      [10.99417, 107.15462], [10.99808, 107.16144], [11.01484, 107.17670], [11.07313, 107.16669],
      [11.08900, 107.17441], [11.08978, 107.21229], [11.09553, 107.22608], [11.11041, 107.22930],
      [11.12959, 107.22102], [11.14688, 107.22928], [11.14865, 107.23577], [11.15571, 107.23771],
      [11.15987, 107.25789], [11.15743, 107.27500], [11.16776, 107.30080], [11.16911, 107.31552],
      [11.17897, 107.33475], [11.17748, 107.34168], [11.19625, 107.35200], [11.23438, 107.38543],
      [11.24708, 107.40053], [11.27387, 107.44402], [11.27465, 107.45719], [11.27863, 107.46380],
      [11.27857, 107.47775], [11.28387, 107.48637], [11.28671, 107.49014], [11.30670, 107.48079],
      [11.31812, 107.48200],
    ],
  },
  {
    name: 'Quốc lộ 13',
    points: [
      [11.42842, 106.62678], [11.42983, 106.61550], [11.57225, 106.61756], [11.64452, 106.60690],
      [11.67536, 106.61222], [11.68669, 106.59628], [11.71578, 106.58912], [11.73871, 106.57297],
      [11.78773, 106.58155], [11.81028, 106.60095], [11.85468, 106.58544], [11.86557, 106.59336],
      [11.90098, 106.59754], [11.91914, 106.56957], [11.93672, 106.56536], [11.96504, 106.54500],
    ],
  },
  {
    name: 'Quốc lộ 14',
    points: [
      [11.42842, 106.62678], [11.42486, 106.62483], [11.43602, 106.65395], [11.44952, 106.66615],
      [11.47596, 106.67625], [11.48102, 106.68408], [11.50046, 106.69799], [11.51199, 106.71386],
      [11.51835, 106.73642], [11.51594, 106.75607], [11.50693, 106.76757], [11.50936, 106.78897],
      [11.51538, 106.80680], [11.53019, 106.87705], [11.53526, 106.88311], [11.53720, 106.89960],
      [11.53849, 106.91500], [11.55199, 106.93467], [11.55528, 106.94457], [11.58364, 106.97597],
      [11.60136, 106.98869], [11.60526, 106.99882], [11.60436, 107.00583], [11.61992, 107.02986],
      [11.64389, 107.04352], [11.64876, 107.05376], [11.66901, 107.06541], [11.68259, 107.06698],
      [11.68745, 107.07282], [11.68791, 107.07993], [11.69304, 107.08161], [11.69497, 107.08671],
      [11.70867, 107.09931], [11.70960, 107.11500], [11.70742, 107.12238], [11.71062, 107.13861],
      [11.72455, 107.13856], [11.73617, 107.14467], [11.74726, 107.15836], [11.76206, 107.15944],
      [11.77995, 107.17131], [11.79714, 107.18877], [11.79787, 107.21173], [11.80855, 107.22785],
      [11.81334, 107.25235], [11.81631, 107.25755], [11.83888, 107.27638], [11.84075, 107.28539],
      [11.84923, 107.29286], [11.84801, 107.29713], [11.84324, 107.29894], [11.84514, 107.30587],
      [11.83884, 107.31842], [11.82510, 107.30329],
    ],
  },
  {
    name: 'ĐT 741',
    points: [
      [11.53526, 106.88311], [11.53248, 106.88461], [11.53719, 106.90231], [11.53960, 106.90280],
      [11.57067, 106.90063], [11.59015, 106.88781], [11.59977, 106.89831], [11.60840, 106.90083],
      [11.61534, 106.89864], [11.62140, 106.88859], [11.63406, 106.90103], [11.65335, 106.89618],
      [11.66719, 106.90251], [11.67515, 106.89952], [11.70706, 106.90375], [11.71558, 106.89750],
      [11.71557, 106.88935], [11.72868, 106.87376], [11.73417, 106.87301], [11.76430, 106.88480],
      [11.76753, 106.89247], [11.78263, 106.90577], [11.80579, 106.94774], [11.81557, 106.95432],
      [11.82678, 106.96819], [11.83311, 106.98893], [11.84187, 106.99523], [11.84800, 106.99163],
    ],
  },
  {
    name: 'Cách Mạng Tháng Tám',
    points: [
      [10.95262, 106.80814], [10.95191, 106.81167], [10.95167, 106.81186], [10.95039, 106.81239],
      [10.94855, 106.81477], [10.94585, 106.81852], [10.94512, 106.81910],
    ],
  },
  {
    name: 'Đồng Khởi',
    points: [
      [10.95288, 106.86946], [10.95474, 106.86734], [10.95864, 106.85670], [10.96204, 106.85504],
      [10.96788, 106.85373], [10.97234, 106.85281], [10.97405, 106.85187], [10.97846, 106.84797],
      [10.98142, 106.84756], [10.98492, 106.84645], [10.99563, 106.84651], [11.00115, 106.85040],
      [11.00329, 106.85264],
    ],
  },
  {
    name: 'Võ Thị Sáu',
    points: [
      [10.94631, 106.82376], [10.94723, 106.82884], [10.94872, 106.83560], [10.94922, 106.83762],
    ],
  },
  {
    name: 'Phạm Văn Thuận',
    points: [
      [10.95734, 106.83047], [10.95880, 106.83531], [10.95693, 106.84508], [10.95672, 106.84815],
      [10.95494, 106.85161], [10.95444, 106.85223], [10.95065, 106.85495], [10.94826, 106.85547],
      [10.94564, 106.85708],
    ],
  },
  {
    name: 'Bùi Văn Hòa',
    points: [
      [10.93677, 106.87111], [10.92549, 106.88021], [10.91547, 106.88510], [10.91022, 106.88996],
      [10.90923, 106.89018], [10.90390, 106.88952], [10.90054, 106.89091], [10.89695, 106.89128],
      [10.89530, 106.89229], [10.89339, 106.89444], [10.88833, 106.89745],
    ],
  },
];

/** Khoảng cách từ điểm tới đoạn thẳng (mét) – xấp xỉ phẳng cục bộ. */
function distanceToSegmentMeters(
  pLat: number, pLng: number, aLat: number, aLng: number, bLat: number, bLng: number,
): number {
  const kx = Math.cos(toRad(pLat)) * 111320;
  const ky = 110574;
  const ax = (aLng - pLng) * kx, ay = (aLat - pLat) * ky;
  const bx = (bLng - pLng) * kx, by = (bLat - pLat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

export interface ArterialMatch {
  name: string;
  distanceM: number;
}

/** Trả về trục huyết mạch gần nhất trong ngưỡng (mặc định 60m), hoặc null. */
export function matchArterial(lat: number, lng: number, thresholdM = 60): ArterialMatch | null {
  let best: ArterialMatch | null = null;
  for (const road of ARTERIAL_ROADS) {
    for (let i = 0; i < road.points.length - 1; i++) {
      const [aLat, aLng] = road.points[i];
      const [bLat, bLng] = road.points[i + 1];
      const d = distanceToSegmentMeters(lat, lng, aLat, aLng, bLat, bLng);
      if (d <= thresholdM && (!best || d < best.distanceM)) best = { name: road.name, distanceM: d };
    }
  }
  return best;
}

export function nearestWard(lat: number, lng: number): Ward {
  let best = DONG_NAI_WARDS[0];
  let bestD = Infinity;
  for (const w of DONG_NAI_WARDS) {
    const d = haversineMeters(lat, lng, w.centerLat, w.centerLng);
    if (d < bestD) {
      bestD = d;
      best = w;
    }
  }
  return best;
}

/**
 * Bộ giải địa giới 3 tầng chuẩn 2 cấp (Thành phố Đồng Nai -> 95 Phường/Xã):
 *  - Tầng 1: Kiểm tra Bounding Box toàn Thành phố Đồng Nai (ngoài biên giới -> báo rõ, không gán bừa).
 *  - Tầng 2: Nếu có chuỗi địa chỉ OSM/Nominatim -> quy đổi qua legacyAliases 2 thế hệ (3 cấp cũ & 10 xã lên phường 30/04/2026).
 *  - Tầng 3: Fallback Nearest Centroid Haversine + bật `needsConfirmation: true`.
 */
export function resolveAdminUnit(input: {
  lat: number;
  lng: number;
  street?: string;
  rawAddressText?: string;
}): ReverseGeocodeResult {
  if (!inDongNaiBBox(input.lat, input.lng)) {
    return {
      inBounds: false,
      address: 'Vị trí ngoài địa giới Thành phố Đồng Nai',
      wardCode: null,
      wardName: null,
      source: 'out_of_bounds',
      needsConfirmation: true,
      matchedAlias: null,
      arterial: null,
    };
  }

  const arterial = matchArterial(input.lat, input.lng);
  const street = input.street?.trim() || '';

  if (input.rawAddressText && input.rawAddressText.trim()) {
    const aliasHit = matchWardByAddressText(input.rawAddressText);
    if (aliasHit) {
      const parts = [street, aliasHit.ward.name, 'Thành phố Đồng Nai'].filter(Boolean);
      return {
        inBounds: true,
        address: parts.join(', '),
        wardCode: aliasHit.ward.wardCode,
        wardName: aliasHit.ward.name,
        source: 'osm_alias',
        needsConfirmation: false,
        matchedAlias: aliasHit.matchedAlias,
        arterial,
      };
    }
    const near = nearestWard(input.lat, input.lng);
    const parts = [street, near.name, 'Thành phố Đồng Nai'].filter(Boolean);
    return {
      inBounds: true,
      address: parts.join(', '),
      wardCode: near.wardCode,
      wardName: near.name,
      source: 'osm_nearest',
      needsConfirmation: true,
      matchedAlias: null,
      arterial,
    };
  }

  const near = nearestWard(input.lat, input.lng);
  const parts = [street, near.name, 'Thành phố Đồng Nai'].filter(Boolean);
  return {
    inBounds: true,
    address: parts.join(', '),
    wardCode: near.wardCode,
    wardName: near.name,
    source: 'local_fallback',
    needsConfirmation: true,
    matchedAlias: null,
    arterial,
  };
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return '***';
  return `${digits.slice(0, 3)}****${digits.slice(-3)}`;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}***@${domain}`;
}

export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/[\s.\-()]/g, '');
  if (d.startsWith('+84')) d = `0${d.slice(3)}`;
  else if (d.startsWith('84') && d.length === 11) d = `0${d.slice(2)}`;
  return /^0\d{9}$/.test(d) ? d : null;
}

export function normalizeEmail(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s : null;
}
