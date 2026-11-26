import type {
  AbuseRisk,
  Category,
  Department,
  ModerationDecision,
  SeverityLabel,
  StandardizedCivicCategory,
} from '../../shared/types';
import { DEPARTMENT_BY_CATEGORY } from '../../shared/constants';
import { env } from '../../config/env';

export const STANDARDIZED_CIVIC_CATEGORIES: readonly StandardizedCivicCategory[] = [
  'RAC_THAI_MOI_TRUONG',
  'HA_TANG_GIAO_THONG',
  'NGAP_UNG_THOAT_NUOC',
  'CAY_XANH_DO_NGA',
  'DIEN_VIEN_THONG',
  'TRAT_TU_DO_THI',
  'PCCC_KHAN_CAP',
  'KHAC',
] as const;

export const SEVERITY_LEVELS: readonly SeverityLabel[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export const ABUSE_RISKS: readonly AbuseRisk[] = ['NONE', 'LOW', 'MEDIUM', 'HIGH'] as const;

export function mapStandardizedToLegacyCategory(std: StandardizedCivicCategory): Category {
  switch (std) {
    case 'RAC_THAI_MOI_TRUONG':
      return 'rac_thai';
    case 'HA_TANG_GIAO_THONG':
      return 'mat_duong';
    case 'NGAP_UNG_THOAT_NUOC':
      return 'ngap_nuoc';
    case 'DIEN_VIEN_THONG':
      return 'den_duong';
    case 'CAY_XANH_DO_NGA':
    case 'TRAT_TU_DO_THI':
    case 'PCCC_KHAN_CAP':
    case 'KHAC':
      return 'khac';
  }
}

export function mapLegacyToStandardizedCategory(cat: Category, hintText = ''): StandardizedCivicCategory {
  const t = hintText.toLowerCase();
  if (/(cháy|nổ|hỏa hoạn|pccc|khí gas|rò rỉ hóa chất)/.test(t)) return 'PCCC_KHAN_CAP';
  if (/(cây đổ|cây xanh|gãy cành|ngã cây)/.test(t)) return 'CAY_XANH_DO_NGA';
  if (/(lấn chiếm|vỉa hè|biển quảng cáo|hàng rong|trật tự)/.test(t)) return 'TRAT_TU_DO_THI';
  switch (cat) {
    case 'rac_thai':
      return 'RAC_THAI_MOI_TRUONG';
    case 'mat_duong':
      return 'HA_TANG_GIAO_THONG';
    case 'ngap_nuoc':
      return 'NGAP_UNG_THOAT_NUOC';
    case 'den_duong':
      return 'DIEN_VIEN_THONG';
    case 'khac':
      return 'KHAC';
  }
}

export function mapStandardizedToDepartment(std: StandardizedCivicCategory, text = ''): Department {
  switch (std) {
    case 'RAC_THAI_MOI_TRUONG':
      return 'moi_truong';
    case 'HA_TANG_GIAO_THONG':
      return 'giao_thong';
    case 'NGAP_UNG_THOAT_NUOC':
      return 'ubnd_khu_pho';
    case 'DIEN_VIEN_THONG':
      return /(đứt dây|rò điện|biến áp|chập điện|cao thế)/i.test(text) ? 'dien_luc' : 'dien_chieu_sang';
    case 'CAY_XANH_DO_NGA':
    case 'TRAT_TU_DO_THI':
    case 'PCCC_KHAN_CAP':
      return 'csgt';
    case 'KHAC':
      return DEPARTMENT_BY_CATEGORY.khac;
  }
}

export function suggestTwoTierUnit(std: StandardizedCivicCategory, wardName = 'UBND Phường/Xã'): string {
  switch (std) {
    case 'RAC_THAI_MOI_TRUONG':
      return `${wardName} — Tổ Vệ sinh Môi trường & Đô thị cấp xã`;
    case 'HA_TANG_GIAO_THONG':
      return `${wardName} — Tổ Hạ tầng Giao thông & Duy tu đường bộ`;
    case 'NGAP_UNG_THOAT_NUOC':
      return `${wardName} — Tổ Thoát nước & Phòng chống ngập úng`;
    case 'CAY_XANH_DO_NGA':
      return `${wardName} — Đội Cây xanh & Cứu hộ nhanh địa bàn`;
    case 'DIEN_VIEN_THONG':
      return `${wardName} — Tổ Chiếu sáng & Điện lực – Viễn thông khu vực`;
    case 'TRAT_TU_DO_THI':
      return `${wardName} — Tổ Quản lý Trật tự Đô thị & Vỉa hè`;
    case 'PCCC_KHAN_CAP':
      return `${wardName} — Đội Cứu hộ SOS 114 & Công an Phường/Xã`;
    case 'KHAC':
      return `${wardName} — Tổ Tiếp nhận & Xử lý Sự cố tổng hợp`;
  }
}

export function severityLabelToNumeric(label: SeverityLabel): 1 | 2 | 3 | 4 | 5 {
  switch (label) {
    case 'CRITICAL':
      return 5;
    case 'HIGH':
      return 4;
    case 'MEDIUM':
      return 3;
    case 'LOW':
      return 2;
  }
}

export interface ModerationInputs {
  authenticityScore: number;
  relevanceScore: number;
  isScreenCaptureOrFake: boolean;
  abuseRisk: AbuseRisk;
  forensicFlags: string[];
  trustSupervised?: boolean;
  autoApproveMinScore?: number;
}

export interface ModerationOutcome {
  decision: ModerationDecision;
  citizenFeedback: string | null;
  officerReviewNotes: string | null;
}

/**
 * Quyết định kiểm duyệt tất định (Deterministic TypeScript Logic — không phụ thuộc suy diễn của LLM).
 */
export function computeModerationDecision(input: ModerationInputs): ModerationOutcome {
  const minAutoScore = input.autoApproveMinScore ?? env.autoApproveMinScore;

  // Chỉ chặn cứng AUTO_REJECT khi nội dung thực sự vi phạm / quấy rối / spam nặng (abuseRisk === 'HIGH')
  if (input.abuseRisk === 'HIGH') {
    return {
      decision: 'AUTO_REJECT',
      citizenFeedback:
        'Nội dung phản ánh có dấu hiệu vi phạm tiêu chuẩn cộng đồng, chứa liên kết quảng cáo hoặc ngôn từ không phù hợp.',
      officerReviewNotes: `AUTO_REJECT tự động: abuse=${input.abuseRisk}, flags=[${input.forensicFlags.join(', ')}]`,
    };
  }

  // Các nghi ngờ hình ảnh/CV (nghi screenshot, độ nét thấp, không EXIF...) chuyển sang Soft Flag HUMAN_REVIEW để IOC duyệt
  if (input.isScreenCaptureOrFake === true || input.authenticityScore < 50 || input.relevanceScore < 40) {
    const reasons: string[] = [];
    if (input.isScreenCaptureOrFake) {
      reasons.push('ảnh có dấu hiệu chụp màn hình / chỉnh sửa hoặc thiếu thông số gốc');
    }
    if (input.authenticityScore < 50 && !input.isScreenCaptureOrFake) {
      reasons.push('độ nét hoặc điểm xác thực ảnh ở mức thấp');
    }
    if (input.relevanceScore < 40) {
      reasons.push('mức độ liên quan sự cố hạ tầng chưa rõ ràng');
    }
    if (input.forensicFlags.length > 0) {
      reasons.push(`cờ kiểm định: ${input.forensicFlags.join(', ')}`);
    }
    return {
      decision: 'HUMAN_REVIEW',
      citizenFeedback: null,
      officerReviewNotes: `Cảnh báo nhẹ IOC (cho phép tiếp nhận, cần kiểm tra thủ công): ${reasons.join('; ') || 'hồ sơ cần đối chiếu thực tế'}.`,
    };
  }

  if (
    !input.trustSupervised &&
    input.authenticityScore >= minAutoScore &&
    input.relevanceScore >= 80 &&
    input.abuseRisk === 'NONE' &&
    !input.isScreenCaptureOrFake
  ) {
    return {
      decision: 'AUTO_APPROVE',
      citizenFeedback: null,
      officerReviewNotes: null,
    };
  }

  const doubts: string[] = [];
  if (input.trustSupervised) {
    doubts.push('tài khoản đang ở chế độ giám sát (trustScore < 25)');
  }
  if (input.authenticityScore < minAutoScore) {
    doubts.push(`authenticity_score=${input.authenticityScore} (< ${minAutoScore})`);
  }
  if (input.relevanceScore < 80) {
    doubts.push(`relevance_score=${input.relevanceScore} (< 80)`);
  }
  if (input.abuseRisk !== 'NONE') {
    doubts.push(`abuse_risk=${input.abuseRisk}`);
  }
  if (input.forensicFlags.length > 0) {
    doubts.push(`tín hiệu nghi vấn: ${input.forensicFlags.join(', ')}`);
  }

  return {
    decision: 'HUMAN_REVIEW',
    citizenFeedback: null,
    officerReviewNotes: `Cần cán bộ IOC kiểm tra nhanh: ${doubts.join('; ') || 'hồ sơ nằm vùng ranh giới 50–79 điểm'}.`,
  };
}
