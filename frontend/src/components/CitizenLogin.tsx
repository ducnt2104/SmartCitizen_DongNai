import type { AuthSession } from '@shared/types';
import { CitizenAuthForm } from './auth';

/**
 * Xác thực Công dân Đa kênh (Số điện thoại Việt Nam +84 | Email OTP | Mật khẩu).
 * Tái xuất từ `components/auth/CitizenAuthForm` để giữ nguyên 100% tương thích cho `AuthPage` và `AuthGateProvider`.
 */
export function CitizenLogin({
  onDone,
  compact = false,
}: {
  onDone: (s: AuthSession) => void;
  compact?: boolean;
}) {
  return <CitizenAuthForm onDone={onDone} compact={compact} />;
}
