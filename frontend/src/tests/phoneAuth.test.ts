import { describe, expect, it } from 'vitest';
import { validateVnPhoneLive } from '../components/auth/VnPhoneInput';
import { FirebasePhoneAuthError, mapFirebasePhoneError } from '../components/auth/firebasePhoneAuth';

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

describe('mapFirebasePhoneError (Chuẩn hóa lỗi Firebase Phone Auth sang tiếng Việt & fallback)', () => {
  it('ánh xạ auth/operation-not-allowed (chặn vùng SMS +84) kèm gợi ý SMS region policy & Email fallback', () => {
    const rawErr = Object.assign(
      new Error('Firebase: SMS unable to be sent until this region enabled by the app developer. (auth/operation-not-allowed).'),
      { code: 'auth/operation-not-allowed' },
    );
    const mapped = mapFirebasePhoneError(rawErr);
    expect(mapped).toBeInstanceOf(FirebasePhoneAuthError);
    expect(mapped.code).toBe('auth/operation-not-allowed');
    expect(mapped.canFallbackToDirectSms).toBe(true);
    expect(mapped.suggestEmailFallback).toBe(true);
    expect(mapped.message).toContain('Việt Nam (+84)');
    expect(mapped.message).toContain('SMS region policy');
    expect(mapped.message).not.toContain('SMS unable to be sent until this region enabled');
  });

  it('ánh xạ auth/billing-not-enabled, auth/quota-exceeded, auth/unauthorized-domain và auth/too-many-requests', () => {
    const billing = mapFirebasePhoneError({ code: 'auth/billing-not-enabled', message: 'Billing disabled' });
    expect(billing.canFallbackToDirectSms).toBe(true);
    expect(billing.suggestEmailFallback).toBe(true);
    expect(billing.message).toContain('Blaze');

    const quota = mapFirebasePhoneError({ code: 'auth/quota-exceeded', message: 'Quota' });
    expect(quota.canFallbackToDirectSms).toBe(true);
    expect(quota.suggestEmailFallback).toBe(true);

    const domain = mapFirebasePhoneError({ code: 'auth/unauthorized-domain', message: 'Domain' });
    expect(domain.canFallbackToDirectSms).toBe(true);
    expect(domain.suggestEmailFallback).toBe(true);
    expect(domain.message).toContain('Authorized Domains');

    const rate = mapFirebasePhoneError({ code: 'auth/too-many-requests', message: 'Too many' });
    expect(rate.canFallbackToDirectSms).toBe(false);
    expect(rate.suggestEmailFallback).toBe(true);
  });
});
