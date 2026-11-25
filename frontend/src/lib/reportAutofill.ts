import { DONG_NAI_WARDS, WARD_BY_CODE } from '@shared/dongNaiWards';
import { inDongNaiBBox, matchArterial, nearestWard, resolveAdminUnit } from '@shared/geo';
import type { Category, VisionResult } from '@shared/types';
import type { ResolvedGeoState } from '../components/map';

export type AutofillField =
  | 'category'
  | 'otherLabel'
  | 'title'
  | 'description'
  | 'severity'
  | 'isEmergency'
  | 'wardCode'
  | 'address';

export interface ReportFormValues {
  category: Category | null;
  otherLabel: string;
  title: string;
  description: string;
  severity: 1 | 2 | 3 | 4 | 5;
  isEmergency: boolean;
  wardCode: string;
  address: string;
}

export interface PendingAiSuggestions {
  category?: Category;
  otherLabel?: string;
  title?: string;
  description?: string;
  severity?: 1 | 2 | 3 | 4 | 5;
  isEmergency?: boolean;
  address?: string;
}

export interface InstantWardResolution {
  inBounds: boolean;
  wardCode: string;
  wardName: string;
  address: string;
  geo: ResolvedGeoState;
  latencyMs: number;
}

/**
 * Chuẩn hóa tức thì (< 2ms) tọa độ EXIF / GPS trình duyệt về 1 trong 95 Xã/Phường tỉnh Đồng Nai.
 * Chạy hoàn toàn cục bộ trên Client mà không cần chờ phản hồi AI hay Geocoder mạng.
 */
export function resolveInstantWardFromCoords(lat: number, lng: number): InstantWardResolution {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const unit = resolveAdminUnit({ lat, lng });
  const nearest = nearestWard(lat, lng);
  const wardCode = unit.wardCode ?? nearest.wardCode;
  const ward = WARD_BY_CODE[wardCode] ?? DONG_NAI_WARDS[0];
  const arterial = matchArterial(lat, lng);
  const inBounds = inDongNaiBBox(lat, lng);

  const geo: ResolvedGeoState = {
    inBounds,
    ward: { wardCode: ward.wardCode, name: ward.name },
    arterial,
    nearby: [],
    needsConfirmation: unit.needsConfirmation,
    source: unit.source,
    matchedAlias: unit.matchedAlias,
  };

  const defaultAddr = arterial
    ? `${arterial.name}, ${ward.name}, Thành phố Đồng Nai`
    : `${ward.name}, Thành phố Đồng Nai`;

  const latencyMs = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) * 100) / 100;
  return {
    inBounds,
    wardCode: ward.wardCode,
    wardName: ward.name,
    address: inBounds ? defaultAddr : unit.address,
    geo,
    latencyMs,
  };
}

/**
 * Áp dụng kết quả Vision AI vào biểu mẫu theo cơ chế chống xung đột `dirtyFields`:
 *  - Trường chưa được người dùng chỉnh sửa tay: tự động điền mượt mà (kể cả khi đổi sang ảnh mới).
 *  - Trường người dùng đã chủ động chỉnh sửa tay (`dirtyFields.has(field)`):
 *    KHÔNG ghi đè; đẩy gợi ý mới vào `pendingSuggestions` để người dùng bấm áp dụng 1 chạm nếu muốn.
 */
export function computeSmartAutofill(params: {
  vision: VisionResult;
  current: ReportFormValues;
  dirtyFields: ReadonlySet<AutofillField>;
}): {
  nextValues: ReportFormValues;
  pendingSuggestions: PendingAiSuggestions | null;
  autoAppliedFields: AutofillField[];
} {
  const { vision, current, dirtyFields } = params;
  const next: ReportFormValues = { ...current };
  const pending: PendingAiSuggestions = {};
  const autoAppliedFields: AutofillField[] = [];

  const suggestedCat = vision.category;
  if (!dirtyFields.has('category')) {
    next.category = suggestedCat;
    autoAppliedFields.push('category');
  } else if (suggestedCat && current.category !== suggestedCat) {
    pending.category = suggestedCat;
  }

  const suggestedOther =
    suggestedCat === 'khac' ? (vision.aiSuggestedLabel?.trim() || (vision.suggestedTitle ?? vision.title).trim()) : '';
  if (suggestedOther) {
    if (!dirtyFields.has('otherLabel')) {
      next.otherLabel = suggestedOther.slice(0, 80);
      autoAppliedFields.push('otherLabel');
    } else if (current.otherLabel.trim() !== suggestedOther.slice(0, 80)) {
      pending.otherLabel = suggestedOther.slice(0, 80);
    }
  }

  const suggestedTitle = (vision.suggestedTitle ?? vision.title ?? '').trim().slice(0, 140);
  if (suggestedTitle) {
    if (!dirtyFields.has('title')) {
      next.title = suggestedTitle;
      autoAppliedFields.push('title');
    } else if (current.title.trim() !== suggestedTitle) {
      pending.title = suggestedTitle;
    }
  }

  const suggestedDesc = (vision.suggestedDescription ?? vision.description ?? '').trim().slice(0, 800);
  if (suggestedDesc) {
    if (!dirtyFields.has('description')) {
      next.description = suggestedDesc;
      autoAppliedFields.push('description');
    } else if (current.description.trim() !== suggestedDesc) {
      pending.description = suggestedDesc;
    }
  }

  const suggestedSeverity = vision.severity;
  if (!dirtyFields.has('severity')) {
    next.severity = suggestedSeverity;
    autoAppliedFields.push('severity');
  } else if (current.severity !== suggestedSeverity) {
    pending.severity = suggestedSeverity;
  }

  const suggestedEmergency = Boolean(vision.isEmergency);
  if (!dirtyFields.has('isEmergency')) {
    next.isEmergency = suggestedEmergency;
    autoAppliedFields.push('isEmergency');
  } else if (current.isEmergency !== suggestedEmergency) {
    pending.isEmergency = suggestedEmergency;
  }

  const rawHint = vision.addressHint?.trim() ?? '';
  if (rawHint) {
    const wardSuffix = current.wardCode && WARD_BY_CODE[current.wardCode] ? `, ${WARD_BY_CODE[current.wardCode].name}, Thành phố Đồng Nai` : '';
    const fullAddr = rawHint.includes('Đồng Nai') || !wardSuffix ? rawHint : `${rawHint}${wardSuffix}`;
    if (!dirtyFields.has('address') && (!current.address.trim() || current.address.startsWith('Phường ') || current.address.startsWith('Xã '))) {
      next.address = fullAddr.slice(0, 240);
      autoAppliedFields.push('address');
    } else if (dirtyFields.has('address') && current.address.trim() !== fullAddr) {
      pending.address = fullAddr.slice(0, 240);
    }
  }

  const hasPending = Object.keys(pending).length > 0;
  return {
    nextValues: next,
    pendingSuggestions: hasPending ? pending : null,
    autoAppliedFields,
  };
}
