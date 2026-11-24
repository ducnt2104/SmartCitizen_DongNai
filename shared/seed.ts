import { DEPARTMENT_BY_CATEGORY, PILOT_WARD_CODE } from './constants';
import { hammingDistance } from './dhash';
import { WARD_BY_CODE } from './dongNaiWards';
import { matchArterial, maskPhone } from './geo';
import { sceneDataUrl } from './sceneArt';
import type {
  AiAnalysis, Category, DispatchOrder, Photo, Rating, Report, ReportStatus, TimelineEvent,
} from './types';

/**
 * Bộ dữ liệu mẫu CHUẨN (deterministic) dùng chung cho MongoDB/JSON Seed và IndexedDB Local Seed.
 *  - 64 hồ sơ Phường Trấn Biên (T11/2026): 21 rác thải / 18 đèn đường / 15 ngập nước / 10 mặt đường
 *    47 đã hoàn thành (73.4%), 17 chưa hoàn thành, thời gian xử lý trung bình đúng 3.2 ngày.
 *  - 16 hồ sơ ở các xã/phường lân cận.
 * Toàn bộ ảnh là ảnh minh họa SVG, hash dHash là giá trị mẫu có kiểm soát khoảng cách Hamming.
 */

const DAY = 86400000;
const BASE_MS = Date.UTC(2026, 10, 1, 1, 0, 0); // 01/11/2026 08:00 (UTC+7)
const TB = PILOT_WARD_CODE;
const TB_LAT = 10.9465;
const TB_LNG = 106.8243;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

interface Ctx {
  rnd: () => number;
  counters: Record<string, number>;
  photoSeq: number;
}

function randHash(c: Ctx): string {
  let s = '';
  for (let i = 0; i < 16; i++) s += Math.floor(c.rnd() * 16).toString(16);
  return s;
}

/** Lật chính xác n bit để tạo hash có khoảng cách Hamming = n. */
function flipBits(hash: string, n: number, c: Ctx): string {
  const bits = Array.from({ length: 64 }, (_, i) => i);
  for (let i = bits.length - 1; i > 0; i--) {
    const j = Math.floor(c.rnd() * (i + 1));
    [bits[i], bits[j]] = [bits[j], bits[i]];
  }
  const nibbles = hash.split('').map((h) => parseInt(h, 16));
  for (const b of bits.slice(0, n)) nibbles[Math.floor(b / 4)] ^= 1 << (b % 4);
  return nibbles.map((v) => v.toString(16)).join('');
}

/** Sinh `count` hash mà mọi cặp đều có khoảng cách > minDist. */
function farHashes(count: number, minDist: number, c: Ctx): string[] {
  for (;;) {
    const hs = Array.from({ length: count }, () => randHash(c));
    let ok = true;
    for (let i = 0; i < count && ok; i++) {
      for (let j = i + 1; j < count; j++) if (hammingDistance(hs[i], hs[j]) <= minDist) ok = false;
    }
    if (ok) return hs;
  }
}

function photo(c: Ctx, category: Category, variant: number, kind: Photo['kind'], hash: string, by: string, at: number): Photo {
  c.photoSeq += 1;
  return {
    id: `ph_seed_${c.photoSeq}`,
    url: sceneDataUrl(category, variant, kind === 'after' ? 'after' : kind === 'angle' ? 'angle' : 'before'),
    dHash: hash,
    kind,
    takenBy: by,
    createdAt: iso(at),
  };
}

function nextCode(c: Ctx, wardCode: string): string {
  c.counters[wardCode] = (c.counters[wardCode] ?? 0) + 1;
  return `${wardCode}-2611-${String(c.counters[wardCode]).padStart(3, '0')}`;
}

function timeline(created: number, status: ReportStatus, resolvedAt: number | null): TimelineEvent[] {
  const ev: TimelineEvent[] = [{ stage: 'received', at: iso(created), note: 'Hệ thống tiếp nhận phản ánh' }];
  if (status === 'quarantined') {
    ev.push({ stage: 'quarantined', at: iso(created + 60000), note: 'Chuyển hàng đợi Cách ly để kiểm chứng' });
  } else if (status !== 'received') {
    ev.push({ stage: 'verifying', at: iso(created + 2 * 3600000), note: 'Đã xác minh thông tin hiện trường' });
    if (status !== 'verifying') ev.push({ stage: 'processing', at: iso(created + 5 * 3600000), note: 'Đã giao đơn vị chuyên môn xử lý' });
  }
  if (status === 'resolved' && resolvedAt) ev.push({ stage: 'resolved', at: iso(resolvedAt), note: 'Đã khắc phục và nghiệm thu' });
  return ev;
}

const STREETS = [
  'Nguyễn Ái Quốc', 'Cách Mạng Tháng Tám', 'Đồng Khởi', 'Võ Thị Sáu', 'Phạm Văn Thuận',
  'Hà Huy Giáp', 'Nguyễn Văn Trị', 'Phan Đình Phùng', 'Lê Quý Đôn', 'Trần Quốc Toản',
];

const TITLES: Record<Category, string[]> = {
  rac_thai: [
    'Rác thải tự phát chất đống đầu hẻm', 'Túi rác bị vứt dọc vỉa hè', 'Đống rác xây dựng bỏ lại cạnh lề đường',
    'Thùng rác công cộng đầy tràn', 'Rác sinh hoạt vứt bên bờ kênh', 'Rác chặn miệng cống thoát nước',
  ],
  den_duong: [
    'Đèn đường tắt nhiều đêm liền', 'Cột đèn nhấp nháy, chập chờn', 'Cả đoạn đường tối vì đèn hỏng',
    'Đèn chiếu sáng công viên không sáng', 'Cần đèn cao áp bị gãy nghiêng',
  ],
  ngap_nuoc: [
    'Ngập nước sau mưa lớn trước cổng chợ', 'Cống nghẹt gây ngập đường', 'Nước dâng cao tại điểm trũng',
    'Nước tràn vào nhà dân sau cơn mưa',
  ],
  mat_duong: [
    'Ổ gà sâu giữa làn xe máy', 'Mặt đường nứt, bong tróc', 'Nắp cống lún gây nguy hiểm', 'Đường lún sụt sau mưa',
  ],
};

const DESCS: Record<Category, string> = {
  rac_thai: 'Rác thải tập trung lâu ngày, bốc mùi, ảnh hưởng vệ sinh và mỹ quan khu dân cư.',
  den_duong: 'Hệ thống chiếu sáng không hoạt động, khu vực thiếu sáng vào buổi tối gây mất an toàn.',
  ngap_nuoc: 'Nước đọng không thoát kịp sau mưa, gây khó khăn đi lại và nguy cơ ngập sâu.',
  mat_duong: 'Mặt đường hư hỏng, xe cộ dễ té ngã nhất là vào ban đêm và khi trời mưa.',
};

const COMMENTS = [
  'Xử lý nhanh, cảm ơn đội ngũ.', 'Đường sạch sẽ trở lại, rất hài lòng.', 'Đã sáng đèn, bà con yên tâm đi lại.',
  'Khắc phục gọn gàng, đúng hẹn.', 'Cảm ơn Trấn Biên đã phản hồi kịp thời.',
];

interface Base {
  id: string;
  category: Category;
  title?: string;
  description?: string;
  lat: number;
  lng: number;
  wardCode: string;
  createdMs: number;
  status: ReportStatus;
  severity?: 1 | 2 | 3 | 4 | 5;
  photos: Photo[];
}

function build(c: Ctx, b: Base, over: Partial<Report> = {}): Report {
  const ward = WARD_BY_CODE[b.wardCode];
  const arterial = matchArterial(b.lat, b.lng);
  const street = arterial?.name ?? STREETS[Math.floor(c.rnd() * STREETS.length)];
  const num = 1 + Math.floor(c.rnd() * 180);
  const userIdx = Math.floor(c.rnd() * 9000) + 1000;
  const phone = `09${String(Math.floor(c.rnd() * 100000000)).padStart(8, '0')}`;
  const reporterId = `u_seed_${userIdx}`;
  const title = b.title ?? TITLES[b.category][Math.floor(c.rnd() * TITLES[b.category].length)];
  const ai: AiAnalysis = {
    authenticityScore: 72 + Math.floor(c.rnd() * 25),
    fraudFlags: [],
    confidence: Math.round((0.8 + c.rnd() * 0.17) * 100) / 100,
    safetyHazards: [],
    suggestedDepartment: DEPARTMENT_BY_CATEGORY[b.category],
    mode: 'seed',
  };
  const createdAt = iso(b.createdMs);
  const resolvedAtMs = b.status === 'resolved' ? (over.resolvedAt ? Date.parse(over.resolvedAt) : b.createdMs + 3 * DAY) : null;
  const confirmN = Math.floor(c.rnd() * 5);
  const sla = b.createdMs + 72 * 3600000;
  const base: Report = {
    id: b.id,
    code: nextCode(c, b.wardCode),
    category: b.category,
    title,
    description: b.description ?? DESCS[b.category],
    severity: b.severity ?? ((1 + Math.floor(c.rnd() * 3)) as 1 | 2 | 3),
    isEmergency: false,
    emergencyLevel: 0,
    priority: 'normal',
    status: b.status,
    wardCode: b.wardCode,
    address: `${num} ${street}, ${ward.name}, TP. Đồng Nai`,
    roadName: street,
    onArterial: arterial !== null,
    lat: b.lat,
    lng: b.lng,
    photos: b.photos,
    afterPhoto: null,
    clusterCount: 1,
    contributors: [{ userId: reporterId, phoneMasked: maskPhone(phone), at: createdAt }],
    confirmations: Array.from({ length: confirmN }, (_, i) => `u_seed_cf_${b.id}_${i}`),
    reporterId,
    reporterPhoneMasked: maskPhone(phone),
    isProxyReport: false,
    proxyVolunteerId: null,
    seniorSubmitted: false,
    needsFieldVerification: false,
    assignedVolunteerId: null,
    verification: null,
    ai,
    gpsMismatchWarning: false,
    gpsDistanceKm: null,
    quarantine: null,
    possibleDuplicateOf: null,
    department: b.status === 'received' || b.status === 'quarantined' ? null : DEPARTMENT_BY_CATEGORY[b.category],
    slaDueAt: iso(sla),
    dispatches: [],
    resolvedAt: resolvedAtMs ? iso(resolvedAtMs) : null,
    resolution: null,
    rating: null,
    timeline: [],
    source: 'seed',
    createdAt,
    updatedAt: iso(resolvedAtMs ?? b.createdMs + 3600000),
  };
  const merged = { ...base, ...over };
  merged.timeline = over.timeline ?? timeline(b.createdMs, b.status, resolvedAtMs);
  return merged;
}

function tbPoint(c: Ctx): [number, number] {
  return [TB_LAT + (c.rnd() - 0.5) * 0.016, TB_LNG + (c.rnd() - 0.5) * 0.016];
}

/** n thời lượng (phút) có trung bình đúng avgMin phút. */
function durationsMinutes(c: Ctx, n: number, avgMin: number): number[] {
  const raw = Array.from({ length: n }, () => 1500 + c.rnd() * 7500);
  const target = n * avgMin;
  const sum = raw.reduce((s, x) => s + x, 0);
  const scaled = raw.map((x) => Math.round((x * target) / sum));
  const diff = target - scaled.reduce((s, x) => s + x, 0);
  scaled[scaled.length - 1] += diff;
  return scaled;
}

export function buildSeedReports(): Report[] {
  const c: Ctx = { rnd: mulberry32(20261124), counters: {}, photoSeq: 0 };
  const out: Report[] = [];
  const rnd = c.rnd;

  const ba: Array<{ cat: Category; title: string; stars: Rating['stars']; score: number }> = [
    { cat: 'rac_thai', title: 'Rác thải tự phát chất đống đầu hẻm 24', stars: 5, score: 94 },
    { cat: 'den_duong', title: 'Cả đoạn đường Võ Thị Sáu tối vì đèn hỏng', stars: 5, score: 91 },
    { cat: 'ngap_nuoc', title: 'Cống nghẹt gây ngập trước cổng chợ Biên Hòa', stars: 5, score: 89 },
    { cat: 'mat_duong', title: 'Ổ gà sâu giữa làn xe máy đường Đồng Khởi', stars: 5, score: 96 },
  ];

  // 47 hồ sơ hoàn thành, trung bình đúng 4608 phút = 3.2 ngày
  const durations = durationsMinutes(c, 47, 4608);
  let dIdx = 0;

  // ── 4 hồ sơ hoàn thành có ảnh Trước – Sau ──────────────────────────────────
  ba.forEach((b, i) => {
    const [lat, lng] = tbPoint(c);
    const created = BASE_MS + (2 + i * 2) * DAY + Math.floor(rnd() * 3600000);
    const resolvedMs = created + durations[dIdx++] * 60000;
    const before = photo(c, b.cat, i + 3, 'before', randHash(c), 'seed', created);
    const after = photo(c, b.cat, i + 3, 'after', randHash(c), 'seed', resolvedMs);
    out.push(build(c, {
      id: `rp_tb_ba_${i + 1}`, category: b.cat, title: b.title, lat, lng, wardCode: TB, createdMs: created,
      status: 'resolved', photos: [before], severity: 3,
    }, {
      afterPhoto: after,
      resolvedAt: iso(resolvedMs),
      resolution: {
        resolutionVerified: true,
        matchConfidence: b.score,
        summary: 'Ảnh sau xử lý cùng bối cảnh với ảnh trước, sự cố đã được khắc phục hoàn toàn (dữ liệu mẫu).',
        mode: 'seed',
        at: iso(resolvedMs + 600000),
      },
      rating: { stars: b.stars, comment: COMMENTS[i % COMMENTS.length], at: iso(resolvedMs + 7200000) },
    }));
  });

  // ── 01 Vụ KHẨN CẤP Cấp độ 1 trên trục huyết mạch Nguyễn Ái Quốc / QL1A ─────────
  {
    const created = Date.UTC(2026, 10, 24, 0, 40, 0);
    const adj = WARD_BY_CODE[TB].adjacentWardCodes.slice(0, 2);
    const dispatch: DispatchOrder = {
      id: 'dp_seed_1',
      fromWardCode: TB,
      toWardCodes: adj,
      units: ['dien_luc', 'csgt'],
      issuedAt: iso(created + 90000),
      issuedBy: 'system',
      auto: true,
      note: 'Tự động: sự cố khẩn cấp trên trục huyết mạch — chi viện liên phường, Điện lực và CSGT.',
    };
    out.push(build(c, {
      id: 'rp_tb_em', category: 'den_duong', title: 'Cây đổ đè dây điện võng thấp trên đường Nguyễn Ái Quốc',
      description: 'Cây lớn bật gốc đổ ngang lòng đường, dây điện trung thế võng sát mặt đường, có tia lửa. Xe cộ đang phải né lên vỉa hè.',
      lat: 10.9461, lng: 106.8252, wardCode: TB, createdMs: created, status: 'processing', severity: 5,
      photos: [photo(c, 'den_duong', 1, 'before', randHash(c), 'seed', created)],
    }, {
      isEmergency: true, emergencyLevel: 1, priority: 'emergency', department: 'dien_luc',
      slaDueAt: iso(created + 2 * 3600000), roadName: 'Nguyễn Ái Quốc', onArterial: true,
      address: 'Ngã tư Nguyễn Ái Quốc – Quốc lộ 1A, Phường Trấn Biên, TP. Đồng Nai',
      dispatches: [dispatch],
      confirmations: Array.from({ length: 9 }, (_, i) => `u_seed_cf_em_${i}`),
      ai: {
        authenticityScore: 96, fraudFlags: [], confidence: 0.97,
        safetyHazards: ['Dây điện trần võng thấp', 'Cây đổ chắn lòng đường', 'Nguy cơ giật điện / chập cháy'],
        suggestedDepartment: 'dien_luc', mode: 'seed',
      },
      timeline: [
        { stage: 'received', at: iso(created), note: 'Hệ thống tiếp nhận phản ánh' },
        { stage: 'escalated', at: iso(created + 60000), note: 'AI gắn KHẨN CẤP CẤP ĐỘ 1 — trục huyết mạch Nguyễn Ái Quốc / QL1A' },
        { stage: 'dispatched', at: iso(created + 90000), note: `Phát lệnh chi viện sang ${adj.join(', ')} + Điện lực + CSGT` },
        { stage: 'processing', at: iso(created + 20 * 60000), note: 'Điện lực đã cắt điện cục bộ, đội xử lý đang đến' },
      ],
    }));
  }

  // ── 01 Hồ sơ Mẹ gom từ 4 phản ánh thật (4 SĐT, 4 góc, ≤50m) ────────────────────
  {
    const created = Date.UTC(2026, 10, 23, 1, 15, 0);
    const hs = farHashes(4, 12, c);
    const mLat = 10.9498;
    const mLng = 106.8209;
    const users = [1, 2, 3, 4].map((i) => {
      const ph = `09${String(10000000 + i * 1357911).slice(0, 8)}`;
      return { userId: `u_seed_m${i}`, phoneMasked: maskPhone(ph), at: iso(created + i * 11 * 60000) };
    });
    out.push(build(c, {
      id: 'rp_tb_mother', category: 'ngap_nuoc', title: 'Ngập nước kéo dài tại điểm trũng đường Cách Mạng Tháng Tám',
      description: 'Bốn người dân ở bốn góc chụp khác nhau cùng báo một điểm ngập sâu sau mưa, nước chưa rút sau nhiều giờ.',
      lat: mLat, lng: mLng, wardCode: TB, createdMs: created, status: 'processing', severity: 4,
      photos: hs.map((h, i) => photo(c, 'ngap_nuoc', i + 1, i === 0 ? 'before' : 'angle', h, users[i].userId, created + i * 11 * 60000)),
    }, {
      clusterCount: 4, contributors: users, priority: 'high', reporterId: users[0].userId,
      reporterPhoneMasked: users[0].phoneMasked, confirmations: ['u_seed_cf_mother_1', 'u_seed_cf_mother_2', 'u_seed_cf_mother_3'],
      roadName: 'Cách Mạng Tháng Tám', address: '56 Cách Mạng Tháng Tám, Phường Trấn Biên, TP. Đồng Nai',
      ai: { authenticityScore: 93, fraudFlags: [], confidence: 0.95, safetyHazards: ['Nước ngập sâu, khó quan sát hố ga'], suggestedDepartment: 'ubnd_khu_pho', mode: 'seed' },
      timeline: [
        { stage: 'received', at: iso(created), note: 'Phản ánh đầu tiên được tiếp nhận' },
        { stage: 'escalated', at: iso(created + 33 * 60000), note: 'AI gom 4 phản ánh (4 SĐT, 4 góc ảnh, ≤50m) thành Hồ sơ Mẹ — nâng Ưu tiên Cao' },
        { stage: 'processing', at: iso(created + 3 * 3600000), note: 'Giao UBND Khu phố xử lý' },
      ],
    }));
  }

  // ── 03 đơn Cách ly ───────────────────────────────────────────────────────────
  // (a) trùng y chang ảnh: dHash distance ≤ 5 so với 1 hồ sơ rác thải khác
  const dupSourceHash = out.find((r) => r.id === 'rp_tb_ba_1')!.photos[0].dHash;
  {
    const created = Date.UTC(2026, 10, 22, 3, 20, 0);
    const [lat, lng] = tbPoint(c);
    out.push(build(c, {
      id: 'rp_tb_q_dup', category: 'rac_thai', title: 'Rác thải tự phát chất đống đầu hẻm 24 (gửi lặp)', lat, lng, wardCode: TB,
      createdMs: created, status: 'quarantined', photos: [photo(c, 'rac_thai', 3, 'before', flipBits(dupSourceHash, 3, c), 'seed', created)],
    }, {
      quarantine: { reason: 'duplicate_image', detail: 'Ảnh trùng khớp (dHash distance = 3 ≤ 5) với hồ sơ đã gửi trong 24 giờ.', at: iso(created + 30000), relatedReportId: 'rp_tb_ba_1' },
      possibleDuplicateOf: 'rp_tb_ba_1',
    }));
  }
  // (b) ảnh chụp lại màn hình
  {
    const created = Date.UTC(2026, 10, 22, 11, 5, 0);
    const [lat, lng] = tbPoint(c);
    out.push(build(c, {
      id: 'rp_tb_q_screen', category: 'den_duong', title: 'Đèn đường hỏng (ảnh chụp từ màn hình)', lat, lng, wardCode: TB,
      createdMs: created, status: 'quarantined', photos: [photo(c, 'den_duong', 2, 'before', randHash(c), 'seed', created)],
    }, {
      ai: { authenticityScore: 18, fraudFlags: ['screen_recapture', 'moire_pattern', 'unrelated_scene'], confidence: 0.91, safetyHazards: [], suggestedDepartment: 'dien_chieu_sang', mode: 'seed' },
      quarantine: { reason: 'low_authenticity', detail: 'AI nhận diện ảnh chụp lại màn hình máy tính (authenticityScore = 18 < 45).', at: iso(created + 30000), relatedReportId: null },
    }));
  }
  // (c) lệch GPS bất thường > 5km
  {
    const created = Date.UTC(2026, 10, 23, 8, 40, 0);
    const [lat, lng] = tbPoint(c);
    out.push(build(c, {
      id: 'rp_tb_q_gps', category: 'mat_duong', title: 'Ổ gà lớn (vị trí ghim lệch xa vị trí thiết bị)', lat, lng, wardCode: TB,
      createdMs: created, status: 'quarantined', photos: [photo(c, 'mat_duong', 4, 'before', randHash(c), 'seed', created)],
    }, {
      gpsMismatchWarning: true, gpsDistanceKm: 7.4,
      quarantine: { reason: 'gps_anomaly', detail: 'GPS thiết bị lệch 7.4 km so với vị trí ghim (> 5 km) mà không chọn chế độ "đã rời hiện trường".', at: iso(created + 30000), relatedReportId: null },
    }));
  }

  // ── 03 nhiệm vụ Xác minh Thực địa (Người cao tuổi gửi) ─────────────────────────
  const vt: Array<[Category, string, boolean]> = [
    ['rac_thai', 'Cô Lan (72 tuổi) báo: rác đổ ngay cổng hẻm 112 mấy ngày chưa ai dọn', false],
    ['mat_duong', 'Chú Sáu (68 tuổi) báo: ổ gà trước trạm y tế phường, xe lăn khó đi', true],
    ['den_duong', 'Bác Hai (75 tuổi) báo: đèn đường hẻm 38 tắt, tối không dám ra đường', false],
  ];
  vt.forEach(([cat, title, proxy], i) => {
    const created = Date.UTC(2026, 10, 23, 2 + i, 10, 0);
    const [lat, lng] = tbPoint(c);
    out.push(build(c, {
      id: `rp_tb_vt_${i + 1}`, category: cat, title, lat, lng, wardCode: TB, createdMs: created, status: 'verifying', severity: 3,
      photos: [photo(c, cat, i + 5, 'before', randHash(c), 'seed', created)],
    }, {
      seniorSubmitted: true, needsFieldVerification: true, isProxyReport: proxy, proxyVolunteerId: proxy ? 'u_seed_vol1' : null,
      priority: 'high',
    }));
  });

  // ── Fillers: 52 hồ sơ còn lại (18 rác, 14 đèn, 13 ngập, 7 mặt đường) ──────────
  const fillCats: Category[] = [
    ...Array<Category>(18).fill('rac_thai'), ...Array<Category>(14).fill('den_duong'),
    ...Array<Category>(13).fill('ngap_nuoc'), ...Array<Category>(7).fill('mat_duong'),
  ];
  // Chọn ngẫu nhiên có kiểm soát 9 đơn chưa hoàn thành (4 received + 5 processing)
  const order = fillCats.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const openIdx = new Map<number, ReportStatus>();
  order.slice(0, 9).forEach((idx, k) => openIdx.set(idx, k < 4 ? 'received' : 'processing'));

  fillCats.forEach((cat, i) => {
    const [lat, lng] = tbPoint(c);
    const status = openIdx.get(i) ?? 'resolved';
    let created: number;
    let over: Partial<Report> = {};
    if (status === 'resolved') {
      created = BASE_MS + Math.floor(rnd() * 15 * DAY);
      const resolvedMs = created + durations[dIdx++] * 60000;
      const stars = (rnd() < 0.6 ? 5 : 4) as Rating['stars'];
      over = {
        resolvedAt: iso(resolvedMs),
        rating: rnd() < 0.5 ? { stars, comment: COMMENTS[Math.floor(rnd() * COMMENTS.length)], at: iso(resolvedMs + 3 * 3600000) } : null,
      };
    } else {
      created = Date.UTC(2026, 10, 18 + Math.floor(rnd() * 6), 1 + Math.floor(rnd() * 8), Math.floor(rnd() * 60), 0);
    }
    out.push(build(c, {
      id: `rp_tb_${String(i + 1).padStart(3, '0')}`, category: cat, lat, lng, wardCode: TB, createdMs: created, status,
      photos: [photo(c, cat, i + 1, 'before', randHash(c), 'seed', created)],
    }, over));
  });

  // ── 16 hồ sơ mở rộng tại các xã, phường lân cận ───────────────────────────────
  const ext: Array<[string, Category, ReportStatus]> = [
    ['DN-BH', 'rac_thai', 'resolved'], ['DN-TTR', 'den_duong', 'processing'], ['DN-LKH', 'mat_duong', 'received'],
    ['DN-TBO', 'ngap_nuoc', 'resolved'], ['DN-LTH', 'mat_duong', 'processing'], ['DN-TLA', 'rac_thai', 'received'],
    ['DN-NTR', 'ngap_nuoc', 'verifying'], ['DN-HNI', 'den_duong', 'resolved'], ['DN-TDA', 'rac_thai', 'processing'],
    ['DN-DQU', 'mat_duong', 'resolved'], ['DN-CMY', 'ngap_nuoc', 'received'], ['DN-TPC', 'rac_thai', 'resolved'],
    ['DN-DGI', 'mat_duong', 'processing'], ['DN-AHO', 'den_duong', 'resolved'], ['DN-XLA', 'rac_thai', 'received'],
    ['DN-LBI', 'ngap_nuoc', 'resolved'],
  ];
  ext.forEach(([wc, cat, status], i) => {
    const w = WARD_BY_CODE[wc];
    const lat = w.centerLat + (rnd() - 0.5) * 0.008;
    const lng = w.centerLng + (rnd() - 0.5) * 0.008;
    const created = BASE_MS + (6 + Math.floor(rnd() * 14)) * DAY;
    const resolvedMs = status === 'resolved' ? created + (2 + Math.floor(rnd() * 5)) * DAY : null;
    out.push(build(c, {
      id: `rp_ext_${String(i + 1).padStart(2, '0')}`, category: cat, lat, lng, wardCode: wc, createdMs: created, status,
      photos: [photo(c, cat, i + 20, 'before', randHash(c), 'seed', created)],
    }, resolvedMs ? { resolvedAt: iso(resolvedMs) } : {}));
  });

  return out;
}
