import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  CloudLightning,
  CloudRain,
  CloudSun,
  Compass,
  Droplets,
  ExternalLink,
  Gauge,
  Layers,
  LocateFixed,
  MapPin,
  Moon,
  Newspaper,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Search,
  ShieldAlert,
  Sparkles,
  Sun,
  Sunrise,
  Sunset,
  Thermometer,
  ThumbsUp,
  Trash2,
  Umbrella,
  Wind,
  X,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { normalizeRole } from '@shared/constants';
import { decodeHtmlEntities } from '../lib/htmlDecode';
import { inDongNaiBBox } from '@shared/geo';
import { DynamicWeatherBackdrop, getWeatherCardGradient } from '../components/DynamicWeatherBackdrop';
import type {
  AlertCategory,
  AlertSeverity,
  CivicAlertItem,
  DailyDigestItem,
  OfficialBulletinItem,
  RouteCheckResponse,
} from '@shared/types';
import { DONG_NAI_WARDS, QUICK_JUMP_REGIONS, WARD_BY_CODE } from '../data/dongNaiWards';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { fastFetch } from '../lib/swrCache';
import { useSession } from '../lib/authStore';
import { resolvePlaceSuggestion, searchPlacesDongNai, type PlaceSuggestion } from '../lib/geoClient';
import {
  fetchDongNaiRegionalStations,
  fetchDongNaiWeather,
  searchOpenMeteoLocations,
  type DongNaiWeather,
  type RegionalStationWeather,
  type WeatherKind,
} from '../lib/weather';
import { useAuthGate } from '../state/authGate';
import { useSettings } from '../state/settings';
import { useToast } from '../state/toast';
import type { CameraCommand } from '../components/map/GoogleMapEngine';
import { Spinner } from '../components/ui';

function WeatherGlyph({ kind, isDay = true, className = 'h-6 w-6' }: { kind: WeatherKind; isDay?: boolean; className?: string }) {
  switch (kind) {
    case 'sun':
      return isDay ? (
        <Sun className={`${className} text-amber-300`} aria-hidden />
      ) : (
        <Moon className={`${className} text-indigo-200`} aria-hidden />
      );
    case 'partlyCloudy':
      return isDay ? (
        <CloudSun className={`${className} text-amber-200`} aria-hidden />
      ) : (
        <Moon className={`${className} text-sky-200`} aria-hidden />
      );
    case 'cloud':
      return <Cloud className={`${className} text-sky-200`} aria-hidden />;
    case 'rain':
      return <CloudRain className={`${className} text-sky-300`} aria-hidden />;
    case 'heavyRain':
      return <Umbrella className={`${className} text-cyan-300`} aria-hidden />;
    case 'storm':
      return <CloudLightning className={`${className} text-yellow-300`} aria-hidden />;
  }
}

function WeatherGlyphInk({ kind, isDay = true, className = 'h-5 w-5' }: { kind: WeatherKind; isDay?: boolean; className?: string }) {
  switch (kind) {
    case 'sun':
      return isDay ? (
        <Sun className={`${className} text-amber-500`} aria-hidden />
      ) : (
        <Moon className={`${className} text-indigo-500`} aria-hidden />
      );
    case 'partlyCloudy':
      return isDay ? (
        <CloudSun className={`${className} text-amber-500`} aria-hidden />
      ) : (
        <Moon className={`${className} text-sky-600`} aria-hidden />
      );
    case 'cloud':
      return <Cloud className={`${className} text-slate-500`} aria-hidden />;
    case 'rain':
      return <CloudRain className={`${className} text-sky-600`} aria-hidden />;
    case 'heavyRain':
      return <Umbrella className={`${className} text-blue-600`} aria-hidden />;
    case 'storm':
      return <CloudLightning className={`${className} text-amber-600`} aria-hidden />;
  }
}

function formatPubDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${hh}:${mm} ${dd}/${mo}/${yyyy}`;
}

function weatherKindFallbackGradient(): string {
  return 'linear-gradient(135deg, #1e3a8a 0%, #0f172a 100%)';
}

const WardInspectorDrawer = lazy(() =>
  import('../components/WardInspectorDrawer').then((m) => ({ default: m.WardInspectorDrawer })),
);
const UnifiedMapCanvas = lazy(() =>
  import('../components/map/UnifiedMapCanvas').then((m) => ({ default: m.UnifiedMapCanvas })),
);

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

const ARTERIAL_FOCUS_COORDS: Record<string, { lat: number; lng: number; zoom: number }> = {
  'Quốc lộ 1A': { lat: 10.955, lng: 106.92, zoom: 12.5 },
  'Quốc lộ 51': { lat: 10.8213, lng: 106.9419, zoom: 12.8 },
  'Quốc lộ 20': { lat: 11.1486, lng: 107.2358, zoom: 12.2 },
  'Võ Nguyên Giáp': { lat: 10.9035, lng: 106.9055, zoom: 13.5 },
  'Đồng Khởi': { lat: 10.9679, lng: 106.8537, zoom: 14 },
  'Phạm Văn Thuận': { lat: 10.9567, lng: 106.8451, zoom: 14.2 },
  'Bùi Văn Hòa': { lat: 10.9102, lng: 106.8899, zoom: 13.8 },
  'ĐT 768': { lat: 11.045, lng: 106.94, zoom: 13 },
};

export default function AlertsPage() {
  const { fmtDate, lang } = useI18n();
  const { settings } = useSettings();
  const { requireAuth } = useAuthGate();
  const session = useSession();
  const toast = useToast();
  const [confirmingAlertId, setConfirmingAlertId] = useState<string | null>(null);

  const selectedWard = settings.scope.startsWith('ward:')
    ? WARD_BY_CODE[settings.scope.replace('ward:', '')]
    : undefined;
  const defaultWard = selectedWard ?? WARD_BY_CODE['DN-TB'] ?? DONG_NAI_WARDS[0];

  const [weatherLoc, setWeatherLoc] = useState<{
    label: string;
    detailAddress?: string;
    lat: number;
    lng: number;
    wardCode?: string;
    isGps?: boolean;
    accuracyM?: number;
  }>(() => ({
    label: defaultWard.name,
    lat: defaultWard.centerLat,
    lng: defaultWard.centerLng,
    wardCode: defaultWard.wardCode,
  }));
  const [gpsBusy, setGpsBusy] = useState(false);

  useEffect(() => {
    if (selectedWard) {
      setWeatherLoc({
        label: selectedWard.name,
        lat: selectedWard.centerLat,
        lng: selectedWard.centerLng,
        wardCode: selectedWard.wardCode,
      });
    }
  }, [selectedWard]);

  const forecastCoords = useMemo(
    () => ({ lat: weatherLoc.lat, lng: weatherLoc.lng }),
    [weatherLoc.lat, weatherLoc.lng],
  );
  const forecastAreaName = weatherLoc.label;

  const detectGpsWeather = useCallback(
    (silent = false) => {
      if (typeof navigator === 'undefined' || !navigator.geolocation) {
        if (!silent) toast('error', 'Trình duyệt không hỗ trợ định vị GPS');
        return;
      }
      setGpsBusy(true);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude, accuracy } = pos.coords;
          const insideDn = inDongNaiBBox(latitude, longitude);
          let nearest = DONG_NAI_WARDS[0];
          if (insideDn) {
            let bestDist = Infinity;
            for (const w of DONG_NAI_WARDS) {
              const d = (w.centerLat - latitude) ** 2 + (w.centerLng - longitude) ** 2;
              if (d < bestDist) {
                bestDist = d;
                nearest = w;
              }
            }
          }
          const accM = Number.isFinite(accuracy) ? Math.round(accuracy) : undefined;
          setWeatherLoc({
            label: insideDn ? `Vị trí hiện tại · ${nearest.name}` : 'Vị trí hiện tại (GPS)',
            lat: latitude,
            lng: longitude,
            wardCode: insideDn ? nearest.wardCode : undefined,
            isGps: true,
            accuracyM: accM,
          });
          setGpsBusy(false);

          // Reverse-geocode lấy tên đường / khu vực cụ thể từ tọa độ GPS
          void fetch(
            `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude.toFixed(5)}&lon=${longitude.toFixed(5)}&accept-language=vi`,
          )
            .then((r) => (r.ok ? r.json() : null))
            .then((geo: { address?: Record<string, string> } | null) => {
              const a = geo?.address;
              if (!a) return;
              const parts = [
                a.road || a.pedestrian || a.neighbourhood,
                a.suburb || a.quarter || a.village || a.town,
                a.city || a.county || a.state,
              ].filter(Boolean);
              if (parts.length > 0) {
                const fullAddr = Array.from(new Set(parts)).join(', ');
                setWeatherLoc((prev) =>
                  prev.isGps && prev.lat === latitude && prev.lng === longitude
                    ? { ...prev, label: insideDn ? prev.label : fullAddr, detailAddress: fullAddr }
                    : prev,
                );
              }
            })
            .catch(() => undefined);
        },
        () => {
          setGpsBusy(false);
          if (!silent) {
            toast('info', 'Không lấy được GPS — vui lòng cấp quyền vị trí hoặc chọn Phường/Xã.');
          }
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 },
      );
    },
    [toast],
  );

  // Tự động truy cập GPS khi mở trang Cảnh báo (nếu người dùng chưa khóa sẵn 1 Phường/Xã)
  useEffect(() => {
    if (!selectedWard) {
      detectGpsWeather(true);
    }
    // Chỉ chạy một lần khi mở trang
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [forecast, setForecast] = useState<DongNaiWeather | null>(null);
  const [forecastLoading, setForecastLoading] = useState(true);
  const [forecastError, setForecastError] = useState<string | null>(null);
  const [weatherQuery, setWeatherQuery] = useState('');
  const [weatherSuggestions, setWeatherSuggestions] = useState<PlaceSuggestion[]>([]);
  const [weatherSearchOpen, setWeatherSearchOpen] = useState(false);
  const forecastAbortRef = useRef<AbortController | null>(null);
  const lastFetchedCoordKeyRef = useRef<string | null>(null);
  const weatherTopRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const q = weatherQuery.trim();
    if (!q) {
      setWeatherSuggestions([]);
      return;
    }
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      void Promise.all([
        searchOpenMeteoLocations(q, lang, ctrl.signal),
        searchPlacesDongNai(q, ctrl.signal),
      ]).then(([omItems, dnItems]) => {
        if (ctrl.signal.aborted) return;
        const merged: PlaceSuggestion[] = [];
        // Ưu tiên 95 Phường/Xã Đồng Nai khớp trực tiếp, sau đó tới Open-Meteo Geocoding và địa điểm chi tiết
        const wardsFirst = dnItems.filter((x) => x.kind === 'ward');
        const otherPlaces = [...omItems, ...dnItems.filter((x) => x.kind !== 'ward')];
        const seen = new Set<string>();
        for (const item of [...wardsFirst, ...otherPlaces]) {
          const k = `${item.label.toLowerCase()}:${item.lat?.toFixed(2) ?? ''}:${item.lng?.toFixed(2) ?? ''}`;
          if (seen.has(k)) continue;
          seen.add(k);
          merged.push(item);
        }
        setWeatherSuggestions(merged.slice(0, 10));
      });
    }, 220);
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [weatherQuery, lang]);

  const handlePickWeatherPlace = async (item: PlaceSuggestion): Promise<void> => {
    setWeatherSearchOpen(false);
    setWeatherQuery(item.label);
    const resolved = await resolvePlaceSuggestion(item);
    if (!resolved) return;
    setWeatherLoc({
      label: item.label,
      detailAddress: item.sublabel ? `${item.label} · ${item.sublabel}` : item.label,
      lat: resolved.lat,
      lng: resolved.lng,
      wardCode: resolved.wardCode,
    });
  };

  const coordKey = `${forecastCoords.lat.toFixed(4)}:${forecastCoords.lng.toFixed(4)}`;

  const loadForecast = useCallback(async () => {
    forecastAbortRef.current?.abort();
    const ctrl = new AbortController();
    forecastAbortRef.current = ctrl;
    // Nếu đổi sang tọa độ mới, xóa số liệu của vị trí cũ để tránh hiển thị nhầm trong lúc đang tải
    if (lastFetchedCoordKeyRef.current !== coordKey) {
      setForecast(null);
    }
    setForecastLoading(true);
    setForecastError(null);
    try {
      const data = await fetchDongNaiWeather(forecastCoords.lat, forecastCoords.lng, lang, ctrl.signal);
      if (!ctrl.signal.aborted) {
        lastFetchedCoordKeyRef.current = coordKey;
        setForecast(data);
        setForecastError(null);
      }
    } catch (err) {
      if (!ctrl.signal.aborted) {
        setForecast(null);
        setForecastError(err instanceof Error ? err.message : 'Không kết nối được máy chủ khí tượng.');
      }
    } finally {
      if (!ctrl.signal.aborted) {
        setForecastLoading(false);
      }
    }
  }, [coordKey, forecastCoords.lat, forecastCoords.lng, lang]);

  useEffect(() => {
    void loadForecast();
    return () => {
      forecastAbortRef.current?.abort();
    };
  }, [loadForecast]);

  const role = session?.user ? normalizeRole(session.user.role) : null;
  const isStaffOrRescue = role === 'admin' || role === 'officer' || role === 'rescue';
  const isAdmin = role === 'admin';

  const [weather, setWeather] = useState<RegionalStationWeather[]>([]);
  const [weatherSyncAt, setWeatherSyncAt] = useState<string | null>(null);
  const [stationsError, setStationsError] = useState<string | null>(null);
  const [stationsLoading, setStationsLoading] = useState(true);
  const [alerts, setAlerts] = useState<CivicAlertItem[]>([]);
  const [bulletins, setBulletins] = useState<OfficialBulletinItem[]>([]);
  const [digest, setDigest] = useState<DailyDigestItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [filterGroup, setFilterGroup] = useState<FilterGroup>('all');
  const [selectedAlert, setSelectedAlert] = useState<CivicAlertItem | null>(null);
  const [inspectWardCode, setInspectWardCode] = useState<string | null>(null);

  // Route Check & Alerts Map Camera
  const [roadInput, setRoadInput] = useState('');
  const [routeChecking, setRouteChecking] = useState(false);
  const [routeResult, setRouteResult] = useState<RouteCheckResponse | null>(null);
  const [alertsMapCam, setAlertsMapCam] = useState<CameraCommand | null>(null);

  const pushAlertsMapCam = useCallback((cmd: Omit<CameraCommand, 'seq'>) => {
    setAlertsMapCam((prev) => ({ ...cmd, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

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

  const loadRegionalStations = useCallback(async () => {
    setStationsLoading(true);
    setStationsError(null);
    try {
      const res = await fetchDongNaiRegionalStations(lang);
      setWeather(res.items);
      setWeatherSyncAt(res.lastSyncAt);
    } catch (err) {
      setWeather([]);
      setStationsError(err instanceof Error ? err.message : 'Chưa có dữ liệu trạm đo khu vực.');
    } finally {
      setStationsLoading(false);
    }
  }, [lang]);

  const loadAll = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setFeedError(null);
    setStationsLoading(true);
    setStationsError(null);
    let active = true;
    try {
      const [wRes, aRes, bRes, dRes] = await Promise.allSettled([
        fetchDongNaiRegionalStations(lang),
        fastFetch<{ items: CivicAlertItem[] }>(
          '/api/alerts?status=active&limit=100',
          () => api('/api/alerts?status=active&limit=100'),
          {
            staleMs: 30_000,
            forceRefresh,
            onUpdate: (fresh) => {
              if (active) setAlerts(fresh.items);
            },
          },
        ),
        fastFetch<{ items: OfficialBulletinItem[] }>(
          '/api/bulletins?limit=30',
          () => api('/api/bulletins?limit=30'),
          {
            staleMs: 60_000,
            forceRefresh,
            onUpdate: (fresh) => {
              if (active) setBulletins(fresh.items);
            },
          },
        ),
        fastFetch<DailyDigestItem>(
          '/api/ai/daily-digest',
          () => api('/api/ai/daily-digest'),
          {
            staleMs: 120_000,
            forceRefresh,
            onUpdate: (fresh) => {
              if (active) setDigest(fresh);
            },
          },
        ),
      ]);
      if (wRes.status === 'fulfilled') {
        setWeather(wRes.value.items);
        setWeatherSyncAt(wRes.value.lastSyncAt);
        setStationsError(null);
      } else {
        setWeather([]);
        setStationsError(wRes.reason instanceof Error ? wRes.reason.message : 'Chưa có dữ liệu trạm đo khu vực.');
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
      if (aRes.status === 'rejected' && bRes.status === 'rejected') {
        setFeedError('Mất kết nối mạng hoặc máy chủ tin tức tạm gián đoạn. Vui lòng thử lại.');
      }
    } finally {
      setLoading(false);
      setStationsLoading(false);
    }
    return () => {
      active = false;
    };
  }, [lang]);

  useEffect(() => {
    void loadAll();
    const timer = window.setInterval(() => {
      void loadAll(true);
      void loadForecast();
    }, 15 * 60_000);
    return () => window.clearInterval(timer);
  }, [loadAll, loadForecast]);

  const filteredAlerts = useMemo(() => {
    return alerts
      .filter((a) => {
        if (filterGroup === 'disaster') return a.category === 'disaster';
        if (filterGroup === 'traffic') return a.category === 'traffic';
        if (filterGroup === 'utility_official') return a.category === 'utility' || a.category === 'official_notice';
        return true;
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [alerts, filterGroup]);

  const filteredBulletins = useMemo(() => {
    return bulletins
      .filter((b) => {
        if (filterGroup === 'disaster') return b.category === 'disaster';
        if (filterGroup === 'traffic') return b.category === 'traffic';
        if (filterGroup === 'utility_official') return b.category === 'utility' || b.category === 'official_notice';
        return true;
      })
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  }, [bulletins, filterGroup]);

  const runRouteCheck = async (queryText?: string): Promise<void> => {
    const q = (queryText ?? roadInput).trim();
    if (q.length < 2) {
      toast('info', 'Vui lòng nhập tên tuyến đường cần kiểm tra.');
      return;
    }
    setRoadInput(q);
    const focus = ARTERIAL_FOCUS_COORDS[q];
    if (focus) {
      pushAlertsMapCam({ kind: 'flyTo', lat: focus.lat, lng: focus.lng, zoom: focus.zoom });
    }
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
    if (confirmingAlertId !== null) return;
    if (session && al.confirmedByUserIds?.includes(session.user.id)) return;
    if (!(await requireAuth())) return;
    setConfirmingAlertId(al.id);
    try {
      const updated = await api<CivicAlertItem>(`/api/alerts/${encodeURIComponent(al.id)}/confirm`, {
        method: 'POST',
        body: {},
      });
      setAlerts((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      toast('success', 'Đã ghi nhận xác nhận (+1)');
    } catch (err) {
      toast('error', 'Không thể xác nhận', err instanceof Error ? err.message : undefined);
    } finally {
      setConfirmingAlertId(null);
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
      toast('success', 'Đã phát cảnh báo địa hình lên bản đồ toàn thành phố!');
    } catch (err) {
      toast('error', 'Không lưu được cảnh báo', err instanceof Error ? err.message : undefined);
    } finally {
      setSavingDraw(false);
    }
  };

  const handleSubmitCommunityAlert = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (savingComm) return;
    if (!(await requireAuth())) return;
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
    <div className="min-w-0 w-full space-y-4">
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

      {/* ── Giao diện Dự báo Thời tiết chi tiết (Dữ liệu thật theo đúng tọa độ vị trí) ── */}
      {(() => {
        const allTemps = forecast ? forecast.daily.flatMap((d) => [d.tempMin, d.tempMax]) : [20, 36];
        const weekMin = Math.min(...allTemps);
        const weekMax = Math.max(...allTemps);
        const tempSpan = Math.max(1, weekMax - weekMin);
        const uvLabel =
          !forecast || forecast.uvIndex == null
            ? ''
            : forecast.uvIndex >= 11
              ? 'Cực nguy hiểm'
              : forecast.uvIndex >= 8
                ? 'Rất cao'
                : forecast.uvIndex >= 6
                  ? 'Cao'
                  : forecast.uvIndex >= 3
                    ? 'Trung bình'
                    : 'Thấp';
        const uvDisplay =
          !forecast || forecast.uvIndex == null
            ? '--'
            : (Math.round(forecast.uvIndex * 10) / 10).toFixed(1).replace(/\.0$/, '');
        const floodRisk = !forecast
          ? 'Đang kiểm tra'
          : forecast.rainNext3hMm > 20 || (forecast.rainNow ?? 0) > 10
            ? 'Cao – Đề phòng ngập'
            : forecast.rainNext3hMm >= 5 || (forecast.rainNow ?? 0) >= 2
              ? 'Trung bình – Lưu ý'
              : 'Thấp';

        return (
          <div ref={weatherTopRef} className="space-y-4 scroll-mt-20">
            {/* Thanh chọn vị trí thời tiết chi tiết (Tìm bất kỳ nơi đâu / GPS / 95 Phường-Xã / 5 Vùng) */}
            <div className="card flex flex-col gap-2.5 p-3 sm:p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-brand">
                  <MapPin className="h-4 w-4" aria-hidden />
                  Thời tiết chi tiết theo vị trí
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => detectGpsWeather(false)}
                    disabled={gpsBusy}
                    className={`btn !min-h-9 !rounded-xl !px-3 !text-xs ${weatherLoc.isGps ? 'btn-primary' : 'btn-soft'}`}
                  >
                    <LocateFixed className={`h-3.5 w-3.5 ${gpsBusy ? 'animate-spin' : ''}`} aria-hidden />
                    <span>{gpsBusy ? 'Đang định vị GPS…' : weatherLoc.isGps ? 'Cập nhật GPS' : 'Vị trí của tôi (GPS)'}</span>
                  </button>
                  <select
                    aria-label="Chọn Phường/Xã xem thời tiết chi tiết"
                    value={weatherLoc.wardCode ?? ''}
                    onChange={(e) => {
                      const w = WARD_BY_CODE[e.target.value];
                      if (!w) return;
                      setWeatherQuery('');
                      setWeatherLoc({
                        label: w.name,
                        lat: w.centerLat,
                        lng: w.centerLng,
                        wardCode: w.wardCode,
                      });
                    }}
                    className="field !h-9 !min-h-9 w-full min-w-0 max-w-full !rounded-xl !px-2.5 !py-0 !text-xs sm:!w-auto sm:max-w-[15rem]"
                  >
                    <option value="">Chọn Phường/Xã (95 ĐVHC)…</option>
                    {DONG_NAI_WARDS.map((w) => (
                      <option key={w.wardCode} value={w.wardCode}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Ô tìm kiếm bất kỳ địa điểm / thành phố / phường xã nào */}
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden />
                <input
                  type="search"
                  value={weatherQuery}
                  onFocus={() => setWeatherSearchOpen(true)}
                  onBlur={() => window.setTimeout(() => setWeatherSearchOpen(false), 180)}
                  onChange={(e) => setWeatherQuery(e.target.value)}
                  placeholder="Tìm địa điểm bất kỳ để xem thời tiết (VD: Long Thành, Hà Nội, TP.HCM, Đà Lạt…)"
                  aria-label="Tìm địa điểm xem dự báo thời tiết"
                  className="field !min-h-9 !rounded-xl !pl-8 !pr-8 !text-xs"
                />
                {weatherQuery && (
                  <button
                    type="button"
                    onClick={() => setWeatherQuery('')}
                    className="absolute right-1.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-muted hover:bg-surface-2"
                    aria-label="Xóa tìm kiếm"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
                {weatherSearchOpen && weatherSuggestions.length > 0 && (
                  <ul
                    role="listbox"
                    className="absolute inset-x-0 top-full z-[60] mt-1 max-h-56 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-lift"
                  >
                    {weatherSuggestions.map((s) => (
                      <li key={s.id}>
                        <button
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => void handlePickWeatherPlace(s)}
                          className="flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-surface-2"
                        >
                          <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="block font-bold text-ink">{s.label}</span>
                            {s.sublabel && <span className="block truncate text-[11px] text-muted">{s.sublabel}</span>}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {QUICK_JUMP_REGIONS.map((reg) => {
                  const active = !weatherLoc.isGps && !weatherLoc.wardCode && weatherLoc.label === reg.labelVi;
                  return (
                    <button
                      key={reg.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        setWeatherQuery('');
                        setWeatherLoc({
                          label: reg.labelVi,
                          lat: reg.center[0],
                          lng: reg.center[1],
                        });
                      }}
                      className="chip !min-h-7 !px-2.5 !text-[11px]"
                    >
                      {reg.labelVi}
                    </button>
                  );
                })}
              </div>
            </div>

            {!forecast ? (
              <section
                aria-label="Đang tải dự báo thời tiết"
                className="relative overflow-hidden rounded-[1.75rem] p-6 text-white shadow-lift"
                style={{ background: weatherKindFallbackGradient() }}
              >
                <DynamicWeatherBackdrop kind="partlyCloudy" isDay={true} />
                <div className="relative z-10">
                  {forecastError ? (
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-bold">Chưa lấy được dữ liệu dự báo thời tiết thực tế cho {forecastAreaName}</p>
                        <p className="mt-1 text-xs text-white/85">{forecastError}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void loadForecast()}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-white/25 bg-white/15 px-3.5 py-2 text-xs font-bold hover:bg-white/25"
                      >
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Thử lại
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 text-sm font-semibold">
                      <Spinner className="text-white" />
                      <span>
                        Đang tải nhiệt độ & dự báo thời tiết trực tiếp cho <strong>{weatherLoc.detailAddress ?? forecastAreaName}</strong>…
                      </span>
                    </div>
                  )}
                </div>
              </section>
            ) : (
              <>
                <section
                  aria-label="Dự báo thời tiết hiện tại theo vị trí"
                  className="relative overflow-hidden rounded-[1.75rem] p-5 pb-7 text-white shadow-lift transition-colors duration-700 sm:p-6 sm:pb-8"
                  style={{ background: getWeatherCardGradient(forecast.kind, forecast.isDay) }}
                >
                  <DynamicWeatherBackdrop kind={forecast.kind} isDay={forecast.isDay} />
                  <div className="relative z-10 flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-semibold text-white backdrop-blur-md">
                          <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />
                          <span>{weatherLoc.detailAddress ?? forecastAreaName}</span>
                        </span>
                        <span className="mono inline-flex items-center rounded-full border border-white/15 bg-slate-950/35 px-2.5 py-1 text-[10.5px] font-medium text-white/90">
                          {forecastCoords.lat.toFixed(4)}°N, {forecastCoords.lng.toFixed(4)}°E
                          {weatherLoc.accuracyM ? ` · ±${weatherLoc.accuracyM}m` : ''}
                        </span>
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-slate-950/40 px-2.5 py-1 text-[11px] font-semibold text-white">
                          <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden />
                          <span>{forecast.providerLabel}</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => void loadForecast()}
                          disabled={forecastLoading}
                          className="inline-flex items-center gap-1 rounded-full border border-white/20 bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-white/20"
                        >
                          <RefreshCw className={`h-3 w-3 ${forecastLoading ? 'animate-spin' : ''}`} aria-hidden />
                          Làm mới
                        </button>
                      </div>

                      <div className="mt-4 flex items-center gap-4">
                        <div className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl border border-white/[0.16] bg-white/10 backdrop-blur-md sm:h-20 sm:w-20">
                          <WeatherGlyph kind={forecast.kind} isDay={forecast.isDay} className="h-10 w-10 sm:h-12 sm:w-12" />
                        </div>
                        <div>
                          <div className="flex items-baseline gap-2.5">
                            <span className={`mono text-4xl font-extrabold tracking-tight text-white drop-shadow-sm sm:text-5xl ${forecastLoading ? 'opacity-60' : ''}`}>
                              {Math.round(forecast.temp)}°C
                            </span>
                            <span className="text-sm font-bold text-white/95">
                              C: {Math.round(forecast.tempHigh)}° · T: {Math.round(forecast.tempLow)}°
                            </span>
                          </div>
                          <p className="mt-0.5 text-base font-bold text-white sm:text-lg">
                            {lang === 'vi' ? forecast.conditionVi : forecast.conditionEn}
                          </p>
                          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs font-medium text-white/90">
                            <span>Cảm giác như {Math.round(forecast.feelsLike)}°C</span>
                            <span className="inline-flex items-center gap-1">
                              <Sunrise className="h-3.5 w-3.5 text-amber-200" aria-hidden /> {forecast.sunrise}
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <Sunset className="h-3.5 w-3.5 text-orange-200" aria-hidden /> {forecast.sunset}
                            </span>
                            <span>Đo lúc {fmtDate(forecast.observedAt, true)}</span>
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:w-[27rem]">
                      <div className="rounded-2xl border border-white/[0.16] bg-white/10 p-3 pb-4 backdrop-blur-md">
                        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-white/90">
                          <Droplets className="h-3.5 w-3.5 text-sky-200" aria-hidden /> Độ ẩm
                        </p>
                        <p className="mono mt-1 text-lg font-extrabold text-white">
                          {forecast.humidity != null ? `${forecast.humidity}%` : '--'}
                        </p>
                      </div>
                      <div className="rounded-2xl border border-white/[0.16] bg-white/10 p-3 pb-4 backdrop-blur-md">
                        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-white/90">
                          <Umbrella className="h-3.5 w-3.5 text-cyan-200" aria-hidden /> Xác suất mưa
                        </p>
                        {forecast.rainProbNow === 0 && (forecast.rainProbNext3h > 0 || forecast.rainProbMaxToday > 0) ? (
                          <>
                            <p className="mono mt-1 text-lg font-extrabold text-white">
                              {Math.max(forecast.rainProbMaxToday, forecast.rainProbNext3h)}%{' '}
                              <span className="text-xs font-semibold text-white/85">({forecast.rainSumTodayMm}mm)</span>
                            </p>
                            <p className="mt-0.5 text-[11px] font-medium text-white/80">
                              Hiện tại: {forecast.rainNow === 0 ? 'Không mưa (0 mm/h)' : forecast.rainNow != null ? `${forecast.rainNow} mm/h` : '--'}
                            </p>
                          </>
                        ) : (
                          <>
                            <p className="mono mt-1 text-lg font-extrabold text-white">
                              {forecast.rainProbNow}%{' '}
                              <span className="text-xs font-semibold text-white/85">
                                ({forecast.rainNow === 0 ? 'Không mưa (0 mm)' : forecast.rainNow != null ? `${forecast.rainNow}mm` : '--'})
                              </span>
                            </p>
                            {forecast.rainProbMaxToday > forecast.rainProbNow && (
                              <p className="mt-0.5 text-[11px] font-medium text-white/80">
                                Cả ngày: {forecast.rainProbMaxToday}% ({forecast.rainSumTodayMm}mm)
                              </p>
                            )}
                          </>
                        )}
                      </div>
                      <div className="rounded-2xl border border-white/[0.16] bg-white/10 p-3 pb-4 backdrop-blur-md">
                        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-white/90">
                          <Wind className="h-3.5 w-3.5 text-teal-200" aria-hidden /> Gió & Giật
                        </p>
                        <p className="mono mt-1 text-base font-extrabold text-white sm:text-lg">
                          {forecast.windSpeed != null ? forecast.windSpeed : '--'}{' '}
                          <span className="text-xs font-semibold text-white/85">
                            / {forecast.windGusts != null ? `${forecast.windGusts} km/h` : '--'}
                          </span>
                        </p>
                      </div>
                      <div className="rounded-2xl border border-white/[0.16] bg-white/10 p-3 pb-4 backdrop-blur-md">
                        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-white/90">
                          <Sun className="h-3.5 w-3.5 text-amber-200" aria-hidden /> Chỉ số UV
                        </p>
                        <p className="mono mt-1 text-lg font-extrabold text-white">
                          {uvDisplay} <span className="text-xs font-semibold text-white/90">{uvLabel}</span>
                        </p>
                        <p className="mt-0.5 text-[11px] font-medium text-white/80">
                          Đỉnh ngày: {forecast.uvMaxToday != null ? (Math.round(forecast.uvMaxToday * 10) / 10).toFixed(1).replace(/\.0$/, '') : '--'}
                        </p>
                      </div>
                      <div className="rounded-2xl border border-white/[0.16] bg-white/10 p-3 pb-4 backdrop-blur-md">
                        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-white/90">
                          <Gauge className="h-3.5 w-3.5 text-slate-200" aria-hidden /> Áp suất & Mây
                        </p>
                        <p className="mono mt-1 text-sm font-extrabold text-white sm:text-base">
                          {forecast.pressureHpa != null ? `${forecast.pressureHpa} hPa` : '--'} ·{' '}
                          {forecast.cloudCover != null ? `${forecast.cloudCover}%` : '--'}
                        </p>
                      </div>
                      <div className="rounded-2xl border border-white/[0.16] bg-white/10 p-3 pb-4 backdrop-blur-md">
                        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-white/90">
                          <ShieldAlert className="h-3.5 w-3.5 text-amber-300" aria-hidden /> Nguy cơ ngập
                        </p>
                        <p className="mt-1 text-xs font-extrabold text-white sm:text-sm">{floodRisk}</p>
                        <p className="mt-0.5 text-[11px] leading-snug font-medium text-white/80">
                          3h tới: {forecast.rainNext3hMm}mm · Ngày: {forecast.rainSumTodayMm}mm
                        </p>
                      </div>
                    </div>
                  </div>
                </section>

                {/* Dự báo theo giờ (24h) & Dự báo 7 ngày */}
                <div className="grid min-w-0 w-full gap-4 lg:grid-cols-12">
                  <section className="card min-w-0 w-full overflow-hidden p-4 lg:col-span-7" aria-label="Dự báo theo giờ">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                      <h2 className="flex min-w-0 items-center gap-2 text-xs font-extrabold uppercase tracking-wide text-ink sm:text-sm">
                        <Compass className="h-4 w-4 shrink-0 text-brand" aria-hidden />
                        <span className="truncate">Dự báo theo giờ (24 giờ tới)</span>
                      </h2>
                      <span className="max-w-full truncate text-[11px] font-semibold text-muted">{forecastAreaName}</span>
                    </div>
                    <div className="no-scrollbar flex w-full flex-nowrap gap-2 overflow-x-auto overscroll-x-contain pb-1">
                      {forecast.hourly.map((pt, idx) => (
                        <div
                          key={pt.timeIso}
                          className={`flex w-[3.85rem] min-w-[3.85rem] shrink-0 flex-col items-center gap-1.5 rounded-2xl border p-2 text-center ${
                            idx === 0 ? 'border-brand/35 bg-brand-soft/75' : 'border-line/70 bg-surface-2/60'
                          }`}
                        >
                          <span className="mono whitespace-nowrap text-[11px] font-bold text-muted">{pt.hourLabel}</span>
                          <WeatherGlyphInk kind={pt.kind} isDay={pt.isDay} className="h-6 w-6" />
                          <span className="mono text-sm font-extrabold text-ink">{Math.round(pt.temp)}°</span>
                          <span className="mono inline-flex items-center gap-0.5 text-[10px] font-semibold text-sky-700 dark:text-sky-300">
                            <Droplets className="h-3 w-3" aria-hidden />
                            {pt.rainProb}%
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="card min-w-0 w-full p-4 lg:col-span-5" aria-label="Dự báo 7 ngày tới">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <h2 className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-wide text-ink sm:text-sm">
                        <Thermometer className="h-4 w-4 text-brand" aria-hidden /> Dự báo 7 ngày tới
                      </h2>
                      <span className="text-[11px] font-semibold text-muted">Nhiệt độ & Mưa</span>
                    </div>
                    <div className="divide-y divide-line/60">
                      {forecast.daily.map((d) => {
                        const leftPct = ((d.tempMin - weekMin) / tempSpan) * 100;
                        const widthPct = Math.max(10, ((d.tempMax - d.tempMin) / tempSpan) * 100);
                        return (
                          <div key={d.dateIso} className="flex items-center gap-2.5 py-2 first:pt-0 last:pb-0">
                            <span className="w-20 shrink-0 text-xs font-bold text-ink">{d.dayLabel}</span>
                            <WeatherGlyphInk kind={d.kind} className="h-5 w-5 shrink-0" />
                            <span className="mono w-9 shrink-0 text-right text-[11px] font-semibold text-sky-700 dark:text-sky-300">
                              {d.rainProbMax}%
                            </span>
                            <span className="mono w-9 shrink-0 text-right text-xs font-semibold text-muted">{d.tempMin.toFixed(0)}°</span>
                            <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                              <div
                                className="absolute inset-y-0 rounded-full bg-gradient-to-r from-sky-400 via-amber-400 to-orange-500"
                                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                              />
                            </div>
                            <span className="mono w-9 shrink-0 text-xs font-extrabold text-ink">{d.tempMax.toFixed(0)}°</span>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                </div>
              </>
            )}

            {/* Thanh Thời tiết các khu vực trọng điểm Đồng Nai */}
            {(weather.length > 0 || stationsError || stationsLoading) && (
              <section aria-label="Thời tiết và lượng mưa các khu vực Đồng Nai" className="card min-w-0 w-full overflow-hidden p-3.5">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-wide text-brand">
                    <CloudRain className="h-4 w-4 shrink-0" aria-hidden />
                    <span>Trạm đo Khí tượng các khu vực Đồng Nai</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                    <span>
                      {weatherSyncAt ? `Đồng bộ lúc: ${formatPubDateTime(weatherSyncAt)} · Open-Meteo` : 'Open-Meteo'}
                    </span>
                    <button
                      type="button"
                      onClick={() => void loadRegionalStations()}
                      disabled={stationsLoading}
                      className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-ink hover:border-brand/40"
                    >
                      <RefreshCw className={`h-3 w-3 ${stationsLoading ? 'animate-spin' : ''}`} aria-hidden />
                      Làm mới
                    </button>
                  </div>
                </div>
                {stationsError && weather.length === 0 ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface-2/60 p-3 text-xs text-muted">
                    <span>Chưa có dữ liệu trạm đo khu vực ({stationsError}).</span>
                    <button
                      type="button"
                      onClick={() => void loadRegionalStations()}
                      className="btn btn-soft !min-h-8 !px-3 !text-xs"
                    >
                      Thử lại
                    </button>
                  </div>
                ) : (
                  <div className="no-scrollbar -mx-3.5 flex flex-nowrap gap-2.5 overflow-x-auto overscroll-x-contain px-4 pb-1">
                    {weather.map((w) => {
                      const targetWard = WARD_BY_CODE[w.wardCode];
                      const isSelected =
                        !weatherLoc.isGps &&
                        Math.abs(weatherLoc.lat - w.lat) < 0.005 &&
                        Math.abs(weatherLoc.lng - w.lng) < 0.005;
                      const displayTemp =
                        isSelected && forecast ? Math.round(forecast.temp) : w.temperatureC;
                      const displayCondition =
                        isSelected && forecast
                          ? lang === 'vi'
                            ? forecast.conditionVi
                            : forecast.conditionEn
                          : w.weatherLabel;
                      const selectStation = (scrollToTop: boolean) => {
                        setWeatherQuery('');
                        setWeatherLoc({
                          label: targetWard ? `${w.regionName} (${targetWard.shortName})` : w.regionName,
                          lat: w.lat,
                          lng: w.lng,
                          wardCode: w.wardCode,
                        });
                        if (scrollToTop) {
                          weatherTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }
                      };
                      return (
                        <div
                          key={w.regionKey}
                          className={`min-w-[12.5rem] shrink-0 rounded-2xl border p-2.5 text-left transition-colors ${
                            isSelected
                              ? 'border-brand bg-brand-soft/60 ring-1 ring-brand/25'
                              : w.isHazard
                                ? 'border-rose-500/40 bg-rose-500/10'
                                : 'border-line bg-surface-2/75 hover:border-brand/40'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => selectStation(false)}
                            className="w-full text-left"
                          >
                            <div className="flex items-center justify-between gap-1">
                              <span className="truncate text-xs font-bold text-ink">{w.regionName}</span>
                              <span className="mono text-xs font-extrabold text-brand">
                                {displayTemp != null ? `${displayTemp}°C` : '--'}
                              </span>
                            </div>
                            <p className="mt-1 text-[11px] font-semibold text-muted">{displayCondition}</p>
                            <p className="mt-1 text-[11px] font-medium text-ink">
                              {w.precipitationMm === 0
                                ? 'Không mưa (0 mm/h)'
                                : w.precipitationMm != null
                                  ? `Mưa: ${w.precipitationMm} mm/h`
                                  : 'Mưa: --'}
                            </p>
                            <div className="mt-1 flex items-center justify-between text-[11px] text-muted">
                              <span>
                                Ẩm: <strong className="text-ink">{w.humidityPct != null ? `${w.humidityPct}%` : '--'}</strong>
                              </span>
                              <span className="inline-flex items-center gap-0.5">
                                <Wind className="h-3 w-3" aria-hidden />{' '}
                                {w.windGustsKmh != null ? `${w.windGustsKmh}km/h` : '--'}
                              </span>
                            </div>
                          </button>
                          <button
                            type="button"
                            onClick={() => selectStation(true)}
                            className="mt-2 text-[10.5px] font-bold text-brand hover:underline"
                          >
                            Xem hồ sơ khu vực →
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            )}
          </div>
        );
      })()}

      {/* Tóm tắt Thông minh AI 24h */}
      {digest && digest.bullets.length > 0 && (
        <section className="rounded-2xl border border-brand/25 bg-gradient-to-br from-brand-soft/60 via-surface to-sky-500/10 p-4 shadow-card" aria-label="Tóm tắt tình hình 24h">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-brand">
              <Sparkles className="h-4 w-4" aria-hidden /> Tóm tắt Thông minh AI 24h · Thành phố Đồng Nai
            </span>
            <span className="text-[11px] font-medium text-muted">Cập nhật: {fmtDate(digest.generatedAt, true)}</span>
          </div>
          <ul className="space-y-1.5 text-xs leading-relaxed text-ink sm:text-sm">
            {digest.bullets.map((b, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" aria-hidden />
                <span>{decodeHtmlEntities(b).replace(/\b(Toàn\s+)?[Tt]ỉnh Đồng Nai\b/g, '$1Thành phố Đồng Nai')}</span>
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
      <div className="grid min-w-0 w-full gap-4 lg:grid-cols-12">
        {/* Cột Trái: Bản đồ Cảnh báo */}
        <div className="min-w-0 w-full space-y-2.5 lg:col-span-6">
          <div className="flex items-center justify-between text-xs font-bold text-muted">
            <span className="inline-flex items-center gap-1.5">
              <Layers className="h-4 w-4 text-brand" aria-hidden />
              Bản đồ Vùng ngập, Tuyến đường & Cụm cảnh báo ({filteredAlerts.length})
            </span>
            {drawOpen && <span className="text-brand animate-pulse">Nhấn vào bản đồ để chấm tọa độ!</span>}
          </div>
          <Suspense fallback={<div className="h-[44dvh] animate-pulse rounded-2xl bg-surface-2 lg:h-[62dvh]" />}>
            <UnifiedMapCanvas
              reports={mapMarkers}
              alerts={filteredAlerts}
              mode="pins"
              initialCenter={[10.9465, 106.8243]}
              initialZoom={11}
              cameraCommand={alertsMapCam}
              onRequestCamera={pushAlertsMapCam}
              userPos={weatherLoc.isGps ? { lat: weatherLoc.lat, lng: weatherLoc.lng } : null}
              onLocate={() => detectGpsWeather(false)}
              locating={gpsBusy}
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
          </Suspense>
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
        <div className="min-w-0 w-full space-y-3 lg:col-span-6">
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
            {feedError && (
              <div className="card flex flex-wrap items-center justify-between gap-2 border-amber-500/35 bg-amber-500/10 p-3 text-xs font-semibold text-amber-900 dark:text-amber-200">
                <span>{feedError}</span>
                <button type="button" onClick={() => void loadAll(true)} className="btn btn-soft !min-h-8 !px-3 !text-xs">
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Tải lại tin
                </button>
              </div>
            )}
            {loading && alerts.length === 0 && bulletins.length === 0 ? (
              <div className="card flex items-center justify-center gap-2 py-12 text-sm text-muted">
                <Spinner /> Đang cập nhật bản tin & cảnh báo từ nguồn RSS chính thống…
              </div>
            ) : filteredAlerts.length === 0 && filteredBulletins.length === 0 ? (
              <div className="card p-6 text-center text-sm text-muted">
                Hiện chưa có cảnh báo hoặc bản tin chính thống nào trong nhóm này.
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
                          <CheckCircle2 className="h-3.5 w-3.5 text-ok" aria-hidden />
                        ) : (
                          <AlertTriangle className="h-3.5 w-3.5 text-amber-600" aria-hidden />
                        )}
                        {al.sourceLabel}
                      </span>
                      <span className="mono ml-auto text-[11px] text-muted">{formatPubDateTime(al.createdAt)}</span>
                    </div>

                    <h3 className="font-bold text-ink">{decodeHtmlEntities(al.title)}</h3>
                    <p className="line-clamp-3 text-xs leading-relaxed text-muted sm:text-sm">
                      {decodeHtmlEntities(al.description)}
                    </p>

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
                            Toàn Thành phố Đồng Nai
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
                        {(() => {
                          const alreadyConfirmed = Boolean(session && al.confirmedByUserIds?.includes(session.user.id));
                          const isConfirming = confirmingAlertId === al.id;
                          return (
                            <button
                              type="button"
                              disabled={isConfirming || alreadyConfirmed}
                              onClick={() => void handleConfirmAlert(al)}
                              className={`btn !min-h-8 !px-2.5 !text-xs ${alreadyConfirmed ? 'btn-ghost text-ok' : 'btn-soft'}`}
                            >
                              {isConfirming ? <Spinner className="h-3.5 w-3.5" /> : <ThumbsUp className="h-3.5 w-3.5" aria-hidden />}
                              {alreadyConfirmed ? `Đã xác nhận (${al.confirmCount})` : `Xác nhận (${al.confirmCount})`}
                            </button>
                          );
                        })()}
                        {al.sourceUrl && (
                          <a
                            href={al.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
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

            {/* Thông báo chính thống & Bản tin Thời tiết dạng bài báo RSS */}
            {filteredBulletins.length > 0 && (
              <div className="space-y-2.5 pt-2">
                <h2 className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-ink">
                  <Newspaper className="h-4 w-4 text-brand" aria-hidden />
                  Bản tin Thời tiết & Cảnh báo Chính thống ({filteredBulletins.length})
                </h2>
                {filteredBulletins.map((b) => (
                  <article key={b.id} className="card relative overflow-hidden p-4">
                    <span className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-brand to-brand-2" aria-hidden />
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                      <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2.5 py-0.5 font-bold text-brand">
                        <CheckCircle2 className="h-3.5 w-3.5 text-ok" aria-hidden />
                        {b.sourceName}
                      </span>
                      <span className="mono font-medium text-muted">{formatPubDateTime(b.publishedAt)}</span>
                    </div>
                    <h3 className="mt-2 text-sm font-extrabold leading-snug text-ink sm:text-base">
                      {decodeHtmlEntities(b.title)}
                    </h3>
                    <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-muted sm:text-sm">
                      {decodeHtmlEntities(b.cleanSummary)}
                    </p>
                    <div className="mt-3 flex items-center justify-between border-t border-line/60 pt-2">
                      <span className="text-[11px] font-semibold text-muted">Xác thực nguồn RSS chính thống</span>
                      <a
                        href={b.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-bold text-brand hover:underline"
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Nguồn tin
                      </a>
                    </div>
                  </article>
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
              {savingComm ? <Spinner /> : 'Gửi cảnh báo'}
            </button>
          </form>
        </div>
      )}

      {inspectWardCode && (
        <Suspense fallback={<div className="fixed inset-y-0 right-0 z-50 w-full max-w-2xl animate-pulse bg-surface shadow-2xl" />}>
          <WardInspectorDrawer wardCode={inspectWardCode} onClose={() => setInspectWardCode(null)} />
        </Suspense>
      )}
    </div>
  );
}
