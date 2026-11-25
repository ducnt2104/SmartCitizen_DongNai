import {
  Activity,
  Cpu,
  Database,
  Edit3,
  KeyRound,
  Lock,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Sliders,
  Trash2,
  Unlock,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { DynamicAiConfig, Role, UserProfile } from '@shared/types';
import { Spinner } from '../../components/ui';
import { DONG_NAI_WARDS, WARD_BY_CODE } from '../../data/dongNaiWards';
import { useI18n } from '../../i18n';
import { api, ApiError, NetworkError } from '../../lib/api';
import { useSession } from '../../lib/authStore';
import { useToast } from '../../state/toast';

const WARDS_PHUONG = DONG_NAI_WARDS.filter((w) => w.kind === 'Phường');
const WARDS_XA = DONG_NAI_WARDS.filter((w) => w.kind === 'Xã');

const ROLE_OPTIONS: Array<{ value: Role; code: string; label: string }> = [
  { value: 'super_admin', code: 'SUPER_ADMIN', label: 'SUPER_ADMIN — Quản trị Tối cao' },
  { value: 'city_admin', code: 'ADMIN', label: 'ADMIN — Quản trị Cấp Thành phố' },
  { value: 'ward_officer', code: 'OFFICER', label: 'OFFICER — Cán bộ Phường/Xã' },
  { value: 'rescue_team', code: 'RESCUE_TEAM', label: 'RESCUE_TEAM — Đội Cứu Hộ Hiện Trường' },
  { value: 'volunteer', code: 'YOUTH_UNION', label: 'YOUTH_UNION — Đoàn viên Tình nguyện' },
  { value: 'citizen', code: 'CITIZEN', label: 'CITIZEN — Người dân' },
];

interface AiMonitorPayload {
  config: DynamicAiConfig;
  engines: {
    cvEngine: {
      online: boolean;
      url: string;
      engine: string;
      latencyMs: number | null;
      indexedFingerprints: number;
      onnxModelPath: string | null;
    };
    localLlm: {
      online: boolean;
      provider: string;
      endpoint: string;
      model: string;
      latencyMs: number | null;
    };
    ragDocs: number;
    db: {
      mode: 'mongodb' | 'json';
      ok: boolean;
      latencyMs: number;
      counts: {
        reports: number;
        users: number;
        fingerprints: number;
        evaluations: number;
        auditLogs: number;
      };
    };
  };
  recentEvaluations: Array<{
    id: string;
    reportId: string;
    kind: string;
    authenticityScore: number | null;
    sceneMatchScore: number | null;
    resolutionScore: number | null;
    inlierCount: number;
    flags: string[];
    engineMode: string;
    latencyMs: number;
    summary: string;
    createdAt: string;
  }>;
}

export function SystemAdminView() {
  const { fmtDate } = useI18n();
  const toast = useToast();
  const session = useSession();
  const me = session?.user;
  const isSuper = me?.role === 'super_admin';

  // ── AI & System Monitor State ──
  const [monitor, setMonitor] = useState<AiMonitorPayload | null>(null);
  const [cfgDraft, setCfgDraft] = useState<DynamicAiConfig | null>(null);
  const [savingCfg, setSavingCfg] = useState(false);

  // ── User Management State ──
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
  const [cRole, setCRole] = useState<Role>('ward_officer');
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

  const loadMonitor = useCallback(async () => {
    try {
      const data = await api<AiMonitorPayload>('/api/admin/ai-config');
      setMonitor(data);
      setCfgDraft(data.config);
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
    void loadMonitor();
  }, [loadMonitor]);

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
      toast('success', 'Đã cập nhật ngưỡng AI động thành công (áp dụng tức thì)');
      void loadMonitor();
    } catch (e) {
      showErr(e);
    } finally {
      setSavingCfg(false);
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
          wardCode:
            cRole === 'ward_officer' || cRole === 'volunteer'
              ? cWard || (WARDS_PHUONG[0]?.wardCode ?? 'DN-TB')
              : cWard || null,
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
      toast('success', `Đã tạo tài khoản ${created.name} (${created.roleCode ?? created.role})`);
    } catch (err) {
      showErr(err);
    } finally {
      setBusyId(null);
    }
  };

  const openEdit = (u: UserProfile): void => {
    setEditTarget(u);
    setEName(u.name);
    setERole(u.role);
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

  const eng = monitor?.engines;

  return (
    <div className="space-y-4">
      {/* ── 1. Trạng thái Hạ tầng Xử lý & Cơ sở dữ liệu ── */}
      <section className="ioc-panel p-3" aria-label="Giám sát hạ tầng xử lý & Cơ sở dữ liệu">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-ioc-cyan">
              <Activity className="h-4 w-4" aria-hidden /> Giám sát Hạ tầng Xử lý Ảnh, Tri thức & Cơ sở dữ liệu
            </h2>
            <p className="text-xs text-ioc-dim">Đo độ trễ kết nối cơ sở dữ liệu, bộ xử lý hình ảnh hiện trường và kho tri thức điều hành</p>
          </div>
          <button type="button" className="ioc-btn" onClick={() => void loadMonitor()}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Làm mới trạng thái
          </button>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          {/* Database Card */}
          <div className="rounded border border-ioc-line bg-ioc-raised/50 p-3">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-bold uppercase text-ioc-dim">
                <Database className="h-4 w-4 text-ioc-cyan" aria-hidden /> Hệ thống Lưu trữ ({eng?.db.mode?.toUpperCase() ?? '…'})
              </span>
              <span className={`mono rounded px-1.5 py-0.5 text-[10px] font-bold ${eng?.db.ok ? 'bg-emerald-500/20 text-ioc-green' : 'bg-red-500/20 text-ioc-red'}`}>
                {eng?.db.ok ? `ONLINE · ${eng.db.latencyMs}ms` : 'DỰ PHÒNG'}
              </span>
            </div>
            <p className="mono mt-2 text-xs text-ioc-text">
              Hồ sơ: <strong>{eng?.db.counts.reports ?? 0}</strong> · Tài khoản: <strong>{eng?.db.counts.users ?? 0}</strong>
            </p>
            <p className="mono mt-1 text-[11px] text-ioc-dim">
              Dấu vân tay ảnh: {eng?.db.counts.fingerprints ?? 0} · Thẩm định: {eng?.db.counts.evaluations ?? 0} · Nhật ký: {eng?.db.counts.auditLogs ?? 0}
            </p>
          </div>

          {/* CV Engine Card */}
          <div className="rounded border border-ioc-line bg-ioc-raised/50 p-3">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-bold uppercase text-ioc-dim">
                <Cpu className="h-4 w-4 text-ioc-cyan" aria-hidden /> Bộ Kiểm định Hình ảnh
              </span>
              <span className={`mono rounded px-1.5 py-0.5 text-[10px] font-bold ${eng?.cvEngine.online ? 'bg-emerald-500/20 text-ioc-green' : 'bg-cyan-500/20 text-ioc-cyan'}`}>
                {eng?.cvEngine.online ? `TỐC ĐỘ CAO · ${eng.cvEngine.latencyMs}ms` : 'XỬ LÝ NỘI BỘ'}
              </span>
            </div>
            <p className="mono mt-2 truncate text-xs text-ioc-text">Kiểm tra EXIF, độ nét & đối chiếu Trước/Sau</p>
            <p className="mono mt-1 truncate text-[11px] text-ioc-dim">
              Bộ nhớ đối chiếu: {eng?.cvEngine.indexedFingerprints ?? 0} ảnh
            </p>
          </div>

          {/* Knowledge Engine Card */}
          <div className="rounded border border-ioc-line bg-ioc-raised/50 p-3">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-bold uppercase text-ioc-dim">
                <ShieldCheck className="h-4 w-4 text-ioc-cyan" aria-hidden /> Trợ lý & Kho Tri thức Đô thị
              </span>
              <span className={`mono rounded px-1.5 py-0.5 text-[10px] font-bold ${eng?.localLlm.online ? 'bg-emerald-500/20 text-ioc-green' : 'bg-cyan-500/20 text-ioc-cyan'}`}>
                {eng?.localLlm.online ? `${eng.localLlm.provider.toUpperCase()} · ${eng.localLlm.latencyMs}ms` : 'SẴN SÀNG TỨC THÌ'}
              </span>
            </div>
            <p className="mono mt-2 truncate text-xs text-ioc-text">Mô hình: {eng?.localLlm.model ?? 'qwen2.5:3b'}</p>
            <p className="mono mt-1 text-[11px] text-ioc-dim">Cơ sở tri thức: {eng?.ragDocs ?? 99} tài liệu (95 ĐVHC + Quy trình)</p>
          </div>
        </div>

        {/* Sliders chỉnh ngưỡng thẩm định động */}
        {cfgDraft && (
          <div className="mt-3 rounded border border-ioc-line p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-ioc-text">
                <Sliders className="h-3.5 w-3.5 text-ioc-cyan" aria-hidden /> Tinh chỉnh Ngưỡng Kiểm định Hình ảnh (Áp dụng tức thì)
              </h3>
              <button type="button" className="ioc-btn ioc-btn-cyan" disabled={savingCfg} onClick={() => void saveAiConfig()}>
                {savingCfg ? <Spinner /> : <Save className="h-3.5 w-3.5" aria-hidden />} Lưu cấu hình
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
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
                <span className="text-ioc-dim">Điểm đặc trưng phát hiện ảnh cắt:</span>{' '}
                <strong className="mono text-ioc-cyan">{cfgDraft.minKeypointInliers}</strong>
                <input
                  type="range"
                  min={10}
                  max={35}
                  value={cfgDraft.minKeypointInliers}
                  onChange={(e) => setCfgDraft({ ...cfgDraft, minKeypointInliers: Number(e.target.value) })}
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
            <label className="mt-2 inline-flex items-center gap-2 text-xs text-ioc-dim">
              <input
                type="checkbox"
                checked={cfgDraft.allowCloudFallback}
                onChange={(e) => setCfgDraft({ ...cfgDraft, allowCloudFallback: e.target.checked })}
              />
              Cho phép kết nối dịch vụ phân tích đám mây dự phòng khi cần suy luận chuyên sâu
            </label>
          </div>
        )}
      </section>

      {/* ── 2. Quản lý Toàn bộ Tài khoản & RBAC 5 Cấp ── */}
      <section className="ioc-panel overflow-hidden" aria-label="Quản lý Tài khoản & Phân quyền RBAC">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ioc-line p-3">
          <div>
            <h2 className="text-xs font-bold uppercase tracking-wider text-ioc-cyan">
              Quản lý Tài khoản & Phân quyền RBAC ({users.length} tài khoản)
            </h2>
            <p className="text-xs text-ioc-dim">
              Hỗ trợ 6 vai trò: SUPER_ADMIN · ADMIN · OFFICER (95 Phường/Xã) · RESCUE_TEAM (Đội cứu hộ) · YOUTH_UNION · CITIZEN
            </p>
          </div>
          <button type="button" className="ioc-btn ioc-btn-cyan" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden /> Tạo tài khoản mới
          </button>
        </div>

        {/* Bộ lọc tìm kiếm */}
        <div className="grid gap-2 border-b border-ioc-line bg-ioc-raised/30 p-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ioc-dim" aria-hidden />
            <input
              className="ioc-field w-full !pl-8"
              placeholder="Tìm tên, mã CB, email, SĐT…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <select className="ioc-field" value={filterRole} onChange={(e) => setFilterRole(e.target.value)} aria-label="Lọc theo vai trò">
            <option value="">Tất cả vai trò (6 cấp)</option>
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
            <option value="true">Đang hoạt động (Active)</option>
            <option value="false">Đã khóa (Locked)</option>
          </select>
        </div>

        {loadingUsers ? (
          <div className="flex justify-center p-6"><Spinner /></div>
        ) : (
          <div className="max-h-[58dvh] overflow-auto">
            <table className="w-full min-w-[56rem] text-xs">
              <thead className="sticky top-0 bg-ioc-panel">
                <tr className="border-b border-ioc-line">
                  <th className="ioc-th">Họ tên / Định danh</th>
                  <th className="ioc-th">Vai trò (RBAC)</th>
                  <th className="ioc-th">Địa bàn phụ trách</th>
                  <th className="ioc-th">Điểm uy tín</th>
                  <th className="ioc-th">Trạng thái</th>
                  <th className="ioc-th text-right">Thao tác quản trị</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isSelf = u.id === me?.id;
                  const protectedTarget = (u.role === 'super_admin' || u.role === 'city_admin') && !isSuper && !isSelf;
                  return (
                    <tr key={u.id} className="border-b border-ioc-line/60 hover:bg-ioc-raised/60">
                      <td className="px-3 py-2">
                        <p className="font-semibold text-ioc-text">
                          {u.name} {isSelf && <span className="mono text-[10px] text-ioc-cyan">(Bạn)</span>}
                        </p>
                        <p className="mono text-[11px] text-ioc-dim">
                          {u.staffCode ? `${u.staffCode} · ` : ''}
                          {u.email ?? u.phoneMasked ?? u.id}
                        </p>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`mono inline-block rounded border px-2 py-0.5 text-[10px] font-bold ${
                            u.role === 'super_admin'
                              ? 'border-purple-400/50 bg-purple-500/15 text-purple-300'
                              : u.role === 'city_admin'
                                ? 'border-cyan-400/50 bg-cyan-500/15 text-ioc-cyan'
                                : u.role === 'rescue_team'
                                  ? 'border-rose-400/50 bg-rose-500/15 text-rose-300'
                                  : u.role === 'ward_officer'
                                    ? 'border-amber-400/50 bg-amber-500/15 text-ioc-amber'
                                    : 'border-ioc-line text-ioc-dim'
                          }`}
                        >
                          {u.roleCode ?? u.role.toUpperCase()}
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
                            disabled={protectedTarget || busyId !== null}
                            onClick={() => openEdit(u)}
                            title="Sửa thông tin & phân quyền"
                          >
                            <Edit3 className="h-3.5 w-3.5" aria-hidden /> Sửa
                          </button>
                          <button
                            type="button"
                            className="ioc-btn !min-h-7 !px-2 !text-xs"
                            disabled={protectedTarget || busyId !== null}
                            onClick={() => { setPwTarget(u); setNewPw(''); }}
                            title="Đặt lại mật khẩu"
                          >
                            <KeyRound className="h-3.5 w-3.5" aria-hidden /> Mật khẩu
                          </button>
                          <button
                            type="button"
                            className={`ioc-btn !min-h-7 !px-2 !text-xs ${u.revoked ? 'ioc-btn-green' : 'ioc-btn-red'}`}
                            disabled={isSelf || protectedTarget || busyId !== null}
                            onClick={() => void toggleActive(u)}
                          >
                            {u.revoked ? <Unlock className="h-3.5 w-3.5" aria-hidden /> : <Lock className="h-3.5 w-3.5" aria-hidden />}
                            {u.revoked ? 'Mở khóa' : 'Khóa'}
                          </button>
                          {isSuper && !isSelf && (
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

      {/* ── 3. Nhật ký Đánh giá AI/CV Gần nhất ── */}
      {monitor && monitor.recentEvaluations.length > 0 && (
        <section className="ioc-panel overflow-hidden" aria-label="Nhật ký thẩm định AI/CV">
          <div className="border-b border-ioc-line p-3">
            <h2 className="text-xs font-bold uppercase tracking-wider text-ioc-dim">
              Nhật ký Kiểm định Hình ảnh Gần nhất ({monitor.recentEvaluations.length})
            </h2>
          </div>
          <div className="max-h-64 overflow-auto">
            <table className="w-full min-w-[44rem] text-xs">
              <thead className="sticky top-0 bg-ioc-panel">
                <tr className="border-b border-ioc-line">
                  <th className="ioc-th">Thời gian</th>
                  <th className="ioc-th">Loại kiểm tra</th>
                  <th className="ioc-th">Hồ sơ</th>
                  <th className="ioc-th">Điểm số</th>
                  <th className="ioc-th">Tốc độ</th>
                  <th className="ioc-th">Kết luận chi tiết</th>
                </tr>
              </thead>
              <tbody>
                {monitor.recentEvaluations.map((ev) => (
                  <tr key={ev.id} className="border-b border-ioc-line/50">
                    <td className="mono whitespace-nowrap px-3 py-1.5 text-ioc-dim">{fmtDate(ev.createdAt)}</td>
                    <td className="mono px-3 py-1.5 text-ioc-cyan">{ev.kind.toUpperCase()}</td>
                    <td className="mono px-3 py-1.5">{ev.reportId}</td>
                    <td className="mono px-3 py-1.5">
                      {ev.authenticityScore !== null && `Auth:${ev.authenticityScore}%`}
                      {ev.sceneMatchScore !== null && `Scene:${ev.sceneMatchScore}% · Res:${ev.resolutionScore}%`}
                      {ev.kind === 'duplicate' && `${ev.inlierCount} inliers`}
                    </td>
                    <td className="mono px-3 py-1.5 text-ioc-green">{ev.latencyMs}ms</td>
                    <td className="max-w-md truncate px-3 py-1.5 text-ioc-dim" title={ev.summary}>{ev.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

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
              <label className="mb-1 block text-xs text-ioc-dim">Vai trò (RBAC) *</label>
              <select className="ioc-field w-full" value={cRole} onChange={(e) => setCRole(e.target.value as Role)}>
                {ROLE_OPTIONS.filter((r) => isSuper || (r.value !== 'super_admin' && r.value !== 'city_admin')).map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
            {(cRole === 'ward_officer' || cRole === 'volunteer' || cRole === 'rescue_team') && (
              <div>
                <label className="mb-1 block text-xs text-ioc-dim">
                  {cRole === 'rescue_team' ? 'Phạm vi trực chiến (Phường/Xã hoặc Cơ động toàn TP)' : 'Đơn vị Phường/Xã (95 ĐVHC) *'}
                </label>
                <select className="ioc-field w-full" value={cWard} onChange={(e) => setCWard(e.target.value)}>
                  {cRole === 'rescue_team' && (
                    <option value="">Cơ động liên khu vực — Toàn TP. Đồng Nai</option>
                  )}
                  <optgroup label="33 Phường">{WARDS_PHUONG.map((w) => <option key={w.wardCode} value={w.wardCode}>{w.name}</option>)}</optgroup>
                  <optgroup label="62 Xã">{WARDS_XA.map((w) => <option key={w.wardCode} value={w.wardCode}>{w.name}</option>)}</optgroup>
                </select>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-xs text-ioc-dim">Mã cán bộ (tuỳ chọn)</label>
                <input className="ioc-field mono w-full" value={cStaffCode} onChange={(e) => setCStaffCode(e.target.value)} placeholder="CB-TB-02" />
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
              <label className="mb-1 block text-xs text-ioc-dim">Mật khẩu khởi tạo (≥ 8 ký tự)</label>
              <input type="password" className="ioc-field w-full" minLength={8} value={cPassword} onChange={(e) => setCPassword(e.target.value)} required={cRole === 'super_admin' || cRole === 'city_admin' || cRole === 'ward_officer' || cRole === 'rescue_team'} />
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
              <label className="mb-1 block text-xs text-ioc-dim">Vai trò (RBAC)</label>
              <select className="ioc-field w-full" value={eRole} onChange={(e) => setERole(e.target.value as Role)} disabled={editTarget.id === me?.id}>
                {ROLE_OPTIONS.filter((r) => isSuper || (r.value !== 'super_admin' && r.value !== 'city_admin')).map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-ioc-dim">Phường/Xã phụ trách</label>
              <select className="ioc-field w-full" value={eWard} onChange={(e) => setEWard(e.target.value)}>
                <option value="">Toàn TP. Đồng Nai (Không giới hạn 1 phường)</option>
                <optgroup label="33 Phường">{WARDS_PHUONG.map((w) => <option key={w.wardCode} value={w.wardCode}>{w.name}</option>)}</optgroup>
                <optgroup label="62 Xã">{WARDS_XA.map((w) => <option key={w.wardCode} value={w.wardCode}>{w.name}</option>)}</optgroup>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-xs text-ioc-dim">Mã cán bộ</label>
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
