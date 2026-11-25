import {
  AlertTriangle,
  Bell,
  BellRing,
  CheckCircle2,
  Clock,
  CloudRain,
  ExternalLink,
  Layers,
  MapPin,
  Thermometer,
  X,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClientReport, WardOverviewResponse } from '@shared/types';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { fastFetch } from '../lib/swrCache';
import { useFollowedWards } from '../lib/followedWards';
import type { MapPoint } from '../lib/mapConfig';
import { useToast } from '../state/toast';
import { ReportCard } from './ReportCard';
import { Spinner } from './ui';

const UnifiedMapCanvas = lazy(() =>
  import('./map/UnifiedMapCanvas').then((m) => ({ default: m.UnifiedMapCanvas })),
);

const ReportDetail = lazy(() =>
  import('./ReportDetail').then((m) => ({ default: m.ReportDetail })),
);

const STATUS_STYLE = {
  'Ổn định': 'bg-emerald-500/15 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300',
  'Cần chú ý': 'bg-amber-500/15 text-amber-800 ring-amber-500/30 dark:text-amber-300',
  'Điểm nóng': 'bg-rose-500/15 text-rose-700 ring-rose-500/30 dark:text-rose-300',
} as const;

const SEVERITY_BADGE = {
  1: { label: 'Mức 1 · Chú ý', cls: 'bg-amber-500/15 text-amber-800 border-amber-500/30' },
  2: { label: 'Mức 2 · Cảnh báo', cls: 'bg-orange-500/15 text-orange-800 border-orange-500/30' },
  3: { label: 'Mức 3 · Khẩn cấp', cls: 'bg-rose-600/15 text-rose-700 border-rose-600/35' },
} as const;

interface WardInspectorDrawerProps {
  wardCode: string | null;
  onClose: () => void;
}

/**
 * Ngăn kéo / Modal Hồ sơ Xã/Phường (Area Inspector & Heatmap):
 * Hiển thị số liệu thật 30 ngày từ MongoDB, lớp bản đồ nhiệt Heatmap tương tác,
 * sự cố theo trạng thái và luồng cảnh báo/thông báo chính thống tại địa bàn.
 */
export function WardInspectorDrawer({ wardCode, onClose }: WardInspectorDrawerProps) {
  const { fmtDate } = useI18n();
  const toast = useToast();
  const { isFollowing, toggleFollowWard } = useFollowedWards();

  const [data, setData] = useState<WardOverviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'incidents' | 'alerts'>('incidents');
  const [incFilter, setIncFilter] = useState<'all' | 'open' | 'resolved'>('all');
  const [page, setPage] = useState(1);
  const [mapMode, setMapMode] = useState<'heat' | 'pins'>('heat');
  const [openReportId, setOpenReportId] = useState<string | null>(null);
  const prevWardRef = useRef<string | null>(null);

  const loadOverview = useCallback(async (code: string, status: 'all' | 'open' | 'resolved', pg: number) => {
    const path = `/api/wards/${encodeURIComponent(code)}/overview?status=${status}&page=${pg}&pageSize=12`;
    let active = true;
    setError(null);
    setLoading(true);
    try {
      const res = await fastFetch<WardOverviewResponse>(path, () => api<WardOverviewResponse>(path), {
        staleMs: 25_000,
        onUpdate: (fresh) => {
          if (active) setData(fresh);
        },
      });
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không tải được hồ sơ xã/phường.');
    } finally {
      setLoading(false);
    }
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!wardCode) {
      prevWardRef.current = null;
      return;
    }
    const wardChanged = prevWardRef.current !== wardCode;
    prevWardRef.current = wardCode;
    if (wardChanged && (page !== 1 || incFilter !== 'all')) {
      setPage(1);
      setIncFilter('all');
      setTab('incidents');
      return;
    }
    if (wardChanged) {
      setTab('incidents');
    }
    void loadOverview(wardCode, wardChanged ? 'all' : incFilter, wardChanged ? 1 : page);
  }, [wardCode, incFilter, page, loadOverview]);

  const mapPoints = useMemo<MapPoint[]>(() => {
    if (!data) return [];
    const fromHeat = data.heatmapPoints.map(([lat, lng, intensity], i) => ({
      id: `wh-${i}`,
      code: data.ward.wardCode,
      category: 'ngap_nuoc' as const,
      title: data.ward.name,
      priority: intensity >= 0.85 ? ('emergency' as const) : intensity >= 0.6 ? ('high' as const) : ('normal' as const),
      emergencyLevel: intensity >= 0.85 ? (1 as const) : (0 as const),
      isEmergency: intensity >= 0.85,
      clusterCount: 1,
      status: 'received' as const,
      wardCode: data.ward.wardCode,
      lat,
      lng,
      severity: Math.min(5, Math.max(1, Math.round(intensity * 5))) as 1 | 2 | 3 | 4 | 5,
      createdAt: new Date().toISOString(),
    }));
    const fromIncidents: MapPoint[] = data.incidents.items.map((r) => ({
      id: r.id,
      code: r.code,
      category: r.category,
      title: r.title,
      priority: r.priority,
      emergencyLevel: r.emergencyLevel,
      isEmergency: r.isEmergency,
      clusterCount: r.clusterCount,
      status: r.status,
      wardCode: r.wardCode,
      lat: r.lat,
      lng: r.lng,
      severity: r.severity,
      createdAt: r.createdAt,
    }));
    return mapMode === 'heat' && fromHeat.length > 0 ? fromHeat : fromIncidents;
  }, [data, mapMode]);

  if (!wardCode) return null;
  const following = isFollowing(wardCode);

  const handleToggleFollow = async (): Promise<void> => {
    const added = await toggleFollowWard(wardCode);
    toast(
      'success',
      added ? `Đã theo dõi ${data?.ward.name ?? wardCode}` : `Đã bỏ theo dõi ${data?.ward.name ?? wardCode}`,
      added ? 'Khu vực sẽ được ghim lên đầu Trang chủ.' : undefined,
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ward-inspector-title"
      className="fixed inset-0 z-[1050] flex justify-end bg-slate-950/50 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-2xl flex-col overflow-hidden bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-line bg-surface-2/80 px-4 py-3.5 sm:px-5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-bold text-brand">
                <MapPin className="h-3.5 w-3.5" aria-hidden />
                {wardCode}
              </span>
              {data?.ward.upgradedOn2026 && (
                <span className="rounded-full bg-sky-500/15 px-2.5 py-0.5 text-[11px] font-bold text-sky-700">
                  Phường mới 2026
                </span>
              )}
              {data && (
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-extrabold ring-1 ${STATUS_STYLE[data.stats30d.areaStatus]}`}>
                  {data.stats30d.areaStatus}
                </span>
              )}
            </div>
            <h2 id="ward-inspector-title" className="mt-1 truncate text-lg font-extrabold text-ink sm:text-xl">
              {data?.ward.name ?? `Đang tải hồ sơ ${wardCode}…`}
            </h2>
            {data?.weather && (
              <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted">
                <span className="inline-flex items-center gap-1">
                  <CloudRain className="h-3.5 w-3.5 text-brand" aria-hidden />
                  {data.weather.weatherLabel} · {data.weather.temperatureC}°C · Mưa {data.weather.precipitationMm}mm/h
                </span>
                <span>Nguồn: {data.weather.source}</span>
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void handleToggleFollow()}
              className={`btn !min-h-9 !px-3 !text-xs ${following ? 'btn-primary' : 'btn-soft'}`}
            >
              {following ? <BellRing className="h-4 w-4" aria-hidden /> : <Bell className="h-4 w-4" aria-hidden />}
              <span>{following ? 'Đang theo dõi' : 'Theo dõi khu vực này'}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Đóng hồ sơ xã/phường"
              className="grid h-9 w-9 place-items-center rounded-full border border-line text-muted hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
          {loading && !data ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted">
              <Spinner /> Đang tổng hợp số liệu thật từ MongoDB…
            </div>
          ) : error && !data ? (
            <div className="rounded-2xl border border-danger/30 bg-danger-soft p-4 text-sm font-semibold text-danger">
              {error}
            </div>
          ) : data ? (
            <>
              {/* 3 Thẻ thống kê số liệu thật 30 ngày */}
              <div className="grid grid-cols-3 gap-2.5">
                <div className="card p-3">
                  <p className="text-[11px] font-semibold text-muted">Phản ánh 30 ngày</p>
                  <p className="mono mt-1 text-xl font-extrabold text-ink">{data.stats30d.totalReports}</p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    {data.stats30d.openReports} đang mở · {data.stats30d.emergencyReports} khẩn cấp
                  </p>
                </div>
                <div className="card p-3">
                  <p className="text-[11px] font-semibold text-muted">Tỷ lệ đã xử lý</p>
                  <p className="mono mt-1 text-xl font-extrabold text-ok">{data.stats30d.resolvedPct}%</p>
                  <p className="mt-0.5 text-[11px] text-muted">{data.stats30d.resolvedReports} hồ sơ hoàn thành</p>
                </div>
                <div className="card p-3">
                  <p className="text-[11px] font-semibold text-muted">TB xử lý (giờ)</p>
                  <p className="mono mt-1 text-xl font-extrabold text-brand">
                    {data.stats30d.avgResolutionHours !== null ? `${data.stats30d.avgResolutionHours}h` : 'Chưa có'}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted">Từ dữ liệu nghiệm thu thật</p>
                </div>
              </div>

              {/* Bản đồ Heatmap & Điểm nóng khu vực */}
              <div className="card overflow-hidden p-2.5">
                <div className="mb-2 flex items-center justify-between gap-2 px-1">
                  <span className="text-xs font-bold text-ink">
                    Bản đồ khu vực {data.ward.shortName} ({data.heatmapPoints.length} điểm dữ liệu 30 ngày)
                  </span>
                  <div className="inline-flex rounded-xl border border-line bg-surface-2 p-0.5">
                    <button
                      type="button"
                      onClick={() => setMapMode('heat')}
                      className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-bold ${
                        mapMode === 'heat' ? 'bg-brand text-white' : 'text-muted hover:text-ink'
                      }`}
                    >
                      <Thermometer className="h-3.5 w-3.5" aria-hidden /> Heatmap
                    </button>
                    <button
                      type="button"
                      onClick={() => setMapMode('pins')}
                      className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-bold ${
                        mapMode === 'pins' ? 'bg-brand text-white' : 'text-muted hover:text-ink'
                      }`}
                    >
                      <Layers className="h-3.5 w-3.5" aria-hidden /> Ghim
                    </button>
                  </div>
                </div>
                <Suspense fallback={<div className="h-52 animate-pulse rounded-xl bg-surface-2" />}>
                  <UnifiedMapCanvas
                    reports={mapPoints}
                    mode={mapMode}
                    initialCenter={[data.ward.centerLat, data.ward.centerLng]}
                    initialZoom={13}
                    onSelect={(pt) => {
                      if (!pt.id.startsWith('wh-')) setOpenReportId(pt.id);
                    }}
                    showLayerSwitcher={false}
                    showFitCityButton={false}
                    className="h-52 rounded-xl"
                    ariaLabel={`Bản đồ nhiệt ${data.ward.name}`}
                  />
                </Suspense>
              </div>

              {/* Tabs */}
              <div className="grid grid-cols-2 gap-1.5 rounded-2xl border border-line bg-surface-2 p-1">
                <button
                  type="button"
                  onClick={() => setTab('incidents')}
                  className={`rounded-xl py-2 text-xs font-bold transition-colors sm:text-sm ${
                    tab === 'incidents' ? 'bg-surface text-brand shadow-xs' : 'text-muted hover:text-ink'
                  }`}
                >
                  Sự cố tại địa bàn ({data.incidents.total})
                </button>
                <button
                  type="button"
                  onClick={() => setTab('alerts')}
                  className={`rounded-xl py-2 text-xs font-bold transition-colors sm:text-sm ${
                    tab === 'alerts' ? 'bg-surface text-brand shadow-xs' : 'text-muted hover:text-ink'
                  }`}
                >
                  Cảnh báo & Tin chính thống ({data.alerts.length + data.bulletins.length})
                </button>
              </div>

              {tab === 'incidents' && (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-1.5">
                    {([
                      ['all', 'Tất cả'],
                      ['open', 'Đang xử lý'],
                      ['resolved', 'Đã hoàn thành'],
                    ] as const).map(([k, label]) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => {
                          setIncFilter(k);
                          setPage(1);
                        }}
                        className={`chip !min-h-8 !text-xs ${incFilter === k ? 'bg-brand text-white border-brand' : ''}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {data.incidents.items.length === 0 ? (
                    <div className="rounded-2xl border border-line bg-surface-2/60 p-6 text-center text-sm text-muted">
                      Chưa ghi nhận phản ánh phù hợp trong bộ lọc này.
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      {data.incidents.items.map((r) => (
                        <ReportCard
                          key={r.id}
                          r={r as unknown as ClientReport}
                          onOpen={(item) => setOpenReportId(item.id)}
                        />
                      ))}
                    </div>
                  )}

                  {(page > 1 || data.incidents.hasMore) && (
                    <div className="flex items-center justify-between pt-1">
                      <button
                        type="button"
                        disabled={page <= 1}
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        className="btn btn-ghost !min-h-9 !px-3 !text-xs"
                      >
                        Trang trước
                      </button>
                      <span className="text-xs font-semibold text-muted">Trang {page}</span>
                      <button
                        type="button"
                        disabled={!data.incidents.hasMore}
                        onClick={() => setPage((p) => p + 1)}
                        className="btn btn-ghost !min-h-9 !px-3 !text-xs"
                      >
                        Trang tiếp
                      </button>
                    </div>
                  )}
                </div>
              )}

              {tab === 'alerts' && (
                <div className="space-y-3">
                  {data.alerts.length === 0 && data.bulletins.length === 0 && (
                    <div className="rounded-2xl border border-line bg-surface-2/60 p-6 text-center text-sm text-muted">
                      Hiện chưa có cảnh báo thiên tai, giao thông hay thông báo mới nào tại {data.ward.shortName}.
                    </div>
                  )}
                  {data.alerts.map((a) => {
                    const sev = SEVERITY_BADGE[a.severity];
                    return (
                      <div key={a.id} className="card space-y-2 p-3.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${sev.cls}`}>
                            {sev.label}
                          </span>
                          <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted">
                            {a.isVerifiedOfficial ? <CheckCircle2 className="h-3 w-3 text-ok" /> : <AlertTriangle className="h-3 w-3 text-amber-600" />}
                            {a.sourceLabel}
                          </span>
                          <span className="ml-auto text-[11px] text-muted">{fmtDate(a.createdAt, true)}</span>
                        </div>
                        <p className="font-bold text-ink">{a.title}</p>
                        <p className="text-xs leading-relaxed text-muted">{a.description}</p>
                        {a.detourNote && (
                          <p className="rounded-xl bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-800">
                            Hướng dẫn né tránh: {a.detourNote}
                          </p>
                        )}
                        {a.sourceUrl && (
                          <a
                            href={a.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs font-bold text-brand hover:underline"
                          >
                            <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Xem nguồn gốc
                          </a>
                        )}
                      </div>
                    );
                  })}

                  {data.bulletins.map((b) => (
                    <div key={b.id} className="card space-y-1.5 border-l-4 border-l-brand p-3.5">
                      <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
                        <span className="font-bold text-brand">{b.sourceName}</span>
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" aria-hidden />
                          {fmtDate(b.publishedAt, true)}
                        </span>
                      </div>
                      <p className="font-bold text-ink">{b.title}</p>
                      <p className="text-xs leading-relaxed text-muted">{b.cleanSummary}</p>
                      <a
                        href={b.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-bold text-brand hover:underline"
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Đối chiếu bài gốc
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>

      {openReportId && (
        <Suspense fallback={null}>
          <ReportDetail id={openReportId} onClose={() => setOpenReportId(null)} />
        </Suspense>
      )}
    </div>
  );
}
