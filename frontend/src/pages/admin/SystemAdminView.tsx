import {
  Database,
  Edit3,
  KeyRound,
  Lock,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sliders,
  Trash2,
  Unlock,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { normalizeRole, toRoleCode } from '@shared/constants';
import type { DynamicAiConfig, Role, UserProfile } from '@shared/types';
import { Spinner } from '../../components/ui';
import { DONG_NAI_WARDS, WARD_BY_CODE } from '../../data/dongNaiWards';
import { purgeLocalSeedReports } from '../../db/hydrate';
import { api, ApiError, NetworkError } from '../../lib/api';
import { useSession } from '../../lib/authStore';
import { useToast } from '../../state/toast';

const WARDS_PHUONG = DONG_NAI_WARDS.filter((w) => w.kind === 'Phường');
const WARDS_XA = DONG_NAI_WARDS.filter((w) => w.kind === 'Xã');

const ROLE_OPTIONS: Array<{ value: Role; code: string; label: string }> = [
  { value: 'admin', code: 'ADMIN', label: 'ADMIN — Quản trị viên hệ thống' },
  { value: 'officer', code: 'OFFICER', label: 'OFFICER — Cán bộ xử lý (Phường/Xã hoặc Toàn TP)' },
  { value: 'rescue', code: 'RESCUE', label: 'RESCUE — Đội cứu hộ hiện trường' },
  { value: 'citizen', code: 'CITIZEN', label: 'CITIZEN — Người dân' },
];

interface AiConfigPayload {
  config: DynamicAiConfig;
  engines: {
    db: {
      ok: boolean;
      counts: {
        reports: number;
        users: number;
      };
    };
  };
}

interface PurgeSeedResponse {
  ok: boolean;
  deletedReports: number;
  deletedIncidents: number;
  remainingReports: number;
  remainingUsers: number;
}

export function SystemAdminView() {
  const toast = useToast();
  const session = useSession();
  const me = session?.user;

  // ── Cấu hình AI & Dữ liệu hệ thống ──
  const [cfgDraft, setCfgDraft] = useState<DynamicAiConfig | null>(null);
  const [dbCounts, setDbCounts] = useState<{ reports: number; users: number } | null>(null);
  const [savingCfg, setSavingCfg] = useState(false);
  const [purging, setPurging] = useState(false);

  // ── Quản lý Tài khoản 4 Vai trò ──
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [q, setQ] = useState('');
  const [filterRole, setFilterRole] = useState('');
  const [filterWard, setFilterWard] = useState('');
  const [filterActive, setFilterActive] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  // Modals: Create / Edit / Reset Password
  const [createOpen, setCreateOpen] = useState(false);
  const [cName, setCName] = useState('');
  const [cRole, setCRole] = useState<Role>('officer');
  const [cWard, setCWard] = useState(WARDS_PHUONG[0]?.wardCode ?? 'DN-TB');
  const [cStaffCode, setCStaffCode] = useState('');
  const [cEmail, setCEmail] = useState('');
  const [cPhone, setCPhone] = useState('');
  const [cPassword, setCPassword] = useState('');

  const [editTarget, setEditTarget] = useState<UserProfile | null>(null);
  const [eName, setEName] = useState('');
  const [eRole, setERole] = useState<Role>('citizen');
  const [eWard, setEWard] = useState('');
  const [eStaffCode, setEStaffCode] = useState('');
  const [eEmail, setEEmail] = useState('');

  const [pwTarget, setPwTarget] = useState<UserProfile | null>(null);
  const [newPw, setNewPw] = useState('');

  const showErr = useCallback(
    (err: unknown) => {
      toast(
        'error',
        'Thao tác không thực hiện được',
        err instanceof ApiError ? err.message : err instanceof NetworkError ? 'Mất kết nối máy chủ' : String(err),
      );
    },
    [toast],
  );

  const loadConfig = useCallback(async () => {
    try {
      const data = await api<AiConfigPayload>('/api/admin/ai-config');
      setCfgDraft(data.config);
      setDbCounts(data.engines.db.counts);
    } catch (e) {
      showErr(e);
    }
  }, [showErr]);

  const loadUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const params = new URLSearchParams();
      if (filterRole) params.set('role', filterRole);
      if (filterWard) params.set('wardCode', filterWard);
      if (filterActive) params.set('isActive', filterActive);
      if (q.trim()) params.set('q', q.trim());
      const qs = params.toString();
      const data = await api<UserProfile[]>(`/api/admin/users${qs ? `?${qs}` : ''}`);
      setUsers(data);
    } catch (e) {
      showErr(e);
    } finally {
      setLoadingUsers(false);
    }
  }, [filterRole, filterWard, filterActive, q, showErr]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const saveAiConfig = async (): Promise<void> => {
    if (!cfgDraft) return;
    setSavingCfg(true);
    try {
      const saved = await api<DynamicAiConfig>('/api/admin/ai-config', {
        method: 'PATCH',
        body: {
          screenshotThreshold: cfgDraft.screenshotThreshold,
          duplicateThreshold: cfgDraft.duplicateThreshold,
          minKeypointInliers: cfgDraft.minKeypointInliers,
          sceneMatchThreshold: cfgDraft.sceneMatchThreshold,
          resolutionThreshold: cfgDraft.resolutionThreshold,
          allowCloudFallback: cfgDraft.allowCloudFallback,
        },
      });
      setCfgDraft(saved);
      toast('success', 'Đã lưu cấu hình kiểm định hình ảnh AI');
      void loadConfig();
    } catch (e) {
      showErr(e);
    } finally {
      setSavingCfg(false);
    }
  };

  const handlePurgeSeedData = async (): Promise<void> => {
    if (
      !window.confirm(
        'Xác nhận xóa toàn bộ hồ sơ khởi tạo tự động khỏi cơ sở dữ liệu? Danh mục 95 Phường/Xã và các hồ sơ người dân gửi sẽ được giữ nguyên.',
      )
    ) {
      return;
    }
    setPurging(true);
    try {
      const res = await api<PurgeSeedResponse>('/api/admin/maintenance/purge-seed', {
        method: 'POST',
        body: {},
      });
      await purgeLocalSeedReports();
      toast(
        'success',
        `Đã làm sạch ${res.deletedReports + res.deletedIncidents} bản ghi khởi tạo`,
        `Hiện còn ${res.remainingReports} phản ánh và ${res.remainingUsers} tài khoản trên hệ thống.`,
      );
      await Promise.all([loadConfig(), loadUsers()]);
    } catch (e) {
      showErr(e);
    } finally {
      setPurging(false);
    }
  };

  const submitCreate = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusyId('create');
    try {
      const created = await api<UserProfile>('/api/admin/users', {
        method: 'POST',
        body: {
          name: cName.trim(),
          role: cRole,
          wardCode: cRole === 'admin' ? null : cWard || null,
          staffCode: cStaffCode.trim() || null,
          email: cEmail.trim() || null,
          phone: cPhone.trim() || null,
          ...(cPassword ? { password: cPassword } : {}),
        },
      });
      setUsers((prev) => [created, ...prev]);
      setCreateOpen(false);
      setCName('');
      setCStaffCode('');
      setCEmail('');
      setCPhone('');
      setCPassword('');
      toast('success', `Đã tạo tài khoản ${created.name} (${created.roleCode ?? toRoleCode(created.role)})`);
    } catch (err) {
      showErr(err);
    } finally {
      setBusyId(null);
    }
  };

  const openEdit = (u: UserProfile): void => {
    setEditTarget(u);
    setEName(u.name);
    setERole(normalizeRole(u.role));
    setEWard(u.wardCode ?? '');
    setEStaffCode(u.staffCode ?? '');
    setEEmail(u.email ?? '');
  };

  const submitEdit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!editTarget) return;
    setBusyId(`edit-${editTarget.id}`);
    try {
      const updated = await api<UserProfile>(`/api/admin/users/${editTarget.id}`, {
        method: 'PATCH',
        body: {
          name: eName.trim(),
          role: eRole,
          wardCode: eWard || null,
          staffCode: eStaffCode.trim() || null,
          email: eEmail.trim() || null,
        },
      });
      setUsers((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      setEditTarget(null);
      toast('success', `Đã cập nhật phân quyền cho ${updated.name}`);
    } catch (err) {
      showErr(err);
    } finally {
      setBusyId(null);
    }
  };

  const toggleActive = async (u: UserProfile): Promise<void> => {
    const nextActive = Boolean(u.revoked);
    setBusyId(`lock-${u.id}`);
    try {
      const updated = await api<UserProfile>(`/api/admin/users/${u.id}`, {
        method: 'PATCH',
        body: { isActive: nextActive },
      });
      setUsers((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      toast('success', nextActive ? `Đã mở khóa tài khoản ${u.name}` : `Đã khóa tài khoản & thu hồi phiên của ${u.name}`);
    } catch (err) {
      showErr(err);
    } finally {
      setBusyId(null);
    }
  };

  const submitResetPassword = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!pwTarget) return;
    setBusyId(`pw-${pwTarget.id}`);
    try {
      await api(`/api/admin/users/${pwTarget.id}/reset-password`, {
        method: 'POST',
        body: { newPassword: newPw },
      });
      toast('success', `Đã đặt lại mật khẩu và đăng xuất mọi phiên cũ của ${pwTarget.name}`);
      setPwTarget(null);
      setNewPw('');
    } catch (err) {
      showErr(err);
    } finally {
      setBusyId(null);
    }
  };

  const removeUser = async (u: UserProfile): Promise<void> => {
    if (!window.confirm(`Xác nhận xóa vĩnh viễn tài khoản "${u.name}" (${u.staffCode ?? u.email ?? u.id})?`)) return;
    setBusyId(`del-${u.id}`);
    try {
      await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
      setUsers((prev) => prev.filter((x) => x.id !== u.id));
      toast('success', `Đã xóa tài khoản ${u.name}`);
    } catch (err) {
      showErr(err);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* ── 1. Quản lý Tài khoản & Phân quyền 4 Vai trò Chuẩn ── */}
      <section className="ioc-panel overflow-hidden" aria-label="Quản lý Tài khoản & Phân quyền">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ioc-line p-3.5">
          <div>
            <h2 className="text-xs font-bold uppercase tracking-wider text-ioc-cyan">
              Quản lý Tài khoản & Phân quyền ({users.length} tài khoản)
            </h2>
            <p className="mt-0.5 text-xs text-ioc-dim">
              Hệ thống 4 vai trò chuẩn: ADMIN (Quản trị viên) · OFFICER (Cán bộ xử lý) · RESCUE (Đội cứu hộ) · CITIZEN (Người dân)
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="ioc-btn" onClick={() => void loadUsers()}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Tải lại
            </button>
            <button type="button" className="ioc-btn ioc-btn-cyan" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden /> Tạo tài khoản mới
            </button>
          </div>
        </div>

        {/* Bộ lọc tìm kiếm */}
        <div className="grid gap-2 border-b border-ioc-line bg-ioc-raised/30 p-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ioc-dim" aria-hidden />
            <input
              className="ioc-field w-full !pl-8"
              placeholder="Tìm tên, mã tài khoản, email, SĐT…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <select className="ioc-field" value={filterRole} onChange={(e) => setFilterRole(e.target.value)} aria-label="Lọc theo vai trò">
            <option value="">Tất cả 4 vai trò</option>
            {ROLE_OPTIONS.map((r) => (
              <option key={r.value} value={r.code}>{r.label}</option>
            ))}
          </select>
          <select className="ioc-field" value={filterWard} onChange={(e) => setFilterWard(e.target.value)} aria-label="Lọc theo Phường/Xã">
            <option value="">Toàn bộ 95 Phường/Xã</option>
            <optgroup label="33 Phường">
              {WARDS_PHUONG.map((w) => <option key={w.wardCode} value={w.wardCode}>{w.name}</option>)}
            </optgroup>
            <optgroup label="62 Xã">
              {WARDS_XA.map((w) => <option key={w.wardCode} value={w.wardCode}>{w.name}</option>)}
            </optgroup>
          </select>
          <select className="ioc-field" value={filterActive} onChange={(e) => setFilterActive(e.target.value)} aria-label="Lọc theo trạng thái">
            <option value="">Mọi trạng thái</option>
            <option value="true">Đang hoạt động</option>
            <option value="false">Đã khóa</option>
          </select>
        </div>

        {loadingUsers ? (
          <div className="flex justify-center p-6"><Spinner /></div>
        ) : (
          <div className="max-h-[58dvh] overflow-auto">
            <table className="w-full min-w-[54rem] text-xs">
              <thead className="sticky top-0 bg-ioc-panel">
                <tr className="border-b border-ioc-line">
                  <th className="ioc-th">Họ tên / Định danh</th>
                  <th className="ioc-th">Vai trò</th>
                  <th className="ioc-th">Đơn vị / Địa bàn</th>
                  <th className="ioc-th">Điểm uy tín</th>
                  <th className="ioc-th">Trạng thái</th>
                  <th className="ioc-th text-right">Thao tác quản trị</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isSelf = u.id === me?.id;
                  const role = normalizeRole(u.role);
                  const badgeCode = u.roleCode ?? toRoleCode(role);
                  return (
                    <tr key={u.id} className="border-b border-ioc-line/60 hover:bg-ioc-raised/60">
                      <td className="px-3 py-2">
                        <p className="font-semibold text-ioc-text">
                          {u.name} {isSelf && <span className="mono text-[10px] text-ioc-cyan">(Đang đăng nhập)</span>}
                        </p>
                        <p className="mono text-[11px] text-ioc-dim">
                          {u.staffCode ? `${u.staffCode} · ` : ''}
                          {u.email ?? u.phoneMasked ?? u.id}
                        </p>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`mono inline-block rounded border px-2 py-0.5 text-[10px] font-bold ${
                            role === 'admin'
                              ? 'border-cyan-400/50 bg-cyan-500/15 text-ioc-cyan'
                              : role === 'rescue'
                                ? 'border-rose-400/50 bg-rose-500/15 text-rose-300'
                                : role === 'officer'
                                  ? 'border-amber-400/50 bg-amber-500/15 text-ioc-amber'
                                  : 'border-ioc-line text-ioc-dim'
                          }`}
                        >
                          {badgeCode}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-ioc-dim">
                        {u.wardCode ? `${WARD_BY_CODE[u.wardCode]?.name ?? u.wardCode} (${u.wardCode})` : 'Toàn TP. Đồng Nai'}
                      </td>
                      <td className="mono px-3 py-2">{u.trustScore}</td>
                      <td className="px-3 py-2">
                        <span className={`mono font-semibold ${u.revoked ? 'text-ioc-red' : 'text-ioc-green'}`}>
                          {u.revoked ? 'ĐÃ KHÓA' : 'HOẠT ĐỘNG'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="inline-flex flex-wrap justify-end gap-1">
                          <button
                            type="button"
                            className="ioc-btn !min-h-7 !px-2 !text-xs"
                            disabled={busyId !== null}
                            onClick={() => openEdit(u)}
                            title="Sửa thông tin & phân quyền"
                          >
                            <Edit3 className="h-3.5 w-3.5" aria-hidden /> Sửa
                          </button>
                          <button
                            type="button"
                            className="ioc-btn !min-h-7 !px-2 !text-xs"
                            disabled={busyId !== null}
                            onClick={() => { setPwTarget(u); setNewPw(''); }}
                            title="Đặt lại mật khẩu"
                          >
                            <KeyRound className="h-3.5 w-3.5" aria-hidden /> Mật khẩu
                          </button>
                          <button
                            type="button"
                            className={`ioc-btn !min-h-7 !px-2 !text-xs ${u.revoked ? 'ioc-btn-green' : 'ioc-btn-red'}`}
                            disabled={isSelf || busyId !== null}
                            onClick={() => void toggleActive(u)}
                            title={isSelf ? 'Không thể tự khóa tài khoản đang đăng nhập' : undefined}
                          >
                            {u.revoked ? <Unlock className="h-3.5 w-3.5" aria-hidden /> : <Lock className="h-3.5 w-3.5" aria-hidden />}
                            {u.revoked ? 'Mở khóa' : 'Khóa'}
                          </button>
                          {!isSelf && (
                            <button
                              type="button"
                              className="ioc-btn ioc-btn-red !min-h-7 !px-2 !text-xs"
                              disabled={busyId !== null}
                              onClick={() => void removeUser(u)}
                              title="Xóa tài khoản"
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── 2. Cấu hình Ngưỡng Kiểm định Hình ảnh AI ── */}
      {cfgDraft && (
        <section className="ioc-panel p-3.5" aria-label="Cấu hình kiểm định hình ảnh AI">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-ioc-cyan">
                <Sliders className="h-4 w-4" aria-hidden /> Cấu hình Kiểm định Hình ảnh & Nghiệm thu Tự động
              </h2>
              <p className="mt-0.5 text-xs text-ioc-dim">
                Điều chỉnh ngưỡng lọc ảnh chụp lại màn hình, phát hiện trùng lặp và đối chiếu Trước – Sau xử lý
              </p>
            </div>
            <button type="button" className="ioc-btn ioc-btn-cyan" disabled={savingCfg} onClick={() => void saveAiConfig()}>
              {savingCfg ? <Spinner /> : <Save className="h-3.5 w-3.5" aria-hidden />} Lưu cấu hình
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block text-xs">
              <span className="text-ioc-dim">Chặn ảnh màn hình (&lt; điểm):</span>{' '}
              <strong className="mono text-ioc-cyan">{cfgDraft.screenshotThreshold}</strong>
              <input
                type="range"
                min={25}
                max={85}
                value={cfgDraft.screenshotThreshold}
                onChange={(e) => setCfgDraft({ ...cfgDraft, screenshotThreshold: Number(e.target.value) })}
                className="mt-1 w-full accent-cyan-400"
              />
            </label>
            <label className="block text-xs">
              <span className="text-ioc-dim">Ngưỡng phát hiện ảnh trùng:</span>{' '}
              <strong className="mono text-ioc-cyan">{cfgDraft.duplicateThreshold}</strong>
              <input
                type="range"
                min={2}
                max={16}
                value={cfgDraft.duplicateThreshold}
                onChange={(e) => setCfgDraft({ ...cfgDraft, duplicateThreshold: Number(e.target.value) })}
                className="mt-1 w-full accent-cyan-400"
              />
            </label>
            <label className="block text-xs">
              <span className="text-ioc-dim">Khớp hiện trường (%):</span>{' '}
              <strong className="mono text-ioc-cyan">{cfgDraft.sceneMatchThreshold}%</strong>
              <input
                type="range"
                min={45}
                max={90}
                value={cfgDraft.sceneMatchThreshold}
                onChange={(e) => setCfgDraft({ ...cfgDraft, sceneMatchThreshold: Number(e.target.value) })}
                className="mt-1 w-full accent-cyan-400"
              />
            </label>
            <label className="block text-xs">
              <span className="text-ioc-dim">Mức độ khắc phục (%):</span>{' '}
              <strong className="mono text-ioc-cyan">{cfgDraft.resolutionThreshold}%</strong>
              <input
                type="range"
                min={50}
                max={92}
                value={cfgDraft.resolutionThreshold}
                onChange={(e) => setCfgDraft({ ...cfgDraft, resolutionThreshold: Number(e.target.value) })}
                className="mt-1 w-full accent-cyan-400"
              />
            </label>
          </div>
          <label className="mt-3 inline-flex items-center gap-2 text-xs text-ioc-dim">
            <input
              type="checkbox"
              checked={cfgDraft.allowCloudFallback}
              onChange={(e) => setCfgDraft({ ...cfgDraft, allowCloudFallback: e.target.checked })}
            />
            Bật phân tích tăng cường qua mô hình ngôn ngữ lớn khi cần suy luận sâu
          </label>
        </section>
      )}

      {/* ── 3. Bảo trì Cơ sở Dữ liệu Vận hành ── */}
      <section className="ioc-panel flex flex-wrap items-center justify-between gap-3 p-3.5" aria-label="Bảo trì cơ sở dữ liệu">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-ioc-cyan">
            <Database className="h-4 w-4" aria-hidden /> Bảo trì Dữ liệu Vận hành
          </h2>
          <p className="mt-0.5 text-xs text-ioc-dim">
            Hiện có <strong className="text-ioc-text">{dbCounts?.reports ?? 0}</strong> hồ sơ phản ánh và{' '}
            <strong className="text-ioc-text">{dbCounts?.users ?? users.length}</strong> tài khoản (giữ nguyên danh mục 95 Phường/Xã TP. Đồng Nai).
          </p>
        </div>
        <button
          type="button"
          className="ioc-btn ioc-btn-red"
          disabled={purging}
          onClick={() => void handlePurgeSeedData()}
        >
          {purging ? <Spinner /> : <Trash2 className="h-3.5 w-3.5" aria-hidden />} Dọn dẹp hồ sơ khởi tạo
        </button>
      </section>

      {/* ── Modal Tạo mới Tài khoản ── */}
      {createOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Tạo tài khoản mới">
          <form onSubmit={(e) => void submitCreate(e)} className="ioc-panel w-full max-w-md space-y-3 p-4">
            <div className="flex items-center justify-between border-b border-ioc-line pb-2">
              <h3 className="text-sm font-bold text-ioc-cyan">Tạo tài khoản Hệ thống mới</h3>
              <button type="button" className="ioc-btn !min-h-7 !px-2" onClick={() => setCreateOpen(false)}><X className="h-4 w-4" /></button>
            </div>
            <div>
              <label className="mb-1 block text-xs text-ioc-dim">Họ và tên *</label>
              <input className="ioc-field w-full" required minLength={2} value={cName} onChange={(e) => setCName(e.target.value)} placeholder="Nguyễn Văn Bình" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-ioc-dim">Vai trò *</label>
              <select className="ioc-field w-full" value={cRole} onChange={(e) => setCRole(e.target.value as Role)}>
                {ROLE_OPTIONS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
            {(cRole === 'officer' || cRole === 'rescue' || cRole === 'citizen') && (
              <div>
                <label className="mb-1 block text-xs text-ioc-dim">
                  Đơn vị Phường/Xã (95 ĐVHC hoặc Toàn TP. Đồng Nai)
                </label>
                <select className="ioc-field w-full" value={cWard} onChange={(e) => setCWard(e.target.value)}>
                  <option value="">Toàn TP. Đồng Nai</option>
                  <optgroup label="33 Phường">{WARDS_PHUONG.map((w) => <option key={w.wardCode} value={w.wardCode}>{w.name}</option>)}</optgroup>
                  <optgroup label="62 Xã">{WARDS_XA.map((w) => <option key={w.wardCode} value={w.wardCode}>{w.name}</option>)}</optgroup>
                </select>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-xs text-ioc-dim">Mã tài khoản (tuỳ chọn)</label>
                <input className="ioc-field mono w-full" value={cStaffCode} onChange={(e) => setCStaffCode(e.target.value)} placeholder="CB-TB-02 / CUUHO-02" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-ioc-dim">Số điện thoại</label>
                <input className="ioc-field mono w-full" value={cPhone} onChange={(e) => setCPhone(e.target.value)} placeholder="09xxxxxxxx" />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs text-ioc-dim">Email</label>
              <input type="email" className="ioc-field w-full" value={cEmail} onChange={(e) => setCEmail(e.target.value)} placeholder="canbo@dongnai.gov.vn" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-ioc-dim">Mật khẩu (≥ 8 ký tự)</label>
              <input
                type="password"
                className="ioc-field w-full"
                minLength={8}
                value={cPassword}
                onChange={(e) => setCPassword(e.target.value)}
                required={cRole === 'admin' || cRole === 'officer' || cRole === 'rescue'}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="ioc-btn" onClick={() => setCreateOpen(false)}>Hủy</button>
              <button type="submit" className="ioc-btn ioc-btn-cyan" disabled={busyId === 'create'}>
                {busyId === 'create' ? <Spinner /> : <Plus className="h-4 w-4" aria-hidden />} Tạo tài khoản
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Modal Chỉnh sửa Tài khoản & Phân quyền ── */}
      {editTarget && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Chỉnh sửa tài khoản">
          <form onSubmit={(e) => void submitEdit(e)} className="ioc-panel w-full max-w-md space-y-3 p-4">
            <div className="flex items-center justify-between border-b border-ioc-line pb-2">
              <h3 className="text-sm font-bold text-ioc-cyan">Chỉnh sửa & Phân quyền: {editTarget.name}</h3>
              <button type="button" className="ioc-btn !min-h-7 !px-2" onClick={() => setEditTarget(null)}><X className="h-4 w-4" /></button>
            </div>
            <div>
              <label className="mb-1 block text-xs text-ioc-dim">Họ và tên</label>
              <input className="ioc-field w-full" required minLength={2} value={eName} onChange={(e) => setEName(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-ioc-dim">Vai trò</label>
              <select className="ioc-field w-full" value={eRole} onChange={(e) => setERole(e.target.value as Role)} disabled={editTarget.id === me?.id}>
                {ROLE_OPTIONS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-ioc-dim">Đơn vị / Phường/Xã phụ trách</label>
              <select className="ioc-field w-full" value={eWard} onChange={(e) => setEWard(e.target.value)}>
                <option value="">Toàn TP. Đồng Nai</option>
                <optgroup label="33 Phường">{WARDS_PHUONG.map((w) => <option key={w.wardCode} value={w.wardCode}>{w.name}</option>)}</optgroup>
                <optgroup label="62 Xã">{WARDS_XA.map((w) => <option key={w.wardCode} value={w.wardCode}>{w.name}</option>)}</optgroup>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-xs text-ioc-dim">Mã tài khoản</label>
                <input className="ioc-field mono w-full" value={eStaffCode} onChange={(e) => setEStaffCode(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-xs text-ioc-dim">Email</label>
                <input type="email" className="ioc-field w-full" value={eEmail} onChange={(e) => setEEmail(e.target.value)} />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="ioc-btn" onClick={() => setEditTarget(null)}>Hủy</button>
              <button type="submit" className="ioc-btn ioc-btn-cyan" disabled={busyId !== null}>
                <Save className="h-4 w-4" aria-hidden /> Lưu thay đổi
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Modal Đặt lại Mật khẩu ── */}
      {pwTarget && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Đặt lại mật khẩu">
          <form onSubmit={(e) => void submitResetPassword(e)} className="ioc-panel w-full max-w-sm space-y-3 p-4">
            <div className="flex items-center justify-between border-b border-ioc-line pb-2">
              <h3 className="text-sm font-bold text-ioc-cyan">Đặt lại mật khẩu: {pwTarget.name}</h3>
              <button type="button" className="ioc-btn !min-h-7 !px-2" onClick={() => setPwTarget(null)}><X className="h-4 w-4" /></button>
            </div>
            <p className="text-xs text-ioc-dim">Mọi phiên đăng nhập hiện hành của tài khoản này sẽ bị thu hồi ngay lập tức.</p>
            <input
              type="password"
              className="ioc-field w-full"
              placeholder="Nhập mật khẩu mới (≥ 8 ký tự)"
              required
              minLength={8}
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <button type="button" className="ioc-btn" onClick={() => setPwTarget(null)}>Hủy</button>
              <button type="submit" className="ioc-btn ioc-btn-cyan" disabled={newPw.length < 8 || busyId !== null}>
                <KeyRound className="h-4 w-4" aria-hidden /> Xác nhận đổi mật khẩu
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
