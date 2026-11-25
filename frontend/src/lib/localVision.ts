import { DEPARTMENT_BY_CATEGORY } from '@shared/constants';
import type { Category, VisionResult } from '@shared/types';
import type { EdgeStatsMsg } from '../workers/edgeProcessor.worker';

const EMERGENCY = /(cây đổ|đổ cây|dây điện|đứt dây|chập điện|giật điện|cháy|tai nạn|ngập sâu|sập|sạt lở)/i;

const TEXT: Record<Category, { title: string; desc: string }> = {
  rac_thai: { title: 'Rác thải tự phát cần dọn dẹp', desc: 'Khu vực có rác thải tập trung, gây mất vệ sinh và mỹ quan đô thị.' },
  den_duong: { title: 'Đèn chiếu sáng công cộng hư hỏng', desc: 'Đèn đường không sáng hoặc nhấp nháy, khu vực thiếu sáng ban đêm.' },
  ngap_nuoc: { title: 'Điểm ngập nước sau mưa', desc: 'Nước đọng/ngập tại khu vực, cản trở giao thông và sinh hoạt.' },
  mat_duong: { title: 'Mặt đường hư hỏng (ổ gà, nứt, lún)', desc: 'Mặt đường xuống cấp, nguy cơ té ngã cho người đi xe.' },
};

export function guessCategory(text: string, edge?: EdgeStatsMsg): Category {
  const t = text.toLowerCase();
  if (/(rác|bãi rác|hôi)/.test(t)) return 'rac_thai';
  if (/(đèn|điện|cột đèn)/.test(t)) return 'den_duong';
  if (/(ngập|nước|cống|mưa)/.test(t)) return 'ngap_nuoc';
  if (/(ổ gà|đường|nứt|lún|nắp cống)/.test(t)) return 'mat_duong';
  if (edge && edge.brightness < 70) return 'den_duong';
  return 'rac_thai';
}

/**
 * Bộ phân loại Heuristic cục bộ (Chế độ AI Dự phòng) khi mất mạng / server AI không phản hồi.
 * Chỉ dựa trên chỉ số cạnh do Web Worker tính (độ nét, độ phẳng, độ sáng) — KHÔNG phải kết quả Gemini.
 */
export function localVision(category: Category | null, text: string, edge?: EdgeStatsMsg): VisionResult {
  const cat = category ?? guessCategory(text, edge);
  const flags: string[] = [];
  let auth = 82;
  if (edge) {
    if (edge.blurScore < 25) { flags.push('blurry'); auth -= 30; }
    if (edge.flatRatio > 0.62) { flags.push('possible_screen_recapture'); auth -= 38; }
    if (edge.brightness < 18 || edge.brightness > 245) { flags.push('bad_exposure'); auth -= 12; }
  }
  const emergency = EMERGENCY.test(text);
  return {
    category: cat,
    title: TEXT[cat].title,
    description: TEXT[cat].desc,
    severity: emergency ? 5 : 3,
    isEmergency: emergency,
    safetyHazards: emergency ? ['Từ khóa nguy hiểm trong mô tả — cần xác minh nhanh'] : [],
    suggestedDepartment: emergency && cat === 'den_duong' ? 'dien_luc' : DEPARTMENT_BY_CATEGORY[cat],
    authenticityScore: Math.max(0, Math.min(100, auth)),
    fraudFlags: flags,
    confidence: category ? 0.55 : 0.35,
    mode: 'fallback',
    cached: false,
  };
}
