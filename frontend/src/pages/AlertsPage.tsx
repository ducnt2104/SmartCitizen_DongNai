import {
  AlertTriangle,
  CheckCircle2,
  CloudRain,
  Compass,
  ExternalLink,
  Flame,
  Layers,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Search,
  ShieldAlert,
  Sparkles,
  ThumbsUp,
  Trash2,
  Wind,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { normalizeRole } from '@shared/constants';
import type {
  AlertCategory,
  AlertSeverity,
  CivicAlertItem,
  DailyDigestItem,
  OfficialBulletinItem,
  RouteCheckResponse,
  WeatherSnapshotItem,
} from '@shared/types';
import { DONG_NAI_WARDS, WARD_BY_CODE } from '../data/dongNaiWards';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { useSession } from '../lib/authStore';
import { useToast } from '../state/toast';
import { WardInspectorDrawer } from '../components/WardInspectorDrawer';
import { UnifiedMapCanvas } from '../components/map/UnifiedMapCanvas';
import { Spinner } from '../components/ui';

type FilterGroup = 'all' | 'disaster' | 'traffic' | 'utility_official';

const SEVERITY_BADGES = {
  1: { label: 'Mức 1 · Chú ý', cls: 'border-amber-500/35 bg-amber-500/15 text-amber-800 dark:text-amber-300' },
  2: { label: 'Mức 2 · Cảnh báo', cls: 'border-orange-500/35 bg-orange-500/15 text-orange-800 dark:text-orange-300' },
  3: { label: 'Mức 3 · Khẩn cấp', cls: 'border-rose-600/40 bg-rose-600/15 text-rose-700 dark:text-rose-300' },
} as const;

const COMMON_ARTERIALS = [
  'Quốc lộ 1A',
  'Quốc lộ 51',
  'Quốc lộ 20',
  'Võ Nguyên Giáp',
  'Đồng Khởi',
  'Phạm Văn Thuận',
  'Bùi Văn Hòa',
  'ĐT 768',
] as const;

export default function AlertsPage() {
  const { fmtDate } = useI18n();
  const session = useSession();
  const toast = useToast();

  const role = session?.user ? normalizeRole(session.user.role) : null;
  const isStaffOrRescue = role === 'admin' || role === 'officer' || role === 'rescue';
  const isAdmin = role === 'admin';

  const [weather, setWeather] = useState<WeatherSnapshotItem[]>([]);
  const [weatherSyncAt, setWeatherSyncAt] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<CivicAlertItem[]>([]);
  const [bulletins, setBulletins] = useState<OfficialBulletinItem[]>([]);
  const [digest, setDigest] = useState<DailyDigestItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [filterGroup, setFilterGroup] = useState<FilterGroup>('all');
  const [selectedAlert, setSelectedAlert] = useState<CivicAlertItem | null>(null);
  const [inspectWardCode, setInspectWardCode] = useState<string | null>(null);

  // Route Check
  const [roadInput, setRoadInput] = useState('');
  const [routeChecking, setRouteChecking] = useState(false);
  const [routeResult, setRouteResult] = useState<RouteCheckResponse | null>(null);

  // Admin / Rescue Draw Mode
  const [drawOpen, setDrawOpen] = useState(false);
  const [drawGeomType, setDrawGeomType] = useState<'polyline' | 'circle'>('polyline');
  const [drawPoints, setDrawPoints] = useState<Array<[number, number]>>([]);
  const [drawRadiusM, setDrawRadiusM] = useState(500);
  const [drawTitle, setDrawTitle] = useState('');
  const [drawDesc, setDrawDesc] = useState('');
  const [drawCategory, setDrawCategory] = useState<AlertCategory>('traffic');
  const [drawSeverity, setDrawSeverity] = useState<AlertSeverity>(2);
  const [drawWardId, setDrawWardId] = useState<string>('DN-TB');
  const [drawRoads, setDrawRoads] = useState('');
  const [drawDetour, setDrawDetour] = useState('');
  const [savingDraw, setSavingDraw] = useState(false);

  // Citizen Quick Community Alert Modal
  const [communityOpen, setCommunityOpen] = useState(false);
  const [commTitle, setCommTitle] = useState('');
  const [commDesc, setCommDesc] = useState('');
  const [commCategory, setCommCategory] = useState<AlertCategory>('disaster');
  const [commSeverity, setCommSeverity] = useState<1 | 2>(1);
  const [commWardCode, setCommWardCode] = useState('DN-TB');
  const [commRoads, setCommRoads] = useState('');
  const [commHoneypot, setCommHoneypot] = useState('');
  const commLoadedAtRef = useRef(Date.now());
  const [savingComm, setSavingComm] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [wRes, aRes, bRes, dRes] = await Promise.allSettled([
        api<{ items: WeatherSnapshotItem[]; lastSyncAt: string | null }>('/api/weather'),
        api<{ items: CivicAlertItem[] }>('/api/alerts?status=active&limit=100'),
        api<{ items: OfficialBulletinItem[] }>('/api/bulletins?limit=20'),
        api<DailyDigestItem>('/api/ai/daily-digest'),
      ]);
      if (wRes.status === 'fulfilled') {
        setWeather(wRes.value.items);
        setWeatherSyncAt(wRes.value.lastSyncAt);
      }
      if (aRes.status === 'fulfilled') {
        setAlerts(aRes.value.items);
      }
      if (bRes.status === 'fulfilled') {
        setBulletins(bRes.value.items);
      }
      if (dRes.status === 'fulfilled') {
        setDigest(dRes.value);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const filteredAlerts = useMemo(() => {
    return alerts.filter((a) => {
      if (filterGroup === 'disaster') return a.category === 'disaster';
      if (filterGroup === 'traffic') return a.category === 'traffic';
      if (filterGroup === 'utility_official') return a.category === 'utility' || a.category === 'official_notice';
      return true;
    });
  }, [alerts, filterGroup]);

  const filteredBulletins = useMemo(() => {
    return bulletins.filter((b) => {
      if (filterGroup === 'disaster') return b.category === 'disaster';
      if (filterGroup === 'traffic') return b.category === 'traffic';
      if (filterGroup === 'utility_official') return b.category === 'utility' || b.category === 'official_notice';
      return true;
    });
  }, [bulletins, filterGroup]);

  const runRouteCheck = async (queryText?: string): Promise<void> => {
    const q = (queryText ?? roadInput).trim();
    if (q.length < 2) {
      toast('info', 'Vui lòng nhập tên tuyến đường cần kiểm tra.');
      return;
    }
    setRoadInput(q);
    setRouteChecking(true);
    try {
      const res = await api<RouteCheckResponse>(`/api/alerts/route-check?road=${encodeURIComponent(q)}`);
      setRouteResult(res);
    } catch (err) {
      toast('error', 'Không kiểm tra được tuyến đường', err instanceof Error ? err.message : undefined);
    } finally {
      setRouteChecking(false);
    }
  };

  const handleConfirmAlert = async (al: CivicAlertItem): Promise<void> => {
    if (!session) {
      toast('info', 'Vui lòng đăng nhập để xác nhận cảnh báo cộng đồng.');
      return;
    }
    try {
      const updated = await api<CivicAlertItem>(`/api/alerts/${encodeURIComponent(al.id)}/confirm`, {
        method: 'POST',
        body: {},
      });
      setAlerts((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      toast('success', 'Đã ghi nhận xác nhận (+1)');
    } catch (err) {
      toast('error', 'Không thể xác nhận', err instanceof Error ? err.message : undefined);
    }
  };

  const handleResolveAlert = async (al: CivicAlertItem): Promise<void> => {
    try {
      await api<CivicAlertItem>(`/api/admin/alerts/${encodeURIComponent(al.id)}`, {
        method: 'PATCH',
        body: { status: 'resolved' },
      });
      setAlerts((prev) => prev.filter((x) => x.id !== al.id));
      toast('success', 'Đã đóng cảnh báo và lưu Nhật ký Kiểm toán');
    } catch (err) {
      toast('error', 'Thao tác thất bại', err instanceof Error ? err.message : undefined);
    }
  };

  const handleDeleteAlert = async (al: CivicAlertItem): Promise<void> => {
    const password = window.prompt(`Nhập mật khẩu quản trị để xóa cảnh báo "${al.title}":`);
    if (!password) return;
    try {
      await api<{ ok: boolean }>(`/api/admin/alerts/${encodeURIComponent(al.id)}`, {
        method: 'DELETE',
        headers: { 'X-Reauth-Password': password },
      });
      setAlerts((prev) => prev.filter((x) => x.id !== al.id));
      toast('success', 'Đã xóa cảnh báo và ghi nhận SecurityAuditLog');
    } catch (err) {
      toast('error', 'Không thể xóa cảnh báo', err instanceof Error ? err.message : undefined);
    }
  };

  const handleTriggerSync = async (): Promise<void> => {
    try {
      const res = await api<{ weatherZonesUpdated: number; bulletinsSaved: number }>('/api/admin/aggregator/sync', {
        method: 'POST',
        body: {},
      });
      toast('success', `Đã đồng bộ xong (${res.weatherZonesUpdated} vùng thời tiết, ${res.bulletinsSaved} bản tin mới)`);
      await loadAll();
    } catch (err) {
      toast('error', 'Đồng bộ thất bại', err instanceof Error ? err.message : undefined);
    }
  };

  const handleSaveAdminDraw = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const anchor = drawPoints[0] ?? [
      WARD_BY_CODE[drawWardId]?.centerLat ?? 10.9465,
      WARD_BY_CODE[drawWardId]?.centerLng ?? 106.8243,
    ];
    if (drawGeomType === 'polyline' && drawPoints.length < 2) {
      toast('info', 'Hãy bấm ít nhất 2 điểm trên bản đồ để vẽ tuyến đường thi công / sạt lở.');
      return;
    }
    setSavingDraw(true);
    try {
      const created = await api<CivicAlertItem>('/api/admin/alerts', {
        method: 'POST',
        body: {
          title: drawTitle.trim(),
          description: drawDesc.trim(),
          category: drawCategory,
          severity: drawSeverity,
          wardIds: [drawWardId],
          affectedRoads: drawRoads
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          detourNote: drawDetour.trim() || undefined,
          geometryType: drawGeomType,
          lat: anchor[0],
          lng: anchor[1],
          radiusM: drawGeomType === 'circle' ? drawRadiusM : undefined,
          polyline: drawGeomType === 'polyline' ? drawPoints : undefined,
        },
      });
      setAlerts((prev) => [created, ...prev]);
      setDrawOpen(false);
      setDrawPoints([]);
      setDrawTitle('');
      setDrawDesc('');
      setDrawRoads('');
      setDrawDetour('');
      toast('success', 'Đã phát cảnh báo địa hình lên bản đồ toàn tỉnh!');
    } catch (err) {
      toast('error', 'Không lưu được cảnh báo', err instanceof Error ? err.message : undefined);
    } finally {
      setSavingDraw(false);
    }
  };

  const handleSubmitCommunityAlert = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const w = WARD_BY_CODE[commWardCode];
    setSavingComm(true);
    try {
      const created = await api<CivicAlertItem>('/api/alerts/community', {
        method: 'POST',
        body: {
          title: commTitle.trim(),
          description: commDesc.trim(),
          category: commCategory,
          severity: commSeverity,
          wardCode: commWardCode,
          lat: w?.centerLat ?? 10.9465,
          lng: w?.centerLng ?? 106.8243,
          affectedRoads: commRoads
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          formLoadedAt: commLoadedAtRef.current,
          ...(commHoneypot ? { website: commHoneypot } : {}),
        },
      });
      setAlerts((prev) => [created, ...prev]);
      setCommunityOpen(false);
      setCommTitle('');
      setCommDesc('');
      setCommRoads('');
      setCommHoneypot('');
      toast('success', 'Đã gửi cảnh báo cộng đồng (chờ xác minh chính thức).');
    } catch (err) {
      toast('error', 'Không gửi được cảnh báo', err instanceof Error ? err.message : undefined);
    } finally {
      setSavingComm(false);
    }
  };

  const mapMarkers = useMemo(() => {
    return filteredAlerts.map((a) => ({
      id: a.id,
      code: a.wardIds[0] ?? 'DN',
      category: a.category === 'disaster' ? ('ngap_nuoc' as const) : a.category === 'traffic' ? ('mat_duong' as const) : ('khac' as const),
      title: a.title,
      priority: a.severity === 3 ? ('emergency' as const) : a.severity === 2 ? ('high' as const) : ('normal' as const),
      emergencyLevel: a.severity === 3 ? (1 as const) : (0 as const),
      isEmergency: a.severity === 3,
      clusterCount: a.clusterReportCount ?? 1,
      status: 'received' as const,
      wardCode: a.wardIds[0] ?? 'DN-TB',
      lat: a.lat,
      lng: a.lng,
      severity: a.severity === 3 ? (5 as const) : a.severity === 2 ? (4 as const) : (2 as const),
      createdAt: a.createdAt,
    }));
  }, [filteredAlerts]);

  return (
    <div className="space-y-4">
      {/* Page Title & Action Row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-extrabold tracking-tight text-ink sm:text-2xl">
            <ShieldAlert className="h-6 w-6 text-rose-600" aria-hidden />
            Cảnh báo Thiên tai, Ngập lụt & Tuyến đường
          </h1>
          <p className="mt-0.5 text-xs text-muted sm:text-sm">
            Dữ liệu khí tượng Open-Meteo thời gian thực, bản tin chính thống Đồng Nai & cụm cảnh báo hiện trường.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {session && (
            <button
              type="button"
              onClick={() => {
                commLoadedAtRef.current = Date.now();
                setCommunityOpen(true);
              }}
              className="btn btn-soft !min-h-10 !px-3.5 !text-xs"
            >
              <Plus className="h-4 w-4" aria-hidden /> Báo cảnh báo cộng đồng
            </button>
          )}
          {isStaffOrRescue && (
            <button
              type="button"
              onClick={() => {
                setDrawOpen((v) => !v);
                setDrawPoints([]);
              }}
              className={`btn !min-h-10 !px-3.5 !text-xs ${drawOpen ? 'btn-primary' : 'btn-soft'}`}
            >
              <Pencil className="h-4 w-4" aria-hidden />
              {drawOpen ? 'Đang bật chế độ vẽ' : 'Vẽ Tuyến thi công / Vùng ngập'}
            </button>
          )}
          {isAdmin && (
            <button
              type="button"
              onClick={() => void handleTriggerSync()}
              className="btn btn-ghost !min-h-10 !px-3 !text-xs"
              title="Đồng bộ ngay Open-Meteo & RSS chính thống"
            >
              <RefreshCw className="h-4 w-4" aria-hidden /> Đồng bộ nguồn
            </button>
          )}
        </div>
      </div>

      {/* Thanh Thời tiết & Lượng mưa thực tế Đồng Nai (Open-Meteo) */}
      <section aria-label="Thời tiết và lượng mưa thực tế Đồng Nai" className="card p-3.5">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-wide text-brand">
            <CloudRain className="h-4 w-4" aria-hidden />
            <span>Khí tượng & Lượng mưa Thực tế Đồng Nai (Open-Meteo)</span>
          </div>
          <span className="text-[11px] text-muted">
            {weatherSyncAt ? `Cập nhật lúc: ${fmtDate(weatherSyncAt, true)}` : 'Chưa có snapshot'}
          </span>
        </div>
        {weather.length === 0 ? (
          <p className="text-xs text-muted">
            {loading
              ? 'Đang tải dữ liệu khí tượng Open-Meteo…'
              : 'Chưa nhận được dữ liệu từ Open-Meteo. Hệ thống sẽ tự cập nhật lại ở chu kỳ kế tiếp.'}
          </p>
        ) : (
          <div className="flex gap-2.5 overflow-x-auto pb-1">
            {weather.map((w) => (
              <button
                key={w.regionKey}
                type="button"
                onClick={() => setInspectWardCode(w.wardCode)}
                className={`min-w-[11.5rem] shrink-0 rounded-2xl border p-2.5 text-left transition-colors hover:border-brand/40 ${
                  w.isHazard
                    ? 'border-rose-500/40 bg-rose-500/10'
                    : 'border-line bg-surface-2/75'
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate text-xs font-bold text-ink">{w.regionName}</span>
                  <span className="mono text-xs font-extrabold text-brand">{w.temperatureC}°C</span>
                </div>
                <p className="mt-1 text-[11px] font-semibold text-muted">{w.weatherLabel}</p>
                <div className="mt-1.5 flex items-center justify-between text-[11px]">
                  <span className={`font-bold ${w.precipitationMm > 15 ? 'text-rose-600' : 'text-ink'}`}>
                    Mưa: {w.precipitationMm}mm/h
                  </span>
                  <span className="inline-flex items-center gap-0.5 text-muted">
                    <Wind className="h-3 w-3" aria-hidden /> {w.windGustsKmh}km/h
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Cached Daily AI Digest (DB Cache ONLY) */}
      {digest && digest.bullets.length > 0 && (
        <section className="rounded-2xl border border-brand/25 bg-brand-soft/45 p-3.5" aria-label="Tóm tắt tình hình 24h">
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-brand">
              <Sparkles className="h-4 w-4" aria-hidden /> Bản tin Tóm tắt AI 24h (Cache DB)
            </span>
            <span className="text-[11px] text-muted">Cập nhật: {fmtDate(digest.generatedAt, true)}</span>
          </div>
          <ul className="space-y-1 text-xs leading-relaxed text-ink sm:text-sm">
            {digest.bullets.map((b, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" aria-hidden />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Safe-Zone Route Check Tool */}
      <section className="card space-y-3 p-3.5" aria-label="Kiểm tra an toàn tuyến đường">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-wide text-ink sm:shrink-0">
            <Route className="h-4 w-4 text-brand" aria-hidden /> Kiểm tra Tuyến đường An toàn:
          </div>
          <div className="flex flex-1 gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
              <input
                type="search"
                value={roadInput}
                onChange={(e) => setRoadInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runRouteCheck();
                }}
                placeholder="Nhập tên đường (VD: Quốc lộ 1A, QL51, Đồng Khởi, Võ Nguyên Giáp...)"
                className="field !min-h-10 !pl-9 text-sm"
              />
            </div>
            <button
              type="button"
              disabled={routeChecking}
              onClick={() => void runRouteCheck()}
              className="btn btn-primary !min-h-10 !px-4 !text-xs"
            >
              {routeChecking ? <Spinner /> : 'Kiểm tra'}
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {COMMON_ARTERIALS.map((road) => (
            <button
              key={road}
              type="button"
              onClick={() => void runRouteCheck(road)}
              className="chip !min-h-7 !px-2.5 !text-[11px]"
            >
              {road}
            </button>
          ))}
        </div>
        {routeResult && (
          <div
            className={`rounded-2xl border p-3 text-xs sm:text-sm ${
              routeResult.status === 'danger'
                ? 'border-rose-500/40 bg-rose-500/10 text-rose-800 dark:text-rose-200'
                : routeResult.status === 'caution'
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200'
                  : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
            }`}
          >
            <p className="font-bold">{routeResult.message}</p>
          </div>
        )}
      </section>

      {/* Form Vẽ Tuyến thi công / Vùng ngập cho Admin & Đội ứng cứu */}
      {drawOpen && isStaffOrRescue && (
        <form onSubmit={(e) => void handleSaveAdminDraw(e)} className="card space-y-3 border-2 border-brand/35 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-extrabold text-brand">
              Công cụ Đánh dấu Tuyến đường Thi công / Vùng Ngập lụt trên Bản đồ
            </h2>
            <button type="button" onClick={() => setDrawOpen(false)} className="text-xs text-muted hover:text-ink">
              Hủy
            </button>
          </div>
          <p className="text-xs text-muted">
            Bấm trực tiếp lên bản đồ bên dưới để chọn {drawGeomType === 'polyline' ? 'các điểm nối thành đoạn đường' : 'tâm vùng bán kính'}.
            Đang chọn: <span className="mono font-bold text-ink">{drawPoints.length} điểm</span>.
            {drawPoints.length > 0 && (
              <button type="button" onClick={() => setDrawPoints([])} className="ml-2 text-brand underline">
                Vẽ lại
              </button>
            )}
          </p>
          <div className="grid gap-2.5 sm:grid-cols-4">
            <select
              value={drawGeomType}
              onChange={(e) => {
                setDrawGeomType(e.target.value as 'polyline' | 'circle');
                setDrawPoints([]);
              }}
              className="field !min-h-10 text-xs"
            >
              <option value="polyline">Vẽ Tuyến đường (Polyline)</option>
              <option value="circle">Vẽ Vùng ngập / Phong tỏa (Circle)</option>
            </select>
            <select
              value={drawCategory}
              onChange={(e) => setDrawCategory(e.target.value as AlertCategory)}
              className="field !min-h-10 text-xs"
            >
              <option value="traffic">Đường thi công / Tai nạn</option>
              <option value="disaster">Thiên tai / Ngập lụt / Sạt lở</option>
              <option value="utility">Điện / Nước</option>
              <option value="official_notice">Thông báo chính quyền</option>
            </select>
            <select
              value={drawSeverity}
              onChange={(e) => setDrawSeverity(Number(e.target.value) as AlertSeverity)}
              className="field !min-h-10 text-xs"
            >
              <option value={1}>Mức 1 · Chú ý (Vàng)</option>
              <option value={2}>Mức 2 · Cảnh báo (Cam)</option>
              <option value={3}>Mức 3 · Khẩn cấp (Đỏ)</option>
            </select>
            <select
              value={drawWardId}
              onChange={(e) => setDrawWardId(e.target.value)}
              className="field !min-h-10 text-xs"
            >
              {DONG_NAI_WARDS.map((w) => (
                <option key={w.wardCode} value={w.wardCode}>{w.name}</option>
              ))}
            </select>
          </div>
          {drawGeomType === 'circle' && (
            <div className="flex items-center gap-3 text-xs">
              <label htmlFor="draw-radius" className="font-semibold">Bán kính vùng cảnh báo (mét):</label>
              <input
                id="draw-radius"
                type="number"
                min={50}
                max={20000}
                step={50}
                value={drawRadiusM}
                onChange={(e) => setDrawRadiusM(Number(e.target.value) || 500)}
                className="field !min-h-9 w-28 text-xs"
              />
            </div>
          )}
          <div className="grid gap-2.5 sm:grid-cols-2">
            <input
              required
              minLength={5}
              value={drawTitle}
              onChange={(e) => setDrawTitle(e.target.value)}
              placeholder="Tiêu đề cảnh báo (VD: Thi công cống thoát nước QL1A đoạn Amata)..."
              className="field !min-h-10 text-sm"
            />
            <input
              value={drawRoads}
              onChange={(e) => setDrawRoads(e.target.value)}
              placeholder="Tuyến đường ảnh hưởng (ngăn cách dấu phẩy, VD: QL1A, Võ Nguyên Giáp)"
              className="field !min-h-10 text-sm"
            />
          </div>
          <textarea
            required
            minLength={5}
            rows={2}
            value={drawDesc}
            onChange={(e) => setDrawDesc(e.target.value)}
            placeholder="Mô tả chi tiết tình trạng hiện trường và khung giờ ảnh hưởng..."
            className="field text-sm"
          />
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={drawDetour}
              onChange={(e) => setDrawDetour(e.target.value)}
              placeholder="Gợi ý lộ trình né tránh (tùy chọn)..."
              className="field !min-h-10 flex-1 text-sm"
            />
            <button type="submit" disabled={savingDraw} className="btn btn-primary !min-h-10 !px-5">
              {savingDraw ? <Spinner /> : 'Công bố lên Bản đồ'}
            </button>
          </div>
        </form>
      )}

      {/* Bố cục 2 cột: Bản đồ Cảnh báo Trực quan + Luồng Cảnh báo */}
      <div className="grid gap-4 lg:grid-cols-12">
        {/* Cột Trái: Bản đồ Cảnh báo */}
        <div className="space-y-2.5 lg:col-span-6">
          <div className="flex items-center justify-between text-xs font-bold text-muted">
            <span className="inline-flex items-center gap-1.5">
              <Layers className="h-4 w-4 text-brand" aria-hidden />
              Bản đồ Vùng ngập, Tuyến đường & Cụm cảnh báo ({filteredAlerts.length})
            </span>
            {drawOpen && <span className="text-brand animate-pulse">Nhấn vào bản đồ để chấm tọa độ!</span>}
          </div>
          <UnifiedMapCanvas
            reports={mapMarkers}
            alerts={filteredAlerts}
            mode="pins"
            fitCityOnMount
            showArterials
            showFitCityButton
            draftPolyline={drawOpen && drawGeomType === 'polyline' ? drawPoints : undefined}
            draftCircle={
              drawOpen && drawGeomType === 'circle' && drawPoints[0]
                ? { lat: drawPoints[0][0], lng: drawPoints[0][1], radiusM: drawRadiusM }
                : null
            }
            onSelectAlert={(al) => setSelectedAlert(al)}
            onMapClick={(lat, lng) => {
              if (drawOpen) {
                setDrawPoints((prev) => (drawGeomType === 'circle' ? [[lat, lng]] : [...prev, [lat, lng]]));
              }
            }}
            className="h-[44dvh] lg:h-[62dvh]"
            ariaLabel="Bản đồ cảnh báo thiên tai và tuyến đường Đồng Nai"
          />
          {selectedAlert && (
            <div className="card flex items-start justify-between gap-2 border-brand/30 p-3 text-xs">
              <div>
                <p className="font-bold text-ink">{selectedAlert.title}</p>
                <p className="mt-0.5 text-muted">{selectedAlert.description}</p>
              </div>
              <button type="button" onClick={() => setSelectedAlert(null)} className="text-muted hover:text-ink">
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>

        {/* Cột Phải: Bộ lọc 3 nhóm + Luồng Cảnh báo & Tin Chính thống */}
        <div className="space-y-3 lg:col-span-6">
          <div className="flex flex-wrap gap-1.5">
            {([
              ['all', 'Tất cả cảnh báo'],
              ['disaster', 'Thiên tai & Ngập lụt'],
              ['traffic', 'Thi công / Giao thông'],
              ['utility_official', 'Điện / Nước & Chính quyền'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilterGroup(key)}
                className={`chip !min-h-9 !text-xs ${filterGroup === key ? 'bg-brand text-white border-brand' : ''}`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="max-h-[58dvh] space-y-3 overflow-y-auto pr-1">
            {loading && alerts.length === 0 ? (
              <div className="card flex items-center justify-center gap-2 py-12 text-sm text-muted">
                <Spinner /> Đang tải luồng cảnh báo thực tế…
              </div>
            ) : filteredAlerts.length === 0 ? (
              <div className="card p-6 text-center text-sm text-muted">
                Hiện chưa có cảnh báo hiệu lực nào trong nhóm này.
              </div>
            ) : (
              filteredAlerts.map((al) => {
                const sev = SEVERITY_BADGES[al.severity];
                return (
                  <article key={al.id} className="card space-y-2 p-3.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${sev.cls}`}>
                        {sev.label}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted">
                        {al.isVerifiedOfficial ? (
                          <CheckCircle2 className="h-3 w-3 text-ok" aria-hidden />
                        ) : (
                          <AlertTriangle className="h-3 w-3 text-amber-600" aria-hidden />
                        )}
                        {al.sourceLabel}
                      </span>
                      <span className="ml-auto text-[11px] text-muted">{fmtDate(al.createdAt, true)}</span>
                    </div>

                    <h3 className="font-bold text-ink">{al.title}</h3>
                    <p className="text-xs leading-relaxed text-muted sm:text-sm">{al.description}</p>

                    {al.detourNote && (
                      <p className="rounded-xl bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-900 dark:text-amber-200">
                        <Compass className="mr-1 inline h-3.5 w-3.5" aria-hidden />
                        Lộ trình tránh: {al.detourNote}
                      </p>
                    )}

                    <div className="flex flex-wrap items-center gap-1.5">
                      {al.wardIds.slice(0, 4).map((wc) =>
                        wc === 'ALL_DONG_NAI' ? (
                          <span key={wc} className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-semibold text-brand">
                            Toàn tỉnh Đồng Nai
                          </span>
                        ) : (
                          <button
                            key={wc}
                            type="button"
                            onClick={() => setInspectWardCode(wc)}
                            className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-bold text-brand hover:underline"
                          >
                            <MapPin className="h-3 w-3" aria-hidden />
                            {WARD_BY_CODE[wc]?.shortName ?? wc}
                          </button>
                        ),
                      )}
                      {al.affectedRoads.map((rd) => (
                        <button
                          key={rd}
                          type="button"
                          onClick={() => void runRouteCheck(rd)}
                          className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted hover:text-ink"
                        >
                          {rd}
                        </button>
                      ))}
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line/60 pt-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleConfirmAlert(al)}
                          className="btn btn-soft !min-h-8 !px-2.5 !text-xs"
                        >
                          <ThumbsUp className="h-3.5 w-3.5" aria-hidden />
                          Xác nhận ({al.confirmCount})
                        </button>
                        {al.sourceUrl && (
                          <a
                            href={al.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs font-bold text-brand hover:underline"
                          >
                            <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Nguồn tin
                          </a>
                        )}
                      </div>

                      {isStaffOrRescue && (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => void handleResolveAlert(al)}
                            className="btn btn-ghost !min-h-8 !px-2.5 !text-xs text-ok"
                          >
                            Đã khắc phục
                          </button>
                          {isAdmin && (
                            <button
                              type="button"
                              onClick={() => void handleDeleteAlert(al)}
                              className="btn btn-ghost !min-h-8 !px-2 !text-xs text-danger"
                              aria-label="Xóa cảnh báo"
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </article>
                );
              })
            )}

            {/* Thông báo chính thống gần nhất (Bulletins) */}
            {filteredBulletins.length > 0 && (
              <div className="space-y-2 pt-2">
                <h2 className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-muted">
                  <Flame className="h-3.5 w-3.5 text-brand" aria-hidden />
                  Bản tin Chính thống Đồng Nai mới nhất ({filteredBulletins.length})
                </h2>
                {filteredBulletins.map((b) => (
                  <div key={b.id} className="card space-y-1 border-l-4 border-l-brand p-3">
                    <div className="flex items-center justify-between text-[11px] text-muted">
                      <span className="font-bold text-brand">{b.sourceName}</span>
                      <span>{fmtDate(b.publishedAt, true)}</span>
                    </div>
                    <p className="text-sm font-bold text-ink">{b.title}</p>
                    <p className="text-xs leading-relaxed text-muted">{b.cleanSummary}</p>
                    <a
                      href={b.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-bold text-brand hover:underline"
                    >
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Đọc bài gốc
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Modal Báo cảnh báo cộng đồng */}
      {communityOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[1100] flex items-center justify-center bg-slate-950/55 p-3 backdrop-blur-xs"
          onClick={() => setCommunityOpen(false)}
        >
          <form
            onSubmit={(e) => void handleSubmitCommunityAlert(e)}
            className="w-full max-w-md space-y-3 rounded-3xl border border-line bg-surface p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-extrabold text-ink">Báo cảnh báo cộng đồng nhanh</h2>
              <button type="button" onClick={() => setCommunityOpen(false)} className="text-muted hover:text-ink">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div style={{ position: 'absolute', left: '-9999px', width: '1px', height: '1px', overflow: 'hidden' }} aria-hidden="true">
              <input
                type="text"
                name="website"
                tabIndex={-1}
                autoComplete="off"
                value={commHoneypot}
                onChange={(e) => setCommHoneypot(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <select
                value={commCategory}
                onChange={(e) => setCommCategory(e.target.value as AlertCategory)}
                className="field !min-h-10 text-xs"
              >
                <option value="disaster">Ngập lụt / Cây đổ / Sạt lở</option>
                <option value="traffic">Tai nạn / Kẹt xe nghiêm trọng</option>
                <option value="utility">Cúp điện / Vỡ ống nước</option>
              </select>
              <select
                value={commSeverity}
                onChange={(e) => setCommSeverity(Number(e.target.value) as 1 | 2)}
                className="field !min-h-10 text-xs"
              >
                <option value={1}>Mức 1 · Chú ý</option>
                <option value={2}>Mức 2 · Cảnh báo</option>
              </select>
            </div>
            <select
              value={commWardCode}
              onChange={(e) => setCommWardCode(e.target.value)}
              className="field !min-h-10 text-xs"
            >
              {DONG_NAI_WARDS.map((w) => (
                <option key={w.wardCode} value={w.wardCode}>{w.name}</option>
              ))}
            </select>
            <input
              required
              minLength={5}
              value={commTitle}
              onChange={(e) => setCommTitle(e.target.value)}
              placeholder="Tiêu đề ngắn gọn (VD: Ngập nửa bánh xe ngã ba Bồn Nước)"
              className="field !min-h-10 text-sm"
            />
            <textarea
              required
              minLength={8}
              rows={3}
              value={commDesc}
              onChange={(e) => setCommDesc(e.target.value)}
              placeholder="Mô tả mức độ nguy hiểm, điểm ngập hoặc hướng xe cần tránh..."
              className="field text-sm"
            />
            <input
              value={commRoads}
              onChange={(e) => setCommRoads(e.target.value)}
              placeholder="Tên tuyến đường (tùy chọn, VD: QL1A, Bùi Văn Hòa)"
              className="field !min-h-10 text-sm"
            />
            <button type="submit" disabled={savingComm} className="btn btn-primary w-full">
              {savingComm ? <Spinner /> : 'Gửi cảnh báo (đã xác thực PoW)'}
            </button>
          </form>
        </div>
      )}

      <WardInspectorDrawer wardCode={inspectWardCode} onClose={() => setInspectWardCode(null)} />
    </div>
  );
}
