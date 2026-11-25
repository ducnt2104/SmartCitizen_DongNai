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

  if (
    input.isScreenCaptureOrFake === true ||
    input.abuseRisk === 'HIGH' ||
    input.authenticityScore < 50 ||
    input.relevanceScore < 40
  ) {
    const reasons: string[] = [];
    if (input.isScreenCaptureOrFake) {
      reasons.push('ảnh có dấu hiệu chụp lại màn hình thiết bị hoặc cắt ghép từ nguồn khác');
    }
    if (input.abuseRisk === 'HIGH') {
      reasons.push('nội dung chứa yếu tố quấy rối, quảng cáo hoặc không phù hợp tiêu chuẩn cộng đồng');
    }
    if (input.authenticityScore < 50 && !input.isScreenCaptureOrFake) {
      reasons.push('chất lượng hoặc độ chân thực của ảnh hiện trường chưa đạt yêu cầu');
    }
    if (input.relevanceScore < 40) {
      reasons.push('hình ảnh không thể hiện rõ sự cố hạ tầng hoặc môi trường công cộng');
    }

    const detail = reasons.length > 0 ? reasons.join('; ') : 'ảnh không đạt tiêu chuẩn xác thực hiện trường';
    return {
      decision: 'AUTO_REJECT',
      citizenFeedback: `Ảnh chưa đạt yêu cầu xác thực (${detail}). Vui lòng đứng trực tiếp tại hiện trường, mở camera chụp rõ cảnh sự cố và gửi lại.`,
      officerReviewNotes: `AUTO_REJECT tự động: auth=${input.authenticityScore}, rel=${input.relevanceScore}, abuse=${input.abuseRisk}, flags=[${input.forensicFlags.join(', ')}]`,
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
