import { ArrowLeft, Lock, Navigation, Radio, ShieldCheck, Siren } from 'lucide-react';
import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import type { AuthSession } from '@shared/types';
import { Logo } from '../../components/Logo';
import { Spinner } from '../../components/ui';
import { api, ApiError, NetworkError } from '../../lib/api';
import { authStore, useSession } from '../../lib/authStore';
import { useToast } from '../../state/toast';

const QUICK_TEAMS = [
  { code: 'CUUHO-01', area: 'Trung tâm (P. Trấn Biên & Biên Hòa)' },
  { code: 'CUUHO-CD-01', area: 'Cơ động Liên khu vực Toàn TP. Đồng Nai' },
  { code: 'CUUHO-LT-01', area: 'Nam Đồng Nai (Long Thành - Nhơn Trạch)' },
  { code: 'CUUHO-BP-01', area: 'Bắc Đồng Nai (Bình Phước - QL13/QL14)' },
] as const;

export default function RescueLoginPage() {
  const nav = useNavigate();
  const toast = useToast();
  const session = useSession();

  const [identifier, setIdentifier] = useState('CUUHO-01');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (
    session?.user &&
    (session.user.role === 'rescue_team' ||
      session.user.role === 'city_admin' ||
      session.user.role === 'super_admin')
  ) {
    return <Navigate to="/rescue" replace />;
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const s = await api<AuthSession>('/api/auth/rescue/login', {
        method: 'POST',
        body: { identifier: identifier.trim(), password },
      });
      authStore.set(s);
      toast('success', `Đăng nhập tác chiến: ${s.user.name}`);
      nav('/rescue', { replace: true });
    } catch (error) {
      if (error instanceof NetworkError) {
        setErr('Không kết nối được máy chủ điều phối. Kiểm tra kết nối mạng 4G/Wi-Fi.');
      } else if (error instanceof ApiError) {
        setErr(error.message);
      } else {
        setErr('Đăng nhập thất bại, vui lòng kiểm tra lại Mã Đội Cứu Hộ và mật khẩu.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-dvh max-w-md flex-col px-4 py-5">
        <div className="flex items-center justify-between">
          <Link to="/" aria-label="Về trang chủ">
            <Logo dark />
          </Link>
          <Link
            to="/auth"
            className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900 px-3 text-xs font-semibold text-slate-300 hover:border-slate-700"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Cổng Chung
          </Link>
        </div>

        <div className="mt-6 rounded-2xl border border-rose-500/40 bg-slate-900/95 p-5 shadow-2xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-rose-500/50 bg-rose-500/15 px-3 py-1 text-[11px] font-extrabold uppercase tracking-wider text-rose-300">
            <Siren className="h-3.5 w-3.5 animate-pulse" aria-hidden />
            CỔNG TÁC CHIẾN HIỆN TRƯỜNG 24/7
          </div>

          <h1 className="mt-3 text-xl font-extrabold leading-snug text-white">
            Đăng nhập Đội Cứu Hộ & Ứng Cứu Khẩn Cấp
          </h1>
          <p className="mt-1 text-sm leading-relaxed text-slate-400">
            Nhận lệnh điều động ưu tiên SOS từ AI Brain, dẫn đường trực tiếp tới địa chỉ sự cố và nghiệm thu Trước/Sau ngay tại thực địa.
          </p>

          {/* Chọn nhanh mã đội trực chiến */}
          <div className="mt-4 space-y-1.5">
            <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
              Chọn nhanh đơn vị trực chiến:
            </p>
            <div className="grid gap-1.5">
              {QUICK_TEAMS.map((team) => (
                <button
                  key={team.code}
                  type="button"
                  onClick={() => {
                    setIdentifier(team.code);
                    setErr(null);
                  }}
                  className={`flex min-h-11 items-center justify-between rounded-xl border px-3 py-2 text-left text-xs transition-colors ${
                    identifier.toUpperCase() === team.code
                      ? 'border-cyan-400 bg-cyan-500/15 text-white'
                      : 'border-slate-800 bg-slate-950/70 text-slate-300 hover:border-slate-700'
                  }`}
                >
                  <span className="min-w-0 truncate pr-2 font-semibold">{team.area}</span>
                  <span className="mono shrink-0 rounded bg-slate-800 px-2 py-0.5 text-[11px] font-bold text-cyan-300">
                    {team.code}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <form className="mt-4 space-y-3.5" onSubmit={(e) => void submit(e)}>
            <div>
              <label
                htmlFor="rescue-id"
                className="mb-1 block text-xs font-bold uppercase tracking-wider text-slate-300"
              >
                Mã Đội Cứu Hộ hoặc Email công vụ
              </label>
              <input
                id="rescue-id"
                className="mono min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 text-sm font-bold text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                autoComplete="username"
                placeholder="CUUHO-01"
                required
              />
            </div>

            <div>
              <label
                htmlFor="rescue-pw"
                className="mb-1 block text-xs font-bold uppercase tracking-wider text-slate-300"
              >
                Mật khẩu Tác chiến
              </label>
              <input
                id="rescue-pw"
                type="password"
                className="min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 text-sm text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="Nhập mật khẩu đội cứu hộ…"
                required
              />
            </div>

            <button
              type="submit"
              disabled={busy || !identifier.trim() || !password}
              className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-rose-600 px-4 text-sm font-extrabold text-white shadow-lg transition-transform active:scale-[0.98] hover:bg-rose-500 disabled:opacity-50"
            >
              {busy ? <Spinner className="h-4 w-4" /> : <Lock className="h-4 w-4" aria-hidden />}
              Vào Trung Tâm Điều Phối Cứu Hộ
            </button>
          </form>

          {err && (
            <p
              role="alert"
              className="mt-3 rounded-xl border border-rose-500/60 bg-rose-500/15 p-3 text-xs font-semibold text-rose-200"
            >
              {err}
            </p>
          )}

          <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-[11px] text-slate-400">
            <p className="flex items-center gap-1.5">
              <Navigation className="h-3.5 w-3.5 shrink-0 text-cyan-400" aria-hidden />
              Chỉ đường 1 chạm tới hiện trường
            </p>
            <p className="flex items-center gap-1.5">
              <Radio className="h-3.5 w-3.5 shrink-0 text-rose-400" aria-hidden />
              Ưu tiên AI SOS & $nearSphere
            </p>
            <p className="col-span-2 flex items-center gap-1.5 text-slate-400">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden />
              Mật khẩu khởi tạo chuẩn từ biến môi trường <span className="mono text-slate-300">INITIAL_STAFF_PASSWORD</span>.
            </p>
          </div>
        </div>

        <p className="mt-auto pt-6 text-center text-xs text-slate-500">
          SmartCitizen Đồng Nai · Hệ thống Điều phối Ứng cứu Đô thị Thông minh
        </p>
      </div>
    </div>
  );
}
