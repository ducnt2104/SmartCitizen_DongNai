/**
 * Local High-Speed Knowledge & Intent Engine (Okapi BM25 + Diacritic-Insensitive Fuzzy Matching).
 * Phản hồi tức thì (< 2–10ms) hoàn toàn độc lập với MongoDB & Cloud LLM cho:
 *  - Quy trình gửi phản ánh 3 bước, xác thực OTP, tra cứu mã hồ sơ, chế độ ngoại tuyến
 *  - Toàn bộ 95 Phường/Xã TP. Đồng Nai (kèm địa danh cũ trước sáp nhập & trục đường chính)
 *  - Danh bạ số điện thoại khẩn cấp (113, 114, 115, Điện lực, Cứu hộ giao thông)
 *  - 5 nhóm sự cố đô thị, cam kết thời gian xử lý (SLA) & vai trò Tình nguyện viên
 */

import { DONG_NAI_WARDS, matchWardByAddressText, searchWards, WARD_BY_CODE } from '../shared/dongNaiWards';

export interface RagDocument {
  id: string;
  kind: 'ward' | 'sop' | 'faq';
  title: string;
  content: string;
  wardCode?: string;
}

export type LocalIntentKind =
  | 'greeting'
  | 'how_to_report'
  | 'emergency_hotlines'
  | 'sla_and_categories'
  | 'status_workflow'
  | 'otp_login_help'
  | 'volunteer_help'
  | 'ward_lookup';

export interface DirectLocalIntentHit {
  intent: LocalIntentKind;
  confidence: number;
  answerVi: string;
  answerEn: string;
}

interface IndexedDoc {
  doc: RagDocument;
  tokens: string[];
  tf: Map<string, number>;
}

export function stripAccents(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

export function normalizePlainVi(input: string): string {
  return stripAccents(input.toLowerCase())
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Khoảng cách Levenshtein giới hạn cho so khớp xấp xỉ (Fuzzy Matching) tiếng Việt gõ sai chính tả / không dấu. */
function boundedEditDistance(a: string, b: string, maxDist = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  const prev = new Uint16Array(b.length + 1);
  const curr = new Uint16Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDist) return maxDist + 1;
    prev.set(curr);
  }
  return prev[b.length];
}

function fuzzyContainsPhrase(normText: string, words: string[], phrase: string): boolean {
  if (normText.includes(phrase)) return true;
  const pWords = phrase.split(' ');
  if (pWords.length > words.length) return false;
  for (let i = 0; i <= words.length - pWords.length; i++) {
    let allClose = true;
    for (let k = 0; k < pWords.length; k++) {
      const target = pWords[k];
      const maxErr = target.length >= 5 ? 1 : 0;
      if (boundedEditDistance(words[i + k], target, maxErr) > maxErr) {
        allClose = false;
        break;
      }
    }
    if (allClose) return true;
  }
  return false;
}

function tokenize(text: string): string[] {
  const norm = normalizePlainVi(text)
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  const bigrams: string[] = [];
  for (let i = 0; i + 1 < norm.length; i++) {
    bigrams.push(`${norm[i]}_${norm[i + 1]}`);
  }
  return [...norm, ...bigrams];
}

function buildKnowledgeCorpus(): RagDocument[] {
  const docs: RagDocument[] = [
    {
      id: 'faq_report_steps',
      kind: 'faq',
      title: 'Hướng dẫn cách gửi phản ánh hiện trường 3 bước',
      content:
        'Bạn có thể gửi phản ánh sự cố đô thị nhanh chóng trong 3 bước:\n' +
        '1. Chụp ảnh hiện trường: Mở mục "Báo cáo", chụp trực tiếp hoặc chọn ảnh sự cố — hệ thống tự động gợi ý phân loại, tiêu đề và mô tả.\n' +
        '2. Xác nhận vị trí: Hệ thống tự lấy tọa độ GPS chính xác cao; bạn có thể kéo ghim trực tiếp trên bản đồ hoặc chỉnh sửa số nhà, tên đường, con hẻm và chọn đúng Phường/Xã.\n' +
        '3. Gửi phản ánh: Bấm "Gửi phản ánh" để nhận mã hồ sơ theo dõi (ngay cả khi mất mạng, đơn vẫn được lưu an toàn trên thiết bị và tự động gửi khi có mạng lại).',
    },
    {
      id: 'faq_emergency',
      kind: 'faq',
      title: 'Số điện thoại khẩn cấp & xử lý tình huống nguy hiểm',
      content:
        'Khi gặp tình huống đe dọa tính mạng hoặc an toàn khẩn cấp, vui lòng gọi ngay:\n' +
        '• 113: Cảnh sát phản ứng nhanh (an ninh trật tự, tai nạn nghiêm trọng)\n' +
        '• 114: Phòng cháy chữa cháy & Cứu nạn cứu hộ (cháy nổ, ngập sâu, mắc kẹt, cây đổ lớn)\n' +
        '• 115: Cấp cứu y tế\n' +
        '• 1900 1006 / 1900 9000: Tổng đài Điện lực miền Nam (đứt dây điện, chập cháy trạm biến áp)\n' +
        'Sau khi đảm bảo an toàn, hãy gửi phản ánh kèm ảnh hiện trường trên ứng dụng để Đội Cứu Hộ và Phường/Xã tiếp cận điều tiết kịp thời.',
    },
    {
      id: 'sop_categories',
      kind: 'sop',
      title: '5 nhóm sự cố đô thị & cam kết thời gian xử lý (SLA)',
      content:
        'Nền tảng tiếp nhận 5 nhóm sự cố hạ tầng đô thị tại 95 Phường/Xã TP. Đồng Nai:\n' +
        '1. Rác thải tự phát -> Đơn vị Môi trường đô thị\n' +
        '2. Đèn đường hỏng / mất an toàn điện -> Điện chiếu sáng & Điện lực\n' +
        '3. Ngập nước sau mưa / cống thoát nước tắc -> Thoát nước & UBND Phường/Xã\n' +
        '4. Ổ gà / mặt đường, nắp hố ga hư hỏng -> Quản lý Giao thông\n' +
        '5. Sự cố khác (cây xanh gãy đổ, biển báo hư hỏng, sạt lở, vật cản giao thông)\n' +
        'Thời hạn xử lý cam kết (SLA): Sự cố khẩn cấp trong 2 giờ, Ưu tiên cao trong 24 giờ, Sự cố thông thường trong 72 giờ.',
    },
    {
      id: 'sop_status_workflow',
      kind: 'sop',
      title: 'Giải thích các trạng thái xử lý hồ sơ & nghiệm thu Trước – Sau',
      content:
        'Mỗi phản ánh đều được công khai minh bạch qua 4 giai đoạn:\n' +
        '• Đã tiếp nhận: Hệ thống cấp mã hồ sơ (ví dụ DN-TB-2611-001) và định tuyến về đúng Phường/Xã.\n' +
        '• Đang xác minh: Cán bộ hoặc Tình nguyện viên kiểm tra thực tế và phân công đơn vị chuyên môn.\n' +
        '• Đang xử lý: Đội ngũ kỹ thuật / Đội cứu hộ đang khắc phục tại hiện trường.\n' +
        '• Hoàn thành: Đơn vị xử lý tải ảnh chụp SAU khắc phục để đối chiếu trực quan Trước – Sau; người dân có thể đánh giá chất lượng từ 1 đến 5 sao.',
    },
    {
      id: 'faq_otp_login',
      kind: 'faq',
      title: 'Hướng dẫn đăng nhập & xác thực mã OTP',
      content:
        'Công dân đăng nhập tại mục "Tài khoản" bằng Số điện thoại di động Việt Nam (+84) hoặc địa chỉ Email để nhận mã OTP 6 chữ số (hiệu lực 5 phút). ' +
        'Sau lần xác thực đầu tiên, bạn có thể đặt mật khẩu cá nhân trong phần Hồ sơ để đăng nhập nhanh cho các lần tiếp theo.',
    },
    {
      id: 'faq_volunteer',
      kind: 'faq',
      title: 'Đăng ký Tình nguyện viên hỗ trợ cộng đồng',
      content:
        'Sau khi đăng nhập tài khoản Công dân, bạn mở mục "Tài khoản", chọn Phường/Xã công tác (trong 95 Phường/Xã) và nhập mã chi đoàn để đăng ký Tình nguyện viên. ' +
        'Tình nguyện viên có thể nhận nhiệm vụ xác minh hiện trường gần mình và gửi báo cáo hộ người cao tuổi.',
    },
  ];

  for (const w of DONG_NAI_WARDS) {
    const adjNames = w.adjacentWardCodes.map((c) => WARD_BY_CODE[c]?.name ?? c).join(', ');
    const aliases = w.legacyAliases.length ? `Địa danh trước sáp nhập: ${w.legacyAliases.join(', ')}. ` : '';
    docs.push({
      id: `ward_${w.wardCode}`,
      kind: 'ward',
      wardCode: w.wardCode,
      title: `${w.name} (${w.wardCode}) — TP. Đồng Nai`,
      content:
        `${w.name} (mã hành chính: ${w.wardCode}, phân vùng: ${w.zone}). ` +
        `${w.upgradedOn2026 ? 'Đơn vị được nâng cấp lên Phường từ 30/04/2026. ' : ''}` +
        `${aliases}Các tuyến đường chính: ${w.arterialRoads.join(', ')}. Giáp ranh với: ${adjNames}.`,
    });
  }

  return docs;
}

export class LocalRagService {
  private readonly docs: IndexedDoc[];
  private readonly df = new Map<string, number>();
  private readonly avgDl: number;

  constructor() {
    const raw = buildKnowledgeCorpus();
    let totalLen = 0;
    this.docs = raw.map((doc) => {
      const tokens = tokenize(`${doc.title} ${doc.content}`);
      totalLen += tokens.length;
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const term of tf.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1);
      return { doc, tokens, tf };
    });
    this.avgDl = totalLen / Math.max(1, this.docs.length);
  }

  get documentCount(): number {
    return this.docs.length;
  }

  /**
   * Nhận diện ý định câu hỏi phổ biến bằng BM25 + Fuzzy Matching tiếng Việt không dấu (< 2ms),
   * giúp Chatbot phản hồi tức thì mà không phụ thuộc MongoDB hay LLM từ xa.
   */
  matchDirectIntent(query: string, activeWardCode?: string): DirectLocalIntentHit | null {
    const norm = normalizePlainVi(query);
    if (!norm) return null;
    const words = norm.split(' ').filter(Boolean);

    // Không chặn nếu câu hỏi là tra mã hồ sơ cụ thể hoặc hỏi số liệu thống kê động
    if (/dn-[a-z]{2,4}-\d{4}-\d{3}/i.test(query)) return null;
    if (
      fuzzyContainsPhrase(norm, words, 'bao nhieu phan anh') ||
      fuzzyContainsPhrase(norm, words, 'co bao nhieu') ||
      fuzzyContainsPhrase(norm, words, 'thong ke') ||
      fuzzyContainsPhrase(norm, words, 'how many report') ||
      fuzzyContainsPhrase(norm, words, 'don cua toi') ||
      fuzzyContainsPhrase(norm, words, 'ho so cua toi')
    ) {
      return null;
    }

    // 1. Khẩn cấp / Số điện thoại cứu hộ
    if (
      ['113', '114', '115'].some((n) => words.includes(n)) ||
      fuzzyContainsPhrase(norm, words, 'so dien thoai khan cap') ||
      fuzzyContainsPhrase(norm, words, 'duong day nong') ||
      fuzzyContainsPhrase(norm, words, 'goi cuu ho') ||
      fuzzyContainsPhrase(norm, words, 'dut day dien') ||
      fuzzyContainsPhrase(norm, words, 'chay no') ||
      fuzzyContainsPhrase(norm, words, 'emergency number')
    ) {
      const doc = this.docs.find((d) => d.doc.id === 'faq_emergency')!.doc;
      return {
        intent: 'emergency_hotlines',
        confidence: 0.98,
        answerVi: doc.content,
        answerEn:
          'For life-threatening emergencies, call immediately:\n• 113: Police Rapid Response\n• 114: Fire & Rescue Services\n• 115: Medical Ambulance\n• 1900 1006: Southern Power Corporation (downed power lines)\nOnce safe, submit a photo report on the app to alert the nearest field response team.',
      };
    }

    // 2. Cách gửi phản ánh / hướng dẫn báo cáo sự cố
    if (
      fuzzyContainsPhrase(norm, words, 'cach gui phan anh') ||
      fuzzyContainsPhrase(norm, words, 'cach bao cao') ||
      fuzzyContainsPhrase(norm, words, 'gui phan anh') ||
      fuzzyContainsPhrase(norm, words, 'lam sao gui') ||
      fuzzyContainsPhrase(norm, words, 'huong dan gui') ||
      fuzzyContainsPhrase(norm, words, 'huong dan bao cao') ||
      fuzzyContainsPhrase(norm, words, 'quy trinh gui') ||
      fuzzyContainsPhrase(norm, words, 'how do i report') ||
      fuzzyContainsPhrase(norm, words, 'how to report') ||
      fuzzyContainsPhrase(norm, words, 'how to submit')
    ) {
      const doc = this.docs.find((d) => d.doc.id === 'faq_report_steps')!.doc;
      return {
        intent: 'how_to_report',
        confidence: 0.99,
        answerVi: doc.content,
        answerEn:
          'You can report an urban issue in 3 quick steps:\n1. Capture a photo: Open "Report" and take or upload a photo — AI automatically suggests the category, title, and description.\n2. Confirm location: High-accuracy GPS pins your spot; drag the pin or refine the street/alley address and Receiving Ward.\n3. Submit: Tap "Submit report" to receive your tracking code (works offline via the Outbox Queue too).',
      };
    }

    // 3. Thời gian xử lý SLA / các nhóm sự cố
    if (
      words.includes('sla') ||
      fuzzyContainsPhrase(norm, words, 'bao lau thi xu ly') ||
      fuzzyContainsPhrase(norm, words, 'thoi gian xu ly') ||
      fuzzyContainsPhrase(norm, words, 'thoi han xu ly') ||
      fuzzyContainsPhrase(norm, words, 'loai su co') ||
      fuzzyContainsPhrase(norm, words, 'nhom su co')
    ) {
      const doc = this.docs.find((d) => d.doc.id === 'sop_categories')!.doc;
      return {
        intent: 'sla_and_categories',
        confidence: 0.95,
        answerVi: doc.content,
        answerEn:
          'We handle 5 urban incident categories across all 95 Wards/Communes of Dong Nai City: (1) Waste, (2) Street Lighting & Power, (3) Flooding & Drainage, (4) Road Damage & Potholes, and (5) Other Infrastructure Issues. SLA targets: 2 hours for Emergencies, 24 hours for High Priority, and 72 hours for Standard cases.',
      };
    }

    // 4. Ý nghĩa các trạng thái xử lý hồ sơ
    if (
      fuzzyContainsPhrase(norm, words, 'trang thai ho so') ||
      fuzzyContainsPhrase(norm, words, 'cac buoc xu ly') ||
      fuzzyContainsPhrase(norm, words, 'tien do xu ly') ||
      fuzzyContainsPhrase(norm, words, 'nghiem thu truoc sau')
    ) {
      const doc = this.docs.find((d) => d.doc.id === 'sop_status_workflow')!.doc;
      return {
        intent: 'status_workflow',
        confidence: 0.94,
        answerVi: doc.content,
        answerEn:
          'Every report progresses transparently through 4 stages: Received -> Verifying -> In Progress -> Resolved (with Before/After photo comparison and citizen 1–5 star rating).',
      };
    }

    // 5. Hỗ trợ OTP / Đăng nhập
    if (
      (words.includes('otp') || fuzzyContainsPhrase(norm, words, 'dang nhap') || fuzzyContainsPhrase(norm, words, 'quen mat khau')) &&
      words.length <= 12
    ) {
      const doc = this.docs.find((d) => d.doc.id === 'faq_otp_login')!.doc;
      return {
        intent: 'otp_login_help',
        confidence: 0.92,
        answerVi: doc.content,
        answerEn:
          'Sign in under "Account" using your Vietnamese mobile number (+84) or Email to receive a 6-digit OTP code (valid for 5 minutes). You can also set a password for quick future sign-ins.',
      };
    }

    // 6. Đăng ký tình nguyện viên
    if (fuzzyContainsPhrase(norm, words, 'tinh nguyen vien') || fuzzyContainsPhrase(norm, words, 'bao cao ho')) {
      const doc = this.docs.find((d) => d.doc.id === 'faq_volunteer')!.doc;
      return {
        intent: 'volunteer_help',
        confidence: 0.93,
        answerVi: doc.content,
        answerEn:
          'After signing in as a Citizen, visit "Account" to select your assigned Ward/Commune and chapter code to join as a Youth Volunteer for field verification and senior proxy reporting.',
      };
    }

    // 7. Tra cứu thông tin cụ thể 1 trong 95 Phường/Xã TP. Đồng Nai (kể cả gõ không dấu hoặc tên cũ)
    if (
      words.length <= 16 &&
      (fuzzyContainsPhrase(norm, words, 'phuong') ||
        fuzzyContainsPhrase(norm, words, 'xa') ||
        fuzzyContainsPhrase(norm, words, 'giap ranh') ||
        fuzzyContainsPhrase(norm, words, 'duong chinh') ||
        fuzzyContainsPhrase(norm, words, 'sap nhap'))
    ) {
      const aliasHit = matchWardByAddressText(query);
      const searched = aliasHit?.ward ?? searchWards(query, 1)[0] ?? (activeWardCode ? WARD_BY_CODE[activeWardCode] : undefined);
      if (searched) {
        const wDoc = this.docs.find((d) => d.doc.wardCode === searched.wardCode)?.doc;
        if (wDoc) {
          return {
            intent: 'ward_lookup',
            confidence: 0.92,
            answerVi: wDoc.content,
            answerEn: `${searched.name} (Code: ${searched.wardCode}, Zone: ${searched.zone}). Main arterial roads: ${searched.arterialRoads.join(', ')}.`,
          };
        }
      }
    }

    // 8. Chào hỏi ngắn
    if (words.length <= 4 && ['xin chao', 'chao ban', 'hello', 'hi', 'alo'].some((g) => norm === g || norm.startsWith(`${g} `))) {
      return {
        intent: 'greeting',
        confidence: 0.96,
        answerVi:
          'Xin chào! Mình là Trợ lý Cổng Phản ánh Đô thị Thông minh TP. Đồng Nai. Mình có thể hướng dẫn bạn gửi phản ánh trong 3 bước, tra cứu tiến độ mã hồ sơ (vd: DN-TB-2611-001), tìm thông tin 95 Phường/Xã hoặc cung cấp danh bạ khẩn cấp. Bạn cần hỗ trợ gì ạ?',
        answerEn:
          'Hello! I am the SmartCitizen Dong Nai Assistant. I can guide you through reporting an issue in 3 steps, tracking report codes (e.g. DN-TB-2611-001), or looking up information across all 95 Wards/Communes.',
      };
    }

    return null;
  }

  /** Truy xuất Top-K đoạn tri thức phù hợp nhất bằng Okapi BM25 (< 2ms). */
  retrieve(query: string, topK = 4, boostWardCode?: string): Array<{ doc: RagDocument; score: number }> {
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return [];
    const nDocs = this.docs.length;
    const k1 = 1.5;
    const b = 0.75;

    const scored: Array<{ doc: RagDocument; score: number }> = [];
    for (const item of this.docs) {
      let score = 0;
      const dl = item.tokens.length;
      for (const qt of qTokens) {
        const f = item.tf.get(qt) ?? 0;
        if (f === 0) continue;
        const df = this.df.get(qt) ?? 0;
        const idf = Math.log(1 + (nDocs - df + 0.5) / (df + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / this.avgDl))));
      }
      if (boostWardCode && item.doc.wardCode === boostWardCode) {
        score += 1.5;
      }
      if (score > 0.2) {
        scored.push({ doc: item.doc, score: Math.round(score * 100) / 100 });
      }
    }

    scored.sort((a, b2) => b2.score - a.score);
    return scored.slice(0, topK);
  }
}
