import { badRequest } from '../../utils/errors';

/**
 * Biểu thức chính quy kiểm tra số di động Việt Nam chuẩn E.164:
 * - Đầu số hợp lệ: 03x, 05x, 07x, 08x, 09x (đủ 10 chữ số nội địa -> +84 + 9 chữ số).
 * - Từ chối số bàn (024, 028...), đầu 11 số cũ (016x, 012x...) và độ dài sai lệch.
 */
export const VN_MOBILE_E164_REGEX = /^\+84[35789]\d{8}$/;
export const VN_MOBILE_LOCAL_REGEX = /^0[35789]\d{8}$/;

export interface ParsedVnPhone {
  /** Dạng quốc tế E.164: `+84912345678` */
  e164: string;
  /** Dạng nội địa 10 số: `0912345678` */
  local: string;
  /** Dạng che bớt để hiển thị an toàn: `+84 912 *** 678` */
  masked: string;
}

/**
 * Chuẩn hóa số điện thoại di động Việt Nam về định dạng quốc tế E.164 (`+84...`).
 * - Chấp nhận: `0912345678`, `84912345678`, `+84912345678`, có khoảng trắng / dấu `-` / `.` / `()`.
 * - Kiểm tra chặt đầu số di động Việt Nam hợp lệ (`03`, `05`, `07`, `08`, `09`, đủ 10 số).
 * - Trả về `null` nếu không hợp lệ.
 */
export function normalizeVnPhone(rawPhone: string): string | null {
  if (typeof rawPhone !== 'string') return null;
  const trimmed = rawPhone.trim();
  if (!trimmed) return null;

  // Chỉ cho phép chữ số, dấu '+' ở đầu và các ký tự phân tách thông dụng (khoảng trắng, '-', '.', '(', ')')
  if (!/^\+?[\d\s.\-()]+$/.test(trimmed)) return null;

  // Loại bỏ khoảng trắng, dấu gạch ngang, dấu chấm và dấu ngoặc
  const cleaned = trimmed.replace(/[\s.\-()]/g, '');
  if (!cleaned) return null;

  // Không chấp nhận dấu '+' xuất hiện ở giữa chuỗi
  if (cleaned.slice(1).includes('+')) return null;

  let e164: string;
  if (cleaned.startsWith('+84')) {
    const rest = cleaned.slice(3);
    // Hỗ trợ trường hợp người dùng gõ "+84 0912345678" hoặc chuẩn "+84912345678"
    e164 = rest.startsWith('0') && rest.length === 10 ? `+84${rest.slice(1)}` : `+84${rest}`;
  } else if (cleaned.startsWith('84') && cleaned.length === 11) {
    e164 = `+${cleaned}`;
  } else if (cleaned.startsWith('0') && cleaned.length === 10) {
    e164 = `+84${cleaned.slice(1)}`;
  } else if (/^[35789]\d{8}$/.test(cleaned)) {
    // Trường hợp nhập 9 chữ số sau cờ +84 trên giao diện (vd: "912345678")
    e164 = `+84${cleaned}`;
  } else {
    return null;
  }

  return VN_MOBILE_E164_REGEX.test(e164) ? e164 : null;
}

/** Chuyển số SĐT Việt Nam bất kỳ về dạng 10 số nội địa (`0912345678`) để tương thích UserRepository. */
export function vnPhoneToLocal(rawOrE164: string): string | null {
  const e164 = normalizeVnPhone(rawOrE164);
  if (!e164) return null;
  return `0${e164.slice(3)}`;
}

/** Che số điện thoại E.164 an toàn khi trả về UI (`+84 912 *** 678`). */
export function maskVnPhone(rawOrE164: string): string {
  const e164 = normalizeVnPhone(rawOrE164);
  if (!e164) return '***';
  const subscriber = e164.slice(3); // 9 chữ số: 912345678
  return `+84 ${subscriber.slice(0, 3)} *** ${subscriber.slice(-3)}`;
}

/** Phân tích đầy đủ SĐT Việt Nam sang `{ e164, local, masked }` hoặc `null`. */
export function parseVnPhone(rawPhone: string): ParsedVnPhone | null {
  const e164 = normalizeVnPhone(rawPhone);
  if (!e164) return null;
  return {
    e164,
    local: `0${e164.slice(3)}`,
    masked: maskVnPhone(e164),
  };
}

/** Chuẩn hóa SĐT Việt Nam hoặc ném lỗi HTTP 400 tường minh. */
export function requireVnPhone(rawPhone: string): ParsedVnPhone {
  const parsed = parseVnPhone(rawPhone);
  if (!parsed) {
    throw badRequest(
      'Số điện thoại Việt Nam không hợp lệ. Vui lòng nhập đúng 10 số di động thuộc đầu số 03, 05, 07, 08 hoặc 09 (ví dụ: 0912 345 678).',
      'invalid_phone',
    );
  }
  return parsed;
}
