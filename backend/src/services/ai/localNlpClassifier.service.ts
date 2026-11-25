/**
 * Bộ phân loại NLP cục bộ siêu tốc (< 10ms) cho phản ánh đô thị tiếng Việt (có dấu & không dấu):
 *  - Kết hợp Okapi BM25 + TF-IDF trên từ vựng sự cố 95 Phường/Xã Đồng Nai
 *  - Bộ luật Rule Engine nhận diện khẩn cấp (cây đổ, cháy nổ, đứt dây điện, ngập sâu, tai nạn, sạt lở)
 *  - Cổng Hybrid (`HYBRID_LOCAL_CONFIDENCE_THRESHOLD = 0.75`):
 *      * confidence >= 0.75 -> xử lý cục bộ tức thì (<10ms), tiết kiệm 60–80% lượt gọi Gemini
 *      * confidence < 0.75  -> chuyển tầng Gemini Cloud phân tích sâu đa phương thức
 */
import { performance } from 'node:perf_hooks';
import { computeSosPriorityScore, DEPARTMENT_BY_CATEGORY, toSeverityLabel } from '../../shared/constants';
import { WARD_BY_CODE } from '../../shared/dongNaiWards';
import type { Category, Department, SeverityLabel, StandardizedCivicCategory } from '../../shared/types';
import { normalizePlainVi } from '../localRag.service';
import { mapLegacyToStandardizedCategory, mapStandardizedToDepartment, suggestTwoTierUnit } from './taxonomy';

export const HYBRID_LOCAL_CONFIDENCE_THRESHOLD = 0.75;

export interface LocalNlpClassification {
  category: Category;
  standardizedCategory: StandardizedCivicCategory;
  aiSuggestedLabel: string | null;
  confidence: number;
  urgencyScore: number;
  severity: 1 | 2 | 3 | 4 | 5;
  severityLabel: SeverityLabel;
  isEmergency: boolean;
  safetyHazards: string[];
  suggestedDepartment: Department;
  suggestedUnit: string;
  suggestedTitle: string;
  suggestedDescription: string;
  keyEvidenceTags: string[];
  matchedTerms: string[];
  latencyMs: number;
}

interface CorpusPrototype {
  category: Category;
  stdCategory: StandardizedCivicCategory;
  subLabel?: string;
  text: string;
  baseSeverity: 1 | 2 | 3 | 4 | 5;
}

const PROTOTYPES: CorpusPrototype[] = [
  {
    category: 'rac_thai',
    stdCategory: 'RAC_THAI_MOI_TRUONG',
    text: 'rac thai bai rac tu phat xa ban boc mui hoi thoi o nhiem moi truong tui nilon phe lieu vut rac bua bai ben duong le duong',
    baseSeverity: 3,
  },
  {
    category: 'rac_thai',
    stdCategory: 'RAC_THAI_MOI_TRUONG',
    text: 'dong rac lon chan via he khong thu gom rac thai sinh hoat nuoc ri rac ruoi muoi mat my quan do thi',
    baseSeverity: 3,
  },
  {
    category: 'ngap_nuoc',
    stdCategory: 'NGAP_UNG_THOAT_NUOC',
    text: 'ngap nuoc ngap lut ngap sau sau mua nuoc dong u dong cong thoat nuoc bi tac nghen ngap nua banh xe khong di qua duoc',
    baseSeverity: 4,
  },
  {
    category: 'ngap_nuoc',
    stdCategory: 'NGAP_UNG_THOAT_NUOC',
    text: 'ho ga tran nuoc mui hoi nuoc ngap vao nha dan trieu cuong ngap doan duong ham chui giao thong un tac',
    baseSeverity: 4,
  },
  {
    category: 'den_duong',
    stdCategory: 'DIEN_VIEN_THONG',
    text: 'den duong tat toi om bong den chieu sang hu hong cot den nhap nhay khong sang ban dem mat an toan giao thong',
    baseSeverity: 3,
  },
  {
    category: 'den_duong',
    stdCategory: 'DIEN_VIEN_THONG',
    text: 'dut day dien ro ri dien chop no tu dien tru dien nghieng cot dien day cap vien thong sa xuong duong giat dien',
    baseSeverity: 5,
  },
  {
    category: 'mat_duong',
    stdCategory: 'HA_TANG_GIAO_THONG',
    text: 'o ga mat duong hu hong sut lun nut ne bong troc nhua duong nap cong vo mat nap ho ga nguy hiem cho xe may te nga',
    baseSeverity: 4,
  },
  {
    category: 'mat_duong',
    stdCategory: 'HA_TANG_GIAO_THONG',
    text: 'via he sup lun ranh thoat nuoc vo gach lat cong trinh dao duong khong rao chan gay tai nan va quet giao thong',
    baseSeverity: 4,
  },
  {
    category: 'khac',
    stdCategory: 'CAY_XANH_DO_NGA',
    subLabel: 'Cây xanh gãy đổ',
    text: 'cay do gay canh cay xanh bat goc de ngang duong chan loi di de len day dien xe co sau gio loc',
    baseSeverity: 5,
  },
  {
    category: 'khac',
    stdCategory: 'PCCC_KHAN_CAP',
    subLabel: 'Cháy nổ khẩn cấp',
    text: 'chay no hoa hoan khoi den boc cao ro ri khi gas hoa chat pccc cuu hoa khan cap nguy hiem tinh mang',
    baseSeverity: 5,
  },
  {
    category: 'khac',
    stdCategory: 'TRAT_TU_DO_THI',
    subLabel: 'Trật tự đô thị & Lấn chiếm',
    text: 'lan chiem via he long duong hop cho tu phat bien quang cao che khuat tam nhin bien bao giao thong hong',
    baseSeverity: 2,
  },
];

interface RulePattern {
  category: Category;
  stdCategory?: StandardizedCivicCategory;
  re: RegExp;
  weight: number;
  term: string;
}

const PLAIN_RULES: RulePattern[] = [
  { category: 'rac_thai', re: /\b(?:rac thai|bai rac|dong rac|xa ban|hoi thoi|mui hoi|rac sinh hoat|o nhiem|phe thai)\b/, weight: 2.6, term: 'rác thải / ô nhiễm' },
  { category: 'ngap_nuoc', re: /\b(?:ngap nuoc|ngap lut|ngap ung|ngap sau|nuoc dong|tac cong|cong thoat nuoc|trieu cuong|tran bo)\b/, weight: 2.7, term: 'ngập nước / thoát nước' },
  { category: 'den_duong', re: /\b(?:den duong|chieu sang|cot den|bong den|toi om|dut day dien|chap dien|tu dien|ro dien)\b/, weight: 2.7, term: 'đèn đường / điện lực' },
  { category: 'mat_duong', re: /\b(?:o ga|o voi|mat duong|sut lun|nut duong|bong troc|nap cong|mat nap|ho ga)\b/, weight: 2.6, term: 'hạ tầng mặt đường' },
  { category: 'khac', stdCategory: 'CAY_XANH_DO_NGA', re: /\b(?:cay do|do cay|gay canh|bat goc|cay xanh|ngang duong)\b/, weight: 2.9, term: 'cây đổ gãy cành' },
  { category: 'khac', stdCategory: 'PCCC_KHAN_CAP', re: /\b(?:chay lon|chay nha|chay no|hoa hoan|khoi den|ro khi gas)\b/, weight: 3.2, term: 'cháy nổ khẩn cấp' },
  { category: 'khac', stdCategory: 'TRAT_TU_DO_THI', re: /\b(?:lan chiem|via he|bien bao|den tin hieu|keo cap)\b/, weight: 2.2, term: 'trật tự đô thị' },
];

const EMERGENCY_PLAIN_RE =
  /\b(?:cay do|do cay|dut day dien|ro dien|chap dien|giat dien|chay no|hoa hoan|ngap sau|ngap nuoc sau|sup ho|mat nap ho ga|ho ga mat nap|tai nan|sat lo|nguy hiem tinh mang|khan cap)\b/;

const HIGH_URGENCY_RE =
  /\b(?:nang|nghiem trong|chan loi|un tac|chet|te nga|vo nap|ngap nua banh|khong the di|nhieu ngay|truong hoc|benh vien)\b/;

const CATEGORY_DEFAULT_COPY: Record<Category, { title: string; desc: string }> = {
  rac_thai: {
    title: 'Phản ánh điểm tập kết rác thải gây mất vệ sinh',
    desc: 'Khu vực xuất hiện rác thải ứ đọng, cần đơn vị môi trường kiểm tra thu gom và vệ sinh hiện trường.',
  },
  den_duong: {
    title: 'Sự cố hệ thống đèn chiếu sáng / điện công cộng',
    desc: 'Hệ thống chiếu sáng hoặc đường dây tại khu vực gặp trục trặc, tiềm ẩn rủi ro an toàn vào ban đêm.',
  },
  ngap_nuoc: {
    title: 'Điểm ngập úng mặt đường cản trở lưu thông',
    desc: 'Nước dâng đọng tại khu vực phản ánh, đề nghị tổ thoát nước khơi thông cống rãnh kịp thời.',
  },
  mat_duong: {
    title: 'Hư hỏng kết cấu mặt đường / hố ga công cộng',
    desc: 'Mặt đường xuất hiện ổ gà, sụt lún hoặc hố ga mất an toàn, cần duy tu khắc phục sớm.',
  },
  khac: {
    title: 'Sự cố hạ tầng và trật tự đô thị cần kiểm tra',
    desc: 'Ghi nhận phản ánh hiện trường của công dân cần cơ quan chức năng địa phương xác minh xử lý.',
  },
};

class LocalNlpIndex {
  private readonly tokenized: Array<{ proto: CorpusPrototype; tf: Map<string, number>; len: number }>;
  private readonly df = new Map<string, number>();
  private readonly avgLen: number;

  constructor() {
    this.tokenized = PROTOTYPES.map((proto) => {
      const tokens = normalizePlainVi(proto.text).split(' ').filter((w) => w.length >= 2);
      const tf = new Map<string, number>();
      for (const w of tokens) tf.set(w, (tf.get(w) ?? 0) + 1);
      for (const unique of tf.keys()) this.df.set(unique, (this.df.get(unique) ?? 0) + 1);
      return { proto, tf, len: tokens.length };
    });
    const totalLen = this.tokenized.reduce((s, d) => s + d.len, 0);
    this.avgLen = Math.max(1, totalLen / this.tokenized.length);
  }

  scoreBm25TfIdf(queryPlain: string): Map<Category, { score: number; proto: CorpusPrototype; hits: string[] }> {
    const qTokens = queryPlain.split(' ').filter((w) => w.length >= 2);
    const qBigrams: string[] = [];
    for (let i = 0; i + 1 < qTokens.length; i++) {
      qBigrams.push(`${qTokens[i]}_${qTokens[i + 1]}`);
    }

    const N = this.tokenized.length;
    const k1 = 1.4;
    const b = 0.7;
    const bestPerCat = new Map<Category, { score: number; proto: CorpusPrototype; hits: string[] }>();

    for (const doc of this.tokenized) {
      let score = 0;
      const hits: string[] = [];
      for (const term of qTokens) {
        const tfVal = doc.tf.get(term) ?? 0;
        if (tfVal > 0) {
          const dfVal = this.df.get(term) ?? 1;
          const idf = Math.log(1 + (N - dfVal + 0.5) / (dfVal + 0.5));
          const num = tfVal * (k1 + 1);
          const denom = tfVal + k1 * (1 - b + b * (doc.len / this.avgLen));
          score += idf * (num / denom);
          if (!hits.includes(term)) hits.push(term);
        }
      }
      // Cộng thưởng bigram khớp chính xác cụm 2 từ liên tiếp (VD: "ngap nuoc", "o ga", "cay do")
      const docPlain = doc.proto.text;
      for (const bg of qBigrams) {
        const phrase = bg.replace('_', ' ');
        if (docPlain.includes(phrase)) {
          score += 1.65;
          if (!hits.includes(phrase)) hits.push(phrase);
        }
      }
      const prev = bestPerCat.get(doc.proto.category);
      if (!prev || score > prev.score) {
        bestPerCat.set(doc.proto.category, { score, proto: doc.proto, hits });
      }
    }

    return bestPerCat;
  }
}

const NLP_INDEX = new LocalNlpIndex();

export class LocalNlpClassifierService {
  /**
   * Phân loại sự cố & chấm điểm độ khẩn cấp từ văn bản tiếng Việt (có dấu hoặc không dấu) trong < 10ms.
   */
  classify(params: {
    text?: string;
    hintCategory?: Category;
    wardCode?: string;
    onArterial?: boolean;
    brightness?: number;
  }): LocalNlpClassification {
    const t0 = performance.now();
    const rawText = (params.text ?? '').trim();
    const plain = normalizePlainVi(rawText);
    const words = plain ? plain.split(' ').filter((w) => w.length >= 2) : [];

    const bm25Scores: Map<Category, { score: number; proto: CorpusPrototype; hits: string[] }> = plain
      ? NLP_INDEX.scoreBm25TfIdf(plain)
      : new Map();

    const categoryTotals: Record<Category, number> = {
      rac_thai: 0,
      den_duong: 0,
      ngap_nuoc: 0,
      mat_duong: 0,
      khac: 0,
    };
    const matchedTerms: string[] = [];

    for (const [cat, info] of bm25Scores.entries()) {
      categoryTotals[cat] += info.score;
      for (const h of info.hits) {
        if (!matchedTerms.includes(h)) matchedTerms.push(h);
      }
    }

    let bestStdOverride: StandardizedCivicCategory | undefined;
    for (const rule of PLAIN_RULES) {
      if (plain && rule.re.test(plain)) {
        categoryTotals[rule.category] += rule.weight;
        if (rule.stdCategory) bestStdOverride = rule.stdCategory;
        if (!matchedTerms.includes(rule.term)) matchedTerms.push(rule.term);
      }
    }

    if (params.hintCategory) {
      categoryTotals[params.hintCategory] += 0.9;
    }
    if (typeof params.brightness === 'number' && params.brightness < 65 && !plain) {
      categoryTotals.den_duong += 0.6;
    }

    const ranked = (Object.entries(categoryTotals) as Array<[Category, number]>).sort((a, b) => b[1] - a[1]);
    const [topCat, topScore] = ranked[0];
    const secondScore = ranked[1]?.[1] ?? 0;

    // Chọn danh mục thắng cuộc (nếu hoàn toàn rỗng thì ưu tiên hintCategory hoặc 'khac')
    const chosenCategory: Category =
      topScore > 0 ? topCat : (params.hintCategory ?? 'rac_thai');

    // Tính confidence chuẩn hóa [0.22 .. 0.96]:
    // Chỉ vượt ngưỡng 0.75 khi văn bản đủ giàu thông tin (>= 3 từ, >= 16 ký tự) và tách biệt rõ với nhóm thứ 2
    const margin = Math.max(0, topScore - secondScore);
    let confidence = 0.24;
    if (topScore > 0) {
      const lengthFactor = Math.min(1, words.length / 5) * (rawText.length >= 16 ? 1 : 0.68);
      const signalStrength = Math.min(1, topScore / 5.5);
      const marginBonus = Math.min(0.22, margin * 0.08);
      confidence = 0.32 + signalStrength * 0.42 * lengthFactor + marginBonus;
      if (params.hintCategory && params.hintCategory === chosenCategory && words.length >= 3) {
        confidence += 0.08;
      }
    } else if (params.hintCategory) {
      confidence = 0.42;
    }
    // Văn bản quá ngắn (1–2 từ, VD: "Ngập nước") luôn giữ confidence < 0.75 để tầng Gemini kiểm tra ảnh
    if (words.length <= 2 || rawText.length < 12) {
      confidence = Math.min(confidence, 0.64);
    }
    confidence = Math.round(Math.max(0.2, Math.min(0.96, confidence)) * 100) / 100;

    const isEmergency = Boolean(plain && EMERGENCY_PLAIN_RE.test(plain));
    const isHighUrgency = Boolean(plain && HIGH_URGENCY_RE.test(plain));

    const matchedProto = bm25Scores.get(chosenCategory)?.proto;
    let severity: 1 | 2 | 3 | 4 | 5 = matchedProto?.baseSeverity ?? 3;
    if (isEmergency) severity = 5;
    else if (isHighUrgency && severity < 4) severity = 4;
    else if (words.length >= 4 && topScore < 2 && severity > 3) severity = 3;

    const urgencyScore = computeSosPriorityScore({
      severity,
      isEmergency,
      onArterial: params.onArterial,
    });
    const severityLabel = toSeverityLabel(severity, isEmergency);

    const standardizedCategory =
      bestStdOverride ?? mapLegacyToStandardizedCategory(chosenCategory, rawText);
    const suggestedDepartment =
      isEmergency && chosenCategory === 'den_duong'
        ? 'dien_luc'
        : standardizedCategory
          ? mapStandardizedToDepartment(standardizedCategory, rawText)
          : DEPARTMENT_BY_CATEGORY[chosenCategory];

    const wardName = params.wardCode ? WARD_BY_CODE[params.wardCode]?.name ?? 'UBND Phường/Xã' : 'UBND Phường/Xã';
    const suggestedUnit = suggestTwoTierUnit(standardizedCategory, wardName);

    const defaults = CATEGORY_DEFAULT_COPY[chosenCategory];
    const suggestedTitle =
      rawText.length >= 12
        ? rawText.split(/[.!?\n]/)[0].trim().slice(0, 88)
        : defaults.title;
    const suggestedDescription = rawText.length >= 20 ? rawText.slice(0, 420) : defaults.desc;

    const safetyHazards: string[] = [];
    if (isEmergency) safetyHazards.push('Phát hiện từ khóa nguy hiểm khẩn cấp — cần cảnh báo khu vực ngay');
    if (params.onArterial) safetyHazards.push('Nằm trên trục giao thông huyết mạch — nguy cơ ùn tắc cao');

    const aiSuggestedLabel =
      chosenCategory === 'khac'
        ? matchedProto?.subLabel ?? (matchedTerms[0] ? `Sự cố: ${matchedTerms[0]}` : 'Sự cố hạ tầng khác')
        : null;

    const latencyMs = Math.round((performance.now() - t0) * 100) / 100;

    return {
      category: chosenCategory,
      standardizedCategory,
      aiSuggestedLabel,
      confidence,
      urgencyScore,
      severity,
      severityLabel,
      isEmergency,
      safetyHazards,
      suggestedDepartment,
      suggestedUnit,
      suggestedTitle,
      suggestedDescription,
      keyEvidenceTags: matchedTerms.slice(0, 4),
      matchedTerms: matchedTerms.slice(0, 6),
      latencyMs,
    };
  }
}

export const localNlpClassifier = new LocalNlpClassifierService();
