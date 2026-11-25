import { DEPARTMENT_BY_CATEGORY } from './constants';
import { hammingDistance } from './dhash';
import { WARD_BY_CODE } from './dongNaiWards';
import { matchArterial, maskPhone } from './geo';
import { sceneDataUrl } from './sceneArt';
import type {
  AiAnalysis, Category, DispatchOrder, Photo, Rating, Report, ReportStatus, TimelineEvent,
} from './types';

/**
 * Bộ dữ liệu mẫu CHUẨN (deterministic) phủ đều toàn bộ Thành phố Đồng Nai (cả 5 vùng — 95 Phường/Xã):
 *  - Đô thị Trung tâm (Trấn Biên, Biên Hòa, Tam Hiệp, Trảng Dài, Long Bình, Hố Nai, Long Hưng, Phước Tân, Tam Phước, Tân Triều)
 *  - Nam — Sân bay & Cảng (Long Thành, Nhơn Trạch, Đại Phước, Phước An, Phước Thái, Long Phước, Bình An, An Phước)
 *  - Đông — Long Khánh, Trảng Bom, Xuân Lộc (Trảng Bom, Dầu Giây, Long Khánh, Xuân Lộc, Cẩm Mỹ, Bình Lộc, Gia Kiệm)
 *  - Đông Bắc — Cát Tiên, Trị An, Tân Phú (Trị An, Tân Phú, Tà Lài, Đak Lua, Định Quán, Phú Lý, Nam Cát Tiên)
 *  - Bắc Đồng Nai — Đồng Xoài, Bình Phước, Lộc Ninh, Bù Gia Mập (Bình Phước, Đồng Xoài, Đồng Phú, Chơn Thành, Tân Khai, Bình Long, Lộc Ninh, Phước Long, Bù Đăng, Bù Gia Mập, Đăk Ơ)
 * Tổng 80 hồ sơ đa dạng trạng thái, giữ đủ các kịch bản thực tế (Khẩn cấp cấp 1, Hồ sơ Mẹ đa góc,
 * Cách ly Spam/Ảnh giả/GPS lệch, Before/After nghiệm thu AI, Nhiệm vụ xác minh thực địa).
 */

const DAY = 86400000;
const BASE_MS = Date.UTC(2026, 10, 1, 1, 0, 0); // 01/11/2026 08:00 (UTC+7)

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

const TITLES: Record<Category, string[]> = {
  rac_thai: [
    'Rác thải tự phát chất đống ven đường',
    'Túi rác sinh hoạt ứ đọng trước cổng chợ',
    'Xà bần xây dựng đổ trái phép cạnh lề đường',
    'Thùng rác công cộng quá tải gây mùi hôi',
    'Rác nhựa chặn miệng cống thoát nước',
  ],
  den_duong: [
    'Đèn chiếu sáng công cộng tắt nhiều đêm liền',
    'Cột đèn đường nhấp nháy, chập chờn giờ cao điểm',
    'Đoạn đường dân sinh tối hoàn toàn vì hỏng đèn',
    'Cần đèn cao áp bị gãy nghiêng sau gió lớn',
    'Tủ điện chiếu sáng mở nắp mất an toàn',
  ],
  ngap_nuoc: [
    'Ngập nước sâu sau mưa lớn cản trở lưu thông',
    'Cống thoát nước bị nghẹt gây ứ đọng mặt đường',
    'Nước tràn vào khu dân cư khi mưa kéo dài',
    'Mặt đường trũng đọng nước dài ngày sau mưa',
  ],
  mat_duong: [
    'Ổ gà lớn trên làn xe máy dễ gây té ngã',
    'Mặt đường bong tróc, sụt lún sau xe tải nặng',
    'Nắp hố ga bị sập nứt sát vỉa hè',
    'Sạt lở lề đường sau mưa cần gia cố khẩn',
  ],
};

const DESCS: Record<Category, string> = {
  rac_thai: 'Rác thải tập trung nhiều ngày gây mất vệ sinh môi trường và cản trở lối đi của người dân.',
  den_duong: 'Hệ thống chiếu sáng không hoạt động ổn định vào ban đêm, tiềm ẩn nguy cơ mất an toàn giao thông.',
  ngap_nuoc: 'Nước thoát chậm gây ngập kéo dài sau mỗi trận mưa, ảnh hưởng sinh hoạt và việc đi lại.',
  mat_duong: 'Kết cấu mặt đường hư hỏng nghiêm trọng, xe hai bánh đi qua buổi tối rất nguy hiểm.',
};

function makeReport(
  c: Ctx,
  p: {
    id: string;
    wardCode: string;
    category: Category;
    title: string;
    description: string;
    lat: number;
    lng: number;
    address: string;
    status: ReportStatus;
    createdMs: number;
    resolvedMs?: number | null;
    severity?: 1 | 2 | 3 | 4 | 5;
    priority?: Report['priority'];
    isEmergency?: boolean;
    emergencyLevel?: 0 | 1;
    photos?: Photo[];
    afterPhoto?: Photo | null;
    clusterCount?: number;
    contributors?: Report['contributors'];
    confirmations?: string[];
    seniorSubmitted?: boolean;
    needsFieldVerification?: boolean;
    ai?: Partial<AiAnalysis>;
    gpsMismatchWarning?: boolean;
    gpsDistanceKm?: number | null;
    quarantine?: Report['quarantine'];
    dispatches?: DispatchOrder[];
    resolution?: Report['resolution'];
    rating?: Rating | null;
    extraTimeline?: TimelineEvent[];
  },
): Report {
  const art = matchArterial(p.lat, p.lng);
  const dept = DEPARTMENT_BY_CATEGORY[p.category];
  const hash = randHash(c);
  const reporterId = p.contributors?.[0]?.userId ?? `u_seed_${p.id}`;
  const phoneMasked = p.contributors?.[0]?.phoneMasked ?? maskPhone(`090${String(1000000 + Math.floor(c.rnd() * 8999999)).slice(0, 7)}`);
  const photos = p.photos ?? [photo(c, p.category, Math.floor(c.rnd() * 10), 'before', hash, reporterId, p.createdMs)];
  const priority = p.priority ?? (p.emergencyLevel === 1 ? 'emergency' : 'normal');
  const slaHours = priority === 'emergency' ? 2 : priority === 'high' ? 24 : 72;
  const tl = [...timeline(p.createdMs, p.status, p.resolvedMs ?? null), ...(p.extraTimeline ?? [])];
  const updatedMs = p.resolvedMs ?? p.createdMs + 3600000;

  return {
    id: p.id,
    code: nextCode(c, p.wardCode),
    category: p.category,
    title: p.title,
    description: p.description,
    severity: p.severity ?? (priority === 'emergency' ? 5 : priority === 'high' ? 4 : 3),
    isEmergency: p.isEmergency ?? priority === 'emergency',
    emergencyLevel: p.emergencyLevel ?? 0,
    priority,
    status: p.status,
    wardCode: p.wardCode,
    address: p.address,
    roadName: art?.name ?? null,
    onArterial: art !== null,
    lat: p.lat,
    lng: p.lng,
    photos,
    afterPhoto: p.afterPhoto ?? null,
    clusterCount: p.clusterCount ?? 1,
    contributors: p.contributors ?? [{ userId: reporterId, phoneMasked, at: iso(p.createdMs) }],
    confirmations: p.confirmations ?? [],
    reporterId,
    reporterPhoneMasked: phoneMasked,
    isProxyReport: false,
    proxyVolunteerId: null,
    seniorSubmitted: p.seniorSubmitted ?? false,
    needsFieldVerification: p.needsFieldVerification ?? false,
    assignedVolunteerId: null,
    verification: null,
    ai: {
      authenticityScore: p.ai?.authenticityScore ?? 90,
      fraudFlags: p.ai?.fraudFlags ?? [],
      confidence: p.ai?.confidence ?? 0.91,
      safetyHazards: p.ai?.safetyHazards ?? [],
      suggestedDepartment: p.ai?.suggestedDepartment ?? dept,
      mode: 'seed',
    },
    gpsMismatchWarning: p.gpsMismatchWarning ?? false,
    gpsDistanceKm: p.gpsDistanceKm ?? null,
    quarantine: p.quarantine ?? null,
    possibleDuplicateOf: null,
    department: p.status === 'received' || p.status === 'quarantined' ? null : dept,
    slaDueAt: p.status === 'resolved' || p.status === 'quarantined' ? null : iso(p.createdMs + slaHours * 3600000),
    dispatches: p.dispatches ?? [],
    resolvedAt: p.resolvedMs ? iso(p.resolvedMs) : null,
    resolution: p.resolution ?? null,
    rating: p.rating ?? null,
    timeline: tl,
    source: 'seed',
    createdAt: iso(p.createdMs),
    updatedAt: iso(updatedMs),
  };
}

/** Danh sách 64 hồ sơ phân bổ đều khắp 5 vùng của Thành phố Đồng Nai (33 Phường, 62 Xã). */
const CITYWIDE_DISTRIBUTION: ReadonlyArray<readonly [wardCode: string, category: Category, status: ReportStatus]> = [
  // Đô thị Trung tâm
  ['DN-TB', 'rac_thai', 'resolved'], ['DN-TB', 'den_duong', 'processing'], ['DN-TB', 'ngap_nuoc', 'resolved'],
  ['DN-BH', 'mat_duong', 'processing'], ['DN-BH', 'rac_thai', 'resolved'], ['DN-BH', 'den_duong', 'resolved'],
  ['DN-TDA', 'ngap_nuoc', 'processing'], ['DN-TDA', 'rac_thai', 'resolved'],
  ['DN-THP', 'den_duong', 'resolved'], ['DN-THP', 'mat_duong', 'received'],
  ['DN-LBI', 'rac_thai', 'processing'], ['DN-LBI', 'ngap_nuoc', 'resolved'],
  ['DN-HNI', 'den_duong', 'resolved'], ['DN-LHU', 'ngap_nuoc', 'received'],
  ['DN-PTA', 'mat_duong', 'resolved'], ['DN-TPC', 'rac_thai', 'resolved'],
  ['DN-TTR', 'den_duong', 'processing'],

  // Nam — Sân bay & Cảng (Long Thành, Nhơn Trạch lên phường 30/04/2026)
  ['DN-LTH', 'mat_duong', 'processing'], ['DN-LTH', 'den_duong', 'resolved'], ['DN-LTH', 'rac_thai', 'resolved'],
  ['DN-NTR', 'ngap_nuoc', 'processing'], ['DN-NTR', 'mat_duong', 'resolved'], ['DN-NTR', 'den_duong', 'received'],
  ['DN-DPH', 'rac_thai', 'resolved'], ['DN-PAN', 'mat_duong', 'processing'],
  ['DN-PTH', 'ngap_nuoc', 'resolved'], ['DN-LPH', 'den_duong', 'resolved'],
  ['DN-BAN', 'rac_thai', 'received'], ['DN-APH', 'mat_duong', 'resolved'],

  // Đông — Trảng Bom, Dầu Giây, Long Khánh, Xuân Lộc, Cẩm Mỹ
  ['DN-TBO', 'ngap_nuoc', 'resolved'], ['DN-TBO', 'rac_thai', 'processing'],
  ['DN-DGI', 'mat_duong', 'resolved'], ['DN-DGI', 'den_duong', 'processing'],
  ['DN-LKH', 'rac_thai', 'resolved'], ['DN-LKH', 'den_duong', 'resolved'],
  ['DN-BLC', 'mat_duong', 'received'], ['DN-BVI', 'rac_thai', 'resolved'],
  ['DN-XLO', 'den_duong', 'processing'], ['DN-XLO', 'ngap_nuoc', 'resolved'],
  ['DN-CMY', 'mat_duong', 'resolved'], ['DN-GKI', 'rac_thai', 'resolved'],
  ['DN-TNH', 'ngap_nuoc', 'received'],

  // Đông Bắc — Cát Tiên, Trị An, Định Quán, Tân Phú, Tà Lài, Đak Lua
  ['DN-TRA', 'den_duong', 'resolved'], ['DN-TRA', 'rac_thai', 'processing'],
  ['DN-TPU', 'mat_duong', 'resolved'], ['DN-TPU', 'ngap_nuoc', 'processing'],
  ['DN-TLA', 'mat_duong', 'processing'], ['DN-TLA', 'rac_thai', 'resolved'],
  ['DN-DQU', 'den_duong', 'resolved'], ['DN-DLU', 'mat_duong', 'received'],
  ['DN-PLY', 'den_duong', 'resolved'], ['DN-NCT', 'rac_thai', 'resolved'],

  // Bắc Đồng Nai — Bình Phước, Đồng Xoài, Đồng Phú, Chơn Thành, Tân Khai, Bình Long, Lộc Ninh, Phước Long, Bù Đăng, Bù Gia Mập, Đăk Ơ
  ['DN-BP', 'ngap_nuoc', 'processing'], ['DN-BP', 'rac_thai', 'resolved'],
  ['DN-DX', 'den_duong', 'resolved'], ['DN-DX', 'mat_duong', 'processing'],
  ['DN-DPU', 'rac_thai', 'resolved'], ['DN-CTH', 'mat_duong', 'processing'],
  ['DN-TKH', 'den_duong', 'resolved'], ['DN-BLO', 'ngap_nuoc', 'resolved'],
  ['DN-LNI', 'mat_duong', 'processing'], ['DN-PLO', 'den_duong', 'resolved'],
  ['DN-BDA', 'ngap_nuoc', 'received'], ['DN-BGM', 'mat_duong', 'resolved'],
];

export function buildSeedReports(): Report[] {
  const c: Ctx = { rnd: mulberry32(20261130), counters: {}, photoSeq: 0 };
  const list: Report[] = [];

  // 1. 02 Vụ Khẩn cấp Cấp độ 1 trên trục huyết mạch (Trung tâm + Bắc Đồng Nai)
  const em1Ms = BASE_MS + 20 * DAY;
  const wTB = WARD_BY_CODE['DN-TB'];
  list.push(
    makeReport(c, {
      id: 'rp_tb_em',
      wardCode: 'DN-TB',
      category: 'den_duong',
      title: 'Cây xanh đổ kéo võng dây điện trên trục Nguyễn Ái Quốc – QL1A',
      description: 'Cây xanh bật gốc sau mưa giông đè lên dây điện chiếu sáng võng sát mặt đường, có tia lửa điện.',
      lat: 10.95605,
      lng: 106.82350,
      address: 'Đường Nguyễn Ái Quốc, Phường Trấn Biên, Thành phố Đồng Nai',
      status: 'processing',
      createdMs: em1Ms,
      severity: 5,
      priority: 'emergency',
      isEmergency: true,
      emergencyLevel: 1,
      ai: { authenticityScore: 96, safetyHazards: ['Dây điện võng thấp', 'Cây đổ chắn trục huyết mạch'], suggestedDepartment: 'dien_luc' },
      dispatches: [{
        id: 'dp_seed_em1',
        fromWardCode: 'DN-TB',
        toWardCodes: wTB.adjacentWardCodes.slice(0, 2),
        units: ['dien_luc', 'csgt'],
        issuedAt: iso(em1Ms + 60000),
        issuedBy: 'system',
        auto: true,
        note: 'Tự động: khẩn cấp cấp 1 trên trục huyết mạch Nguyễn Ái Quốc — chi viện liên phường.',
      }],
      extraTimeline: [{ stage: 'dispatched', at: iso(em1Ms + 60000), note: `Phát lệnh chi viện sang ${wTB.adjacentWardCodes.slice(0, 2).join(', ')} + Điện lực + CSGT` }],
    }),
  );

  const em2Ms = BASE_MS + 21 * DAY;
  const wBP = WARD_BY_CODE['DN-BP'];
  list.push(
    makeReport(c, {
      id: 'rp_bp_em',
      wardCode: 'DN-BP',
      category: 'mat_duong',
      title: 'Sụt lún hố sâu giữa làn xe Quốc lộ 14 qua Phường Bình Phước',
      description: 'Đoạn mặt đường gần ngã tư Đồng Xoài xuất hiện hố sụt rộng hơn 1.5m sau mưa lớn, ùn ứ nghiêm trọng.',
      lat: 11.5350,
      lng: 106.8832,
      address: 'Quốc lộ 14, Phường Bình Phước, Thành phố Đồng Nai',
      status: 'processing',
      createdMs: em2Ms,
      severity: 5,
      priority: 'emergency',
      isEmergency: true,
      emergencyLevel: 1,
      ai: { authenticityScore: 95, safetyHazards: ['Hố sụt sâu trên Quốc lộ 14', 'Nguy cơ lật xe tải'], suggestedDepartment: 'giao_thong' },
      dispatches: [{
        id: 'dp_seed_em2',
        fromWardCode: 'DN-BP',
        toWardCodes: wBP.adjacentWardCodes.slice(0, 2),
        units: ['giao_thong', 'csgt'],
        issuedAt: iso(em2Ms + 60000),
        issuedBy: 'system',
        auto: true,
        note: 'Tự động: khẩn cấp cấp 1 trên Quốc lộ 14 — chi viện liên phường Bắc Đồng Nai.',
      }],
    }),
  );

  // 2. 02 Hồ sơ Mẹ gom đa góc chụp thật (dHash > 12, khác SĐT, <= 50m)
  const motherMs = BASE_MS + 18 * DAY;
  const mHashes = farHashes(4, 18, c);
  const mPhones = ['0901000101', '0901000102', '0901000103', '0901000104'];
  list.push(
    makeReport(c, {
      id: 'rp_tb_mother',
      wardCode: 'DN-TB',
      category: 'ngap_nuoc',
      title: 'Ngập sâu kéo dài trước chợ Biên Hòa — 4 người dân chụp 4 góc',
      description: 'Miệng cống nghẹt hoàn toàn gây ngập quá nửa bánh xe, 4 người dân đã gửi ảnh nhiều góc độ khác nhau.',
      lat: 10.9522,
      lng: 106.8186,
      address: 'Khu vực chợ Biên Hòa, Phường Trấn Biên, Thành phố Đồng Nai',
      status: 'processing',
      createdMs: motherMs,
      severity: 4,
      priority: 'high',
      clusterCount: 4,
      photos: mHashes.map((h, i) => photo(c, 'ngap_nuoc', i, i === 0 ? 'before' : 'angle', h, `u_seed_m_${i}`, motherMs + i * 300000)),
      contributors: mPhones.map((ph, i) => ({ userId: `u_seed_m_${i}`, phoneMasked: maskPhone(ph), at: iso(motherMs + i * 300000) })),
      confirmations: ['u_seed_c1', 'u_seed_c2', 'u_seed_c3'],
      extraTimeline: [{ stage: 'escalated', at: iso(motherMs + 900000), note: 'AI gom 4 phản ánh đa góc chụp (dHash > 12) trong bán kính 50m — nâng Ưu tiên Cao' }],
    }),
  );

  const lthMotherMs = BASE_MS + 19 * DAY;
  const lthHashes = farHashes(3, 18, c);
  list.push(
    makeReport(c, {
      id: 'rp_lth_mother',
      wardCode: 'DN-LTH',
      category: 'rac_thai',
      title: 'Bãi rác tự phát gần cửa ngõ Sân bay Long Thành — 3 góc ảnh',
      description: 'Rác thải công trình và sinh hoạt tập kết trái phép cạnh tuyến đường vào Phường Long Thành.',
      lat: 10.7795,
      lng: 106.9578,
      address: 'Quốc lộ 51, Phường Long Thành, Thành phố Đồng Nai',
      status: 'processing',
      createdMs: lthMotherMs,
      severity: 4,
      priority: 'high',
      clusterCount: 3,
      photos: lthHashes.map((h, i) => photo(c, 'rac_thai', i + 2, i === 0 ? 'before' : 'angle', h, `u_seed_lm_${i}`, lthMotherMs + i * 300000)),
      contributors: ['0902000201', '0902000202', '0902000203'].map((ph, i) => ({ userId: `u_seed_lm_${i}`, phoneMasked: maskPhone(ph), at: iso(lthMotherMs + i * 300000) })),
      confirmations: ['u_seed_c4', 'u_seed_c5'],
    }),
  );

  // 3. 03 Đơn trong Hàng đợi Cách ly (trùng dHash <= 5, ảnh màn hình, GPS lệch > 5km)
  const dupHash = flipBits(mHashes[0], 2, c);
  list.push(
    makeReport(c, {
      id: 'rp_tb_q_dup',
      wardCode: 'DN-TB',
      category: 'ngap_nuoc',
      title: 'Gửi lặp ảnh ngập chợ Biên Hòa (Cách ly trùng ảnh)',
      description: 'Đơn chứa ảnh trùng lặp dHash với Hồ sơ Mẹ trong vòng 24 giờ.',
      lat: 10.9524,
      lng: 106.8188,
      address: 'Phường Trấn Biên, Thành phố Đồng Nai',
      status: 'quarantined',
      createdMs: motherMs + 1200000,
      photos: [photo(c, 'ngap_nuoc', 0, 'before', dupHash, 'u_seed_dup', motherMs + 1200000)],
      quarantine: { reason: 'duplicate_image', detail: 'Ảnh trùng khớp (dHash distance = 2 ≤ 5) với hồ sơ đã gửi trong 24 giờ.', at: iso(motherMs + 1200000), relatedReportId: 'rp_tb_mother' },
    }),
  );

  list.push(
    makeReport(c, {
      id: 'rp_tb_q_screen',
      wardCode: 'DN-NTR',
      category: 'rac_thai',
      title: 'Nghi ảnh chụp lại màn hình máy tính (Phường Nhơn Trạch)',
      description: 'AI phát hiện viền màn hình và vân moiré — cần tình nguyện viên kiểm chứng thực địa.',
      lat: 10.7335,
      lng: 106.9075,
      address: 'Đường Lý Thái Tổ, Phường Nhơn Trạch, Thành phố Đồng Nai',
      status: 'quarantined',
      createdMs: BASE_MS + 19 * DAY,
      needsFieldVerification: true,
      ai: { authenticityScore: 28, fraudFlags: ['screen_recapture', 'moire_pattern'] },
      quarantine: { reason: 'low_authenticity', detail: 'AI nghi ảnh không phải hiện trường thật (authenticityScore = 28 < 45).', at: iso(BASE_MS + 19 * DAY), relatedReportId: null },
    }),
  );

  list.push(
    makeReport(c, {
      id: 'rp_tb_q_gps',
      wardCode: 'DN-DX',
      category: 'mat_duong',
      title: 'Cảnh báo lệch GPS hơn 8km tại Phường Đồng Xoài',
      description: 'Tọa độ ghim cách xa vị trí GPS thực tế của thiết bị người gửi.',
      lat: 11.556,
      lng: 106.866,
      address: 'Đường Phú Riềng Đỏ, Phường Đồng Xoài, Thành phố Đồng Nai',
      status: 'quarantined',
      createdMs: BASE_MS + 20 * DAY,
      needsFieldVerification: true,
      gpsMismatchWarning: true,
      gpsDistanceKm: 8.4,
      quarantine: { reason: 'gps_anomaly', detail: 'GPS thiết bị lệch 8.4 km so với vị trí ghim (> 5 km).', at: iso(BASE_MS + 20 * DAY), relatedReportId: null },
    }),
  );

  // 4. 06 Hồ sơ Đã hoàn thành có ảnh Trước – Sau (Before/After) rải khắp 5 vùng
  const baDefs: Array<{ id: string; wardCode: string; cat: Category; title: string; days: number }> = [
    { id: 'rp_ba_1', wardCode: 'DN-TB', cat: 'rac_thai', title: 'Đã dọn sạch bãi rác tự phát hẻm 45 Nguyễn Ái Quốc', days: 1.8 },
    { id: 'rp_ba_2', wardCode: 'DN-LTH', cat: 'den_duong', title: 'Đã thay mới 6 bóng đèn LED cao áp trục vào Sân bay Long Thành', days: 1.4 },
    { id: 'rp_ba_3', wardCode: 'DN-LKH', cat: 'mat_duong', title: 'Đã vá nhựa nóng cụm ổ gà đường Hùng Vương, Phường Long Khánh', days: 2.1 },
    { id: 'rp_ba_4', wardCode: 'DN-TLA', cat: 'rac_thai', title: 'Đã thu gom điểm rác ven đường vào VQG Cát Tiên, Xã Tà Lài', days: 2.3 },
    { id: 'rp_ba_5', wardCode: 'DN-BP', cat: 'ngap_nuoc', title: 'Đã nạo vét cống tiêu thoát nước điểm ngập Phường Bình Phước', days: 1.6 },
    { id: 'rp_ba_6', wardCode: 'DN-LNI', cat: 'den_duong', title: 'Đã khôi phục chiếu sáng trung tâm Phường Lộc Ninh (QL13)', days: 2.0 },
  ];
  baDefs.forEach((b, idx) => {
    const w = WARD_BY_CODE[b.wardCode];
    const cr = BASE_MS + (4 + idx * 2) * DAY;
    const res = cr + Math.round(b.days * DAY);
    const [hBefore, hAfter] = farHashes(2, 20, c);
    list.push(
      makeReport(c, {
        id: b.id,
        wardCode: b.wardCode,
        category: b.cat,
        title: b.title,
        description: DESCS[b.cat],
        lat: w.centerLat + (idx - 2) * 0.0012,
        lng: w.centerLng + (idx % 3 - 1) * 0.0012,
        address: `Khu vực trung tâm, ${w.name}, Thành phố Đồng Nai`,
        status: 'resolved',
        createdMs: cr,
        resolvedMs: res,
        photos: [photo(c, b.cat, idx, 'before', hBefore, `u_seed_ba_${idx}`, cr)],
        afterPhoto: photo(c, b.cat, idx, 'after', hAfter, 'u_staff_city1', res),
        resolution: {
          resolutionVerified: true,
          matchConfidence: 94,
          summary: 'Ảnh sau khớp bối cảnh hiện trường và sự cố đã được khắc phục hoàn toàn.',
          mode: 'seed',
          at: iso(res),
        },
        rating: { stars: 5, comment: 'Xử lý nhanh, minh bạch, có ảnh nghiệm thu rõ ràng!', at: iso(res + 7200000) },
      }),
    );
  });

  // 5. 03 Nhiệm vụ Xác minh Thực địa do Người cao tuổi gửi (rải cả trung tâm và vùng xa)
  const seniorDefs: Array<{ id: string; wardCode: string; cat: Category; title: string }> = [
    { id: 'rp_sen_1', wardCode: 'DN-TB', cat: 'den_duong', title: 'Đèn hẻm tối om trước nhà văn hóa khu phố (Người cao tuổi báo)' },
    { id: 'rp_sen_2', wardCode: 'DN-TLA', cat: 'mat_duong', title: 'Đoạn đường vào Ấp 3 bị xói lở sau mưa (Người cao tuổi báo)' },
    { id: 'rp_sen_3', wardCode: 'DN-BGM', cat: 'ngap_nuoc', title: 'Cống băng đường bị tắc nước tràn vườn (Người cao tuổi báo)' },
  ];
  seniorDefs.forEach((s, idx) => {
    const w = WARD_BY_CODE[s.wardCode];
    list.push(
      makeReport(c, {
        id: s.id,
        wardCode: s.wardCode,
        category: s.cat,
        title: s.title,
        description: 'Phản ánh gửi từ Chế độ Người cao tuổi — đề nghị Đội Thanh niên Tình nguyện hỗ trợ xác minh hiện trường.',
        lat: w.centerLat + 0.0015 * (idx + 1),
        lng: w.centerLng - 0.0012 * (idx + 1),
        address: `${w.name}, Thành phố Đồng Nai`,
        status: 'verifying',
        createdMs: BASE_MS + (20 + idx) * DAY,
        seniorSubmitted: true,
        needsFieldVerification: true,
      }),
    );
  });

  // 6. 64 Hồ sơ phủ đều 5 vùng toàn Thành phố Đồng Nai
  CITYWIDE_DISTRIBUTION.forEach(([wardCode, cat, status], idx) => {
    const w = WARD_BY_CODE[wardCode];
    const titles = TITLES[cat];
    const cr = BASE_MS + Math.floor((idx / CITYWIDE_DISTRIBUTION.length) * 21) * DAY + (idx % 7) * 3600000;
    const durDays = 1.2 + ((idx * 7) % 24) / 10; // 1.2 -> 3.5 ngày
    const res = status === 'resolved' ? cr + Math.round(durDays * DAY) : null;
    const jLat = (c.rnd() - 0.5) * 0.014;
    const jLng = (c.rnd() - 0.5) * 0.014;
    list.push(
      makeReport(c, {
        id: `rp_dn_${String(idx + 1).padStart(2, '0')}`,
        wardCode,
        category: cat,
        title: `${titles[idx % titles.length]} (${w.shortName})`,
        description: DESCS[cat],
        lat: Math.round((w.centerLat + jLat) * 100000) / 100000,
        lng: Math.round((w.centerLng + jLng) * 100000) / 100000,
        address: `${w.arterialRoads[0] ?? 'Đường liên khu'}, ${w.name}, Thành phố Đồng Nai`,
        status,
        createdMs: cr,
        resolvedMs: res,
        priority: status === 'processing' && idx % 5 === 0 ? 'high' : 'normal',
      }),
    );
  });

  return list;
}
