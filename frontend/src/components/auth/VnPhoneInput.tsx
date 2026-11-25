import { CheckCircle2, AlertCircle } from 'lucide-react';

export interface VnPhoneValidationResult {
  isEmpty: boolean;
  isValid: boolean;
  e164: string | null;
  formattedDisplay: string | null;
  errorMessage: string | null;
}

/**
 * Kiểm tra & chuẩn hóa SĐT di động Việt Nam ngay khi người dân gõ trên giao diện:
 * - Chấp nhận `0912345678`, `912345678`, `84912345678`, `+84912345678`, khoảng trắng / `-` / `.`.
 * - Chỉ chấp nhận đầu số di động VN hợp lệ: `03`, `05`, `07`, `08`, `09` (đủ 10 chữ số nội địa).
 */
export function validateVnPhoneLive(raw: string): VnPhoneValidationResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      isEmpty: true,
      isValid: false,
      e164: null,
      formattedDisplay: null,
      errorMessage: null,
    };
  }

  if (!/^\+?[\d\s.\-()]+$/.test(trimmed)) {
    return {
      isEmpty: false,
      isValid: false,
      e164: null,
      formattedDisplay: null,
      errorMessage: 'Số điện thoại chỉ được chứa chữ số (không nhập chữ cái hoặc ký tự lạ).',
    };
  }

  const cleaned = trimmed.replace(/[\s.\-()]/g, '');
  if (cleaned.slice(1).includes('+')) {
    return {
      isEmpty: false,
      isValid: false,
      e164: null,
      formattedDisplay: null,
      errorMessage: 'Định dạng mã quốc gia +84 không hợp lệ.',
    };
  }

  let subscriber = '';
  if (cleaned.startsWith('+84')) {
    const rest = cleaned.slice(3);
    subscriber = rest.startsWith('0') ? rest.slice(1) : rest;
  } else if (cleaned.startsWith('84') && cleaned.length >= 10) {
    subscriber = cleaned.slice(2);
  } else if (cleaned.startsWith('0')) {
    subscriber = cleaned.slice(1);
  } else {
    subscriber = cleaned;
  }

  if (subscriber.length > 0 && !/^[35789]/.test(subscriber)) {
    return {
      isEmpty: false,
      isValid: false,
      e164: null,
      formattedDisplay: null,
      errorMessage: 'Đầu số di động Việt Nam phải bắt đầu bằng 03, 05, 07, 08 hoặc 09.',
    };
  }

  if (subscriber.length < 9) {
    return {
      isEmpty: false,
      isValid: false,
      e164: null,
      formattedDisplay: null,
      errorMessage: `Cần nhập thêm ${9 - subscriber.length} chữ số nữa (đủ 10 số di động VN).`,
    };
  }

  if (subscriber.length > 9) {
    return {
      isEmpty: false,
      isValid: false,
      e164: null,
      formattedDisplay: null,
      errorMessage: 'Số điện thoại đang thừa chữ số (chuẩn di động VN gồm đúng 10 số).',
    };
  }

  const e164 = `+84${subscriber}`;
  const formattedDisplay = `+84 ${subscriber.slice(0, 3)} ${subscriber.slice(3, 6)} ${subscriber.slice(6)}`;
  return {
    isEmpty: false,
    isValid: true,
    e164,
    formattedDisplay,
    errorMessage: null,
  };
}

function VietnamFlagIcon() {
  return (
    <svg
      width="22"
      height="15"
      viewBox="0 0 30 20"
      aria-hidden="true"
      className="shrink-0 rounded-[3px] shadow-sm ring-1 ring-black/10"
    >
      <rect width="30" height="20" fill="#DA251D" />
      <polygon
        fill="#FFFF00"
        points="15,4 16.47,8.52 21.22,8.52 17.38,11.31 18.85,15.83 15,13.04 11.15,15.83 12.62,11.31 8.78,8.52 13.53,8.52"
      />
    </svg>
  );
}

export interface VnPhoneInputProps {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}

/**
 * Ô nhập Số điện thoại di động Việt Nam kèm Quốc kỳ +84 và kiểm tra hợp lệ tức thì khi gõ.
 */
export function VnPhoneInput({
  id = 'vn-phone-input',
  value,
  onChange,
  disabled = false,
  autoFocus = false,
}: VnPhoneInputProps) {
  const check = validateVnPhoneLive(value);

  return (
    <div className="space-y-1.5">
      <div
        className={`flex min-h-12 items-stretch overflow-hidden rounded-xl border bg-surface transition focus-within:ring-2 ${
          !check.isEmpty && !check.isValid
            ? 'border-danger/70 focus-within:border-danger focus-within:ring-danger/20'
            : check.isValid
              ? 'border-ok/70 focus-within:border-ok focus-within:ring-ok/20'
              : 'border-line focus-within:border-brand focus-within:ring-brand/20'
        }`}
      >
        <div
          className="flex shrink-0 select-none items-center gap-1.5 border-r border-line bg-surface-2 px-3 font-mono text-sm font-bold text-ink"
          title="Mã vùng điện thoại Việt Nam (+84)"
        >
          <VietnamFlagIcon />
          <span>+84</span>
        </div>
        <input
          id={id}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="0912 345 678"
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          maxLength={20}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={!check.isEmpty && !check.isValid}
          className="min-w-0 flex-1 bg-transparent px-3 font-mono text-base font-semibold tracking-wide text-ink outline-none placeholder:font-sans placeholder:font-normal placeholder:text-muted/70 disabled:opacity-60"
        />
      </div>

      {check.isEmpty && (
        <p className="text-xs text-muted">
          Hỗ trợ đầu số di động <span className="font-mono font-semibold">03, 05, 07, 08, 09</span> (10 chữ số).
        </p>
      )}
      {!check.isEmpty && check.errorMessage && (
        <p className="flex items-center gap-1 text-xs font-medium text-danger" role="status">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{check.errorMessage}</span>
        </p>
      )}
      {check.isValid && check.formattedDisplay && (
        <p className="flex items-center gap-1 text-xs font-semibold text-ok" role="status">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>SĐT hợp lệ: {check.formattedDisplay}</span>
        </p>
      )}
    </div>
  );
}
