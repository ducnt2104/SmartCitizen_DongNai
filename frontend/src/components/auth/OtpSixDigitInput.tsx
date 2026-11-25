import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react';

export interface OtpSixDigitInputProps {
  value: string;
  onChange: (nextCode: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  onComplete?: (code: string) => void;
}

/**
 * Ô nhập mã OTP gồm 6 ô số riêng biệt chuẩn Mobile-First:
 * - Hỗ trợ `inputMode="numeric"` và `autoComplete="one-time-code"` (tự gợi ý mã SMS từ bàn phím iOS/Android).
 * - Hỗ trợ dán (Paste) cả chuỗi 6 chữ số hoặc thông báo SMS có chứa 6 chữ số.
 * - Hỗ trợ điều hướng mượt bằng Backspace, phím mũi tên Trái/Phải.
 */
export function OtpSixDigitInput({
  value,
  onChange,
  disabled = false,
  autoFocus = true,
  onComplete,
}: OtpSixDigitInputProps) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const cleanDigits = value.replace(/\D/g, '').slice(0, 6);
  const slots = Array.from({ length: 6 }, (_, idx) => cleanDigits[idx] ?? '');
  const lastCompletedRef = useRef<string>('');

  useEffect(() => {
    if (autoFocus && !disabled) {
      const firstEmpty = Math.min(cleanDigits.length, 5);
      refs.current[firstEmpty]?.focus();
    }
    // Chỉ focus lần đầu khi mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (cleanDigits.length === 6 && cleanDigits !== lastCompletedRef.current) {
      lastCompletedRef.current = cleanDigits;
      onComplete?.(cleanDigits);
    } else if (cleanDigits.length < 6) {
      lastCompletedRef.current = '';
    }
  }, [cleanDigits, onComplete]);

  const applyDigitsFromIndex = (startIndex: number, rawInput: string): void => {
    const incoming = rawInput.replace(/\D/g, '');
    if (!incoming) {
      const next = [...slots];
      next[startIndex] = '';
      onChange(next.join(''));
      return;
    }

    // Nếu bàn phím điện thoại tự động điền cả 6 chữ số vào bất kỳ ô nào -> điền trọn 6 ô
    if (incoming.length >= 6) {
      const full = incoming.slice(0, 6);
      onChange(full);
      refs.current[5]?.focus();
      return;
    }

    const next = [...slots];
    let cursor = startIndex;
    for (const ch of incoming) {
      if (cursor > 5) break;
      next[cursor] = ch;
      cursor += 1;
    }
    onChange(next.join(''));
    const nextFocus = Math.min(cursor, 5);
    refs.current[nextFocus]?.focus();
  };

  const handleKeyDown = (idx: number, e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      const next = [...slots];
      if (next[idx]) {
        next[idx] = '';
        onChange(next.join(''));
      } else if (idx > 0) {
        next[idx - 1] = '';
        onChange(next.join(''));
        refs.current[idx - 1]?.focus();
      }
      return;
    }
    if (e.key === 'ArrowLeft' && idx > 0) {
      e.preventDefault();
      refs.current[idx - 1]?.focus();
      return;
    }
    if (e.key === 'ArrowRight' && idx < 5) {
      e.preventDefault();
      refs.current[idx + 1]?.focus();
    }
  };

  const handlePaste = (idx: number, e: ClipboardEvent<HTMLInputElement>): void => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text') ?? '';
    const allDigits = pasted.replace(/\D/g, '');
    if (!allDigits) return;

    // Ưu tiên trích xuất cụm 6 số OTP liên tiếp nếu người dân copy cả tin nhắn SMS
    const exactSixMatch = pasted.match(/\b(\d{6})\b/);
    if (exactSixMatch) {
      onChange(exactSixMatch[1]);
      refs.current[5]?.focus();
      return;
    }

    if (allDigits.length >= 6) {
      onChange(allDigits.slice(0, 6));
      refs.current[5]?.focus();
      return;
    }

    applyDigitsFromIndex(idx, allDigits);
  };

  return (
    <div className="grid grid-cols-6 gap-2 sm:gap-2.5" role="group" aria-label="Nhập 6 chữ số mã OTP">
      {slots.map((digit, idx) => (
        <input
          key={idx}
          ref={(el) => {
            refs.current[idx] = el;
          }}
          type="text"
          inputMode="numeric"
          pattern="\d*"
          autoComplete={idx === 0 ? 'one-time-code' : 'off'}
          maxLength={idx === 0 ? 6 : 2}
          disabled={disabled}
          value={digit}
          aria-label={`Chữ số OTP thứ ${idx + 1}`}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => applyDigitsFromIndex(idx, e.target.value)}
          onKeyDown={(e) => handleKeyDown(idx, e)}
          onPaste={(e) => handlePaste(idx, e)}
          className={`h-13 min-h-[52px] w-full rounded-xl border text-center font-mono text-xl font-extrabold transition outline-none focus:ring-2 disabled:opacity-60 sm:text-2xl ${
            digit
              ? 'border-brand bg-brand-soft/40 text-brand focus:border-brand focus:ring-brand/25'
              : 'border-line bg-surface text-ink focus:border-brand focus:ring-brand/25'
          }`}
        />
      ))}
    </div>
  );
}
