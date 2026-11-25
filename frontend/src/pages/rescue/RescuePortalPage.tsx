import {
  Activity,
  ChevronsLeft,
  ChevronsRight,
  LogOut,
  MapPin,
  RefreshCw,
  Search,
  Siren,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { ClientReport } from '@shared/types';
import { DiagnosticsDrawer } from '../../components/DiagnosticsDrawer';
import { Logo } from '../../components/Logo';
import { TacticalNavigationWorkspace } from '../../components/navigation/TacticalNavigationWorkspace';
import { Spinner } from '../../components/ui';
import { WARD_BY_CODE } from '../../data/dongNaiWards';
import { useLiveNavigationGps } from '../../hooks/useLiveNavigationGps';
import { useI18n } from '../../i18n';
import { api, ApiError } from '../../lib/api';
import { authStore, useSession } from '../../lib/authStore';
import { CATEGORY_META } from '../../lib/meta';
import { useToast } from '../../state/toast';

type MissionItem = ClientReport & {
  distanceKm: number | null;
  etaMinutes: number | null;
};

type FilterTab = 'all' | 'sos' | 'active' | 'done';

export default function RescuePortalPage() {
  const { t } = useI18n();
  const nav = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();
  const session = useSession();
  const me = session?.user;

  const { pos: livePos, refreshNow, startSimulation, stopSimulation } = useLiveNavigationGps(me?.wardCode);

  const [missions, setMissions] = useState<MissionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [queryText, setQueryText] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(() => searchParams.get('missionId'));
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);

  const loadMissions = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        lat: String(livePos.lat),
        lng: String(livePos.lng),
        includeResolved: filterTab === 'done' ? '1' : '0',
      });
      const rows = await api<MissionItem[]>(`/api/rescue/missions?${qs.toString()}`, { timeoutMs: 15000 });
      setMissions(rows);
      setSelectedId((prev) => {
        const paramId = searchParams.get('missionId');
        if (paramId && rows.some((r) => r.id === paramId)) return paramId;
        if (prev && rows.some((r) => r.id === prev)) return prev;
        return rows[0]?.id ?? null;
      });
    } catch (e) {
      toast('error', 'Không tải được danh sách nhiệm vụ cứu hộ', e instanceof ApiError ? e.message : undefined);
    } finally {
      setLoading(false);
    }
    // Chỉ nạp lại khi đổi bộ lọc hoặc định vị ban đầu (không spam API mỗi nhịp mô phỏng)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterTab, toast]);

  useEffect(() => {
    void loadMissions();
  }, [loadMissions]);

  const filteredMissions = useMemo(() => {
    const lowQ = queryText.trim().toLowerCase();
    return missions.filter((m) => {
      if (filterTab === 'done') {
        if (m.status !== 'resolved') return false;
      } else {
        if (m.status === 'resolved') return false;
        if (filterTab === 'sos') {
          const isSos =
            m.severityLabel === 'CRITICAL' || m.isEmergency || m.emergencyLevel === 1 || (m.priorityScore ?? 0) >= 75;
          if (!isSos) return false;
        }
        if (filterTab === 'active') {
          const isAct =
            m.rescueMission?.assignedTeamId === me?.id ||
            m.rescueMission?.status === 'accepted' ||
            m.rescueMission?.status === 'en_route' ||
            m.rescueMission?.status === 'on_site';
          if (!isAct) return false;
        }
      }

      if (lowQ) {
        const wardName = WARD_BY_CODE[m.wardCode]?.name.toLowerCase() ?? '';
        const match =
          m.title.toLowerCase().includes(lowQ) ||
          m.code.toLowerCase().includes(lowQ) ||
          m.address.toLowerCase().includes(lowQ) ||
          m.wardCode.toLowerCase().includes(lowQ) ||
          wardName.includes(lowQ);
        if (!match) return false;
      }
      return true;
    });
  }, [missions, filterTab, queryText, me?.id]);

  const selected = useMemo(
    () => filteredMissions.find((m) => m.id === selectedId) ?? filteredMissions[0] ?? missions[0] ?? null,
    [filteredMissions, missions, selectedId],
  );

  const selectMission = (id: string): void => {
    stopSimulation();
    setSelectedId(id);
    setMobileDrawerOpen(false);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('missionId', id);
      return next;
    }, { replace: true });
  };

  const handleMissionUpdated = useCallback((updated: ClientReport) => {
    setMissions((prev) =>
      prev.map((m) =>
        m.id === updated.id ? { ...updated, distanceKm: m.distanceKm, etaMinutes: m.etaMinutes } : m,
      ),
    );
  }, []);

  const renderMissionListContent = (): JSX.Element => (
    <div className="flex h-full flex-col">
      {/* Đầu bảng Đội Cứu Hộ */}
      <div className="border-b border-slate-800 px-3.5 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Link to="/" aria-label="Trang chủ">
              <Logo dark />
            </Link>
            <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/50 bg-rose-500/15 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-rose-300">
              <Siren className="h-3 w-3 animate-pulse" aria-hidden />
              CỨU HỘ
            </span>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setDiagOpen(true)}
              className="grid h-8 w-8 place-items-center rounded-lg border border-slate-700 bg-slate-800 text-cyan-300 hover:border-cyan-400"
              title="Chẩn đoán hệ thống"
              aria-label="Chẩn đoán hệ thống"
            >
              <Activity className="h-4 w-4" />
            </button>
            {(me?.role === 'super_admin' || me?.role === 'city_admin' || me?.role === 'ward_officer') && (
              <Link
                to="/admin"
                className="inline-flex h-8 items-center rounded-lg border border-slate-700 bg-slate-800 px-2 text-[11px] font-bold text-slate-200 hover:border-slate-600"
              >
                IOC
              </Link>
            )}
            <button
              type="button"
              onClick={() => void authStore.signOut().then(() => nav('/rescue/login'))}
              className="grid h-8 w-8 place-items-center rounded-lg border border-slate-700 bg-slate-800 text-slate-300 hover:text-rose-300"
              title="Đăng xuất"
              aria-label="Đăng xuất"
            >
              <LogOut className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setMobileDrawerOpen(false)}
              className="grid h-8 w-8 place-items-center rounded-lg border border-slate-700 bg-slate-800 text-slate-300 lg:hidden"
              aria-label="Đóng danh sách"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <p className="mt-1.5 truncate text-xs font-semibold text-slate-300">
          {me?.name}{' '}
          <span className="mono text-[11px] text-cyan-300">({me?.staffCode ?? me?.roleCode ?? 'RESCUE_TEAM'})</span>
        </p>

        {/* Tìm kiếm nhanh theo phường/mã/tên đường (vd: Trấn Biên) */}
        <div className="mt-2.5 flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" aria-hidden />
            <input
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              placeholder="Tìm Trấn Biên, tên đường, mã đơn…"
              className="min-h-9 w-full rounded-xl border border-slate-800 bg-slate-950 pl-8 pr-2.5 text-xs text-white placeholder:text-slate-500 focus:border-[#1A73E8] focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => void loadMissions()}
            disabled={loading}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-slate-800 bg-slate-950 text-slate-300 hover:border-[#1A73E8]"
            title="Làm mới danh sách nhiệm vụ"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* 4 Tab lọc nhanh */}
        <div className="mt-2 grid grid-cols-4 gap-1 rounded-xl border border-slate-800 bg-slate-950 p-1 text-[11px] font-extrabold">
          {(
            [
              ['all', 'Đang mở'],
              ['sos', '🚨 SOS'],
              ['active', 'Đang nhận'],
              ['done', 'Đã xong'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilterTab(id)}
              className={`min-h-8 rounded-lg px-1.5 transition-colors ${
                filterTab === id ? 'bg-[#1A73E8] text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Danh sách sự cố ưu tiên */}
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {loading ? (
          <div className="flex justify-center py-12">
            <Spinner className="text-[#1A73E8]" />
          </div>
        ) : filteredMissions.length === 0 ? (
          <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-5 text-center text-xs text-slate-400">
            Không có sự cố phù hợp bộ lọc. Đang trực canh tín hiệu SOS thời gian thực.
          </div>
        ) : (
          filteredMissions.map((m) => {
            const isSel = selected?.id === m.id;
            const isSos = m.severityLabel === 'CRITICAL' || m.isEmergency || m.emergencyLevel === 1;
            const ward = WARD_BY_CODE[m.wardCode];
            const stage = m.rescueMission?.status ?? 'unassigned';
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => selectMission(m.id)}
                className={`w-full rounded-2xl border p-3 text-left transition-colors ${
                  isSel
                    ? 'border-[#1A73E8] bg-[#1A73E8]/15 shadow-lg ring-1 ring-[#1A73E8]/60'
                    : isSos
                      ? 'border-rose-500/45 bg-rose-950/20 hover:border-rose-400'
                      : 'border-slate-800 bg-slate-950/80 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1.5">
                    {isSos ? (
                      <span className="rounded bg-rose-600 px-1.5 py-0.5 text-[10px] font-extrabold text-white">
                        SOS KHẨN
                      </span>
                    ) : (
                      <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-bold text-cyan-300">
                        {m.severityLabel ?? 'MEDIUM'}
                      </span>
                    )}
                    <span className="mono text-[10px] font-bold text-amber-300">
                      Ưu tiên {m.priorityScore ?? 60}
                    </span>
                  </div>
                  <span className="mono text-[11px] font-extrabold text-[#60A5FA]">
                    {m.distanceKm !== null ? `${m.distanceKm} km` : '—'}
                    {m.etaMinutes !== null ? ` · ~${m.etaMinutes}p` : ''}
                  </span>
                </div>

                <h2 className="mt-1.5 line-clamp-2 break-words text-xs font-extrabold leading-snug text-white sm:text-sm">
                  {m.title}
                </h2>
                <p className="mt-1 truncate text-[11px] text-slate-400">
                  <MapPin className="mr-1 inline h-3 w-3 text-[#60A5FA]" aria-hidden />
                  {m.address || ward?.name || m.wardCode}
                </p>

                <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px]">
                  <span className="mono truncate text-slate-400">
                    {m.code} · {t(CATEGORY_META[m.category].labelKey)}
                  </span>
                  {stage !== 'unassigned' && (
                    <span className="shrink-0 rounded-full bg-emerald-500/20 px-2 py-0.5 font-bold text-emerald-300">
                      {stage === 'accepted'
                        ? 'Đã nhận'
                        : stage === 'en_route'
                          ? 'Đang đi'
                          : stage === 'on_site'
                            ? 'Tại chỗ'
                            : 'Đã xong'}
                    </span>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );

  if (!selected) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-slate-950 p-6 text-center text-slate-200">
        {loading ? (
          <>
            <Spinner className="h-8 w-8 text-[#1A73E8]" />
            <p className="text-sm font-bold">Đang đồng bộ danh sách nhiệm vụ ứng cứu gần nhất…</p>
          </>
        ) : (
          <>
            <Siren className="h-10 w-10 text-emerald-400" />
            <h1 className="text-lg font-extrabold">Hiện không có sự cố nào đang chờ ứng cứu</h1>
            <button
              type="button"
              onClick={() => void loadMissions()}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[#1A73E8] px-4 text-sm font-extrabold text-white"
            >
              <RefreshCw className="h-4 w-4" /> Kiểm tra lại nhiệm vụ
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-slate-950">
      {/* Màn hình Dẫn đường Tác chiến Toàn màn hình (Map-First 100dvh) */}
      <TacticalNavigationWorkspace
        mission={selected}
        allMarkers={filteredMissions}
        livePos={livePos}
        onRefreshGps={() => void refreshNow()}
        onStartSimulation={startSimulation}
        onStopSimulation={stopSimulation}
        onSelectMarker={(m) => selectMission(m.id)}
        onMissionUpdated={handleMissionUpdated}
        onToggleMissionDrawer={() => setMobileDrawerOpen(true)}
        missionCountBadge={filteredMissions.length}
        desktopLeftInset={desktopSidebarOpen}
        headerSlot={
          /* Nút thu/mở danh sách nhiệm vụ cạnh trái trên Desktop */
          <div className="pointer-events-none absolute left-3 top-3 z-[48] hidden lg:block">
            {!desktopSidebarOpen && (
              <button
                type="button"
                onClick={() => setDesktopSidebarOpen(true)}
                className="pointer-events-auto inline-flex min-h-11 items-center gap-2 rounded-2xl border border-slate-700 bg-slate-900/95 px-3.5 text-xs font-extrabold text-white shadow-2xl backdrop-blur-md hover:border-[#1A73E8]"
              >
                <Siren className="h-4 w-4 text-rose-400" />
                Nhiệm vụ ({filteredMissions.length})
                <ChevronsRight className="h-4 w-4 text-slate-400" />
              </button>
            )}
          </div>
        }
      />

      {/* Bảng Nhiệm vụ Cạnh trái trên Desktop (Floating Glass Sidebar chuẩn Google Maps Desktop) */}
      <aside
        aria-label="Danh sách nhiệm vụ cứu hộ ưu tiên"
        className={`absolute bottom-3 left-3 top-3 z-[47] hidden w-[21.5rem] flex-col overflow-hidden rounded-3xl border border-slate-800/95 bg-slate-900/95 shadow-2xl backdrop-blur-xl transition-transform duration-200 lg:flex ${
          desktopSidebarOpen ? 'translate-x-0' : '-translate-x-[24rem]'
        }`}
      >
        {renderMissionListContent()}
        <button
          type="button"
          onClick={() => setDesktopSidebarOpen(false)}
          className="flex min-h-9 items-center justify-center gap-1 border-t border-slate-800 bg-slate-950/80 text-xs font-bold text-slate-400 hover:text-white"
        >
          <ChevronsLeft className="h-4 w-4" /> Ẩn danh sách để mở rộng bản đồ
        </button>
      </aside>

      {/* Drawer trượt chọn nhiệm vụ trên Mobile */}
      {mobileDrawerOpen && (
        <div
          className="fixed inset-0 z-[60] flex bg-black/70 backdrop-blur-sm lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Chọn nhiệm vụ cứu hộ"
        >
          <div className="h-full w-[88vw] max-w-sm bg-slate-900 shadow-2xl">
            {renderMissionListContent()}
          </div>
          <button
            type="button"
            className="flex-1"
            aria-label="Đóng ngăn kéo nhiệm vụ"
            onClick={() => setMobileDrawerOpen(false)}
          />
        </div>
      )}

      <DiagnosticsDrawer open={diagOpen} onClose={() => setDiagOpen(false)} />
    </div>
  );
}
