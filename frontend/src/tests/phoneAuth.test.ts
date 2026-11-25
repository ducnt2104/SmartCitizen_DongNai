import { describe, expect, it } from 'vitest';
import { validateVnPhoneLive } from '../components/auth/VnPhoneInput';

describe('validateVnPhoneLive (Frontend Live VN Phone Validator)', () => {
  it('xác nhận hợp lệ các định dạng SĐT di động Việt Nam và hiển thị +84 chuẩn', () => {
    const a = validateVnPhoneLive('0912 345 678');
    expect(a.isValid).toBe(true);
    expect(a.e164).toBe('+84912345678');
    expect(a.formattedDisplay).toBe('+84 912 345 678');

    const b = validateVnPhoneLive('+84-388.123.456');
    expect(b.isValid).toBe(true);
    expect(b.e164).toBe('+84388123456');

    const c = validateVnPhoneLive('909111222');
    expect(c.isValid).toBe(true);
    expect(c.e164).toBe('+84909111222');
  });

  it('cảnh báo tức thì khi sai đầu số hoặc thiếu chữ số', () => {
    const landline = validateVnPhoneLive('0283811223');
    expect(landline.isValid).toBe(false);
    expect(landline.errorMessage).toContain('03, 05, 07, 08 hoặc 09');

    const shortNum = validateVnPhoneLive('091234');
    expect(shortNum.isValid).toBe(false);
    expect(shortNum.errorMessage).toContain('Cần nhập thêm');
  });
});
