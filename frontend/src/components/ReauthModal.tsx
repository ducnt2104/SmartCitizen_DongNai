import { KeyRound, ShieldAlert, X } from 'lucide-react';
import { useState } from 'react';
import { Spinner } from './ui';
import { ApiError, authenticateReauth } from '../lib/api';

interface ReauthModalProps {
  open: boolean;
  title?: string;
  description?: string;
  onClose: () => void;
  onVerified: () => Promise<void> | void;
}

/** Modal xác thực lại mật khẩu hiện tại trước khi thực thi thao tác quản trị nhạy cảm. */
export function ReauthModal({
  open,
  title = 'Xác thực lại danh tính quản trị',
  description = 'Thao tác nhạy cảm yêu cầu nhập lại mật khẩu hiện tại để cấp phiên xác thực ngắn hạn.',
  onClose,
  onVerified,
}: ReauthModalProps) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      await authenticateReauth(password);
      setPassword('');
      onClose();
      await onVerified();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Xác thực lại không thành công.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <form onSubmit={(e) => void submit(e)} className="ioc-panel w-full max-w-sm space-y-3 p-4">
        <div className="flex items-center justify-between border-b border-ioc-line pb-2">
          <h3 className="flex items-center gap-1.5 text-sm font-bold text-ioc-amber">
            <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
            {title}
          </h3>
          <button type="button" className="ioc-btn !min-h-7 !px-2" onClick={onClose} aria-label="Đóng">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-xs text-ioc-dim">{description}</p>
        {error && <p className="rounded border border-ioc-red/40 bg-ioc-red/10 px-2.5 py-1.5 text-xs text-ioc-red">{error}</p>}
        <input
          type="password"
          className="ioc-field w-full"
          placeholder="Nhập mật khẩu hiện tại"
          autoFocus
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="ioc-btn" onClick={onClose} disabled={busy}>
            Hủy
          </button>
          <button type="submit" className="ioc-btn ioc-btn-cyan" disabled={busy || !password}>
            {busy ? <Spinner /> : <KeyRound className="h-4 w-4" aria-hidden />} Xác thực & Tiếp tục
          </button>
        </div>
      </form>
    </div>
  );
}
