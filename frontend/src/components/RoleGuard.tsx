import { ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import type { Role } from '@shared/types';
import { authStore, useSession } from '../lib/authStore';

export interface RoleGuardProps {
  allowedRoles: readonly Role[];
  redirectTo?: string;
  children: ReactNode;
}

/**
 * Bảo vệ phân quyền RBAC nghiêm ngặt trên Frontend (Zero-Crash Route Protection):
 * - Chưa đăng nhập -> điều hướng mượt tới cổng đăng nhập tương ứng (`/rescue/login` hoặc `/auth`).
 * - Sai vai trò -> hiển thị thông báo rõ ràng kèm lối tắt về đúng cổng được phân quyền.
 */
export function RoleGuard({ allowedRoles, redirectTo = '/auth', children }: RoleGuardProps) {
  const session = useSession();
  const loc = useLocation();

  if (!session) {
    return <Navigate to={redirectTo} state={{ from: loc.pathname }} replace />;
  }

  const role = session.user.role;
  if (!allowedRoles.includes(role)) {
    const homeForRole =
      role === 'rescue_team'
        ? '/rescue'
        : role === 'super_admin' || role === 'city_admin' || role === 'ward_officer'
          ? '/admin'
          : role === 'volunteer'
            ? '/volunteer'
            : '/';

    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-950 p-4 text-slate-100">
        <div className="w-full max-w-md space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-6 text-center shadow-2xl">
          <ShieldAlert className="mx-auto h-12 w-12 text-amber-400" aria-hidden />
          <h1 className="text-lg font-extrabold leading-snug">
            Tài khoản hiện tại không có quyền truy cập khu vực này
          </h1>
          <p className="text-sm leading-relaxed text-slate-400">
            Bạn đang đăng nhập với tài khoản <strong className="text-white">{session.user.name}</strong> (vai trò{' '}
            <span className="mono text-cyan-400">{session.user.roleCode ?? role.toUpperCase()}</span>).
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Link
              to={homeForRole}
              className="inline-flex min-h-11 items-center justify-center rounded-xl bg-cyan-500 px-4 text-sm font-bold text-slate-950 hover:bg-cyan-400"
            >
              Về cổng của tôi
            </Link>
            <button
              type="button"
              onClick={() => void authStore.signOut()}
              className="inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-700 bg-slate-800 px-4 text-sm font-semibold text-slate-200 hover:bg-slate-700"
            >
              Đổi tài khoản khác
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
