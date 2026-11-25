import { AlertTriangle, Crosshair, ExternalLink, MapPin, Search, ThumbsUp, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { DUPLICATE_SCAN_RADIUS_M, GPS_WARN_M } from '@shared/constants';
import { normalizeCoordinates, TRAN_BIEN_FALLBACK_COORDS } from '@shared/coordinates';
import { haversineMeters, inDongNaiBBox, matchArterial, nearestWard } from '@shared/geo';
import type { Category, ReverseGeocodeResult } from '@shared/types';
import { DONG_NAI_WARDS, WARD_BY_CODE } from '../../data/dongNaiWards';
import { db } from '../../db/localDb';
import type { GpsStatus } from '../../hooks/usePreciseLocation';
import { useI18n } from '../../i18n';
import { edge } from '../../lib/edgeClient';
import {
  QUICK_PLACES,
  resolvePlaceSuggestion,
  reverseGeocode,
  searchPlacesDongNai,
  type GpsFix,
  type PlaceSuggestion,
} from '../../lib/geoClient';
import { googleMapsPlaceUrl } from '../../lib/mapConfig';
import { Spinner } from '../ui';
import type { CameraCommand } from './GoogleMapEngine';
import { UnifiedMapCanvas } from './UnifiedMapCanvas';

const WARDS_PHUONG = DONG_NAI_WARDS.filter((w) => w.kind === 'Phường');
const WARDS_XA = DONG_NAI_WARDS.filter((w) => w.kind === 'Xã');

export interface ResolvedGeoState {
  inBounds: boolean;
  ward: { wardCode: string; name: string };
  arterial: { name: string; distanceM: number } | null;
  nearby: Array<{ id: string; distanceM: number; clusterCount: number }>;
  needsConfirmation: boolean;
  source: ReverseGeocodeResult['source'];
  matchedAlias: string | null;
}

export interface PrecisionLocationPickerProps {
  category: Category | null;
  pin: { lat: number; lng: number } | null;
  onPinChange: (pin: { lat: number; lng: number }) => void;
  address: string;
  onAddressChange: (address: string) => void;
  geo: ResolvedGeoState | null;
  onGeoChange: (geo: ResolvedGeoState | null) => void;
  manualWardCode: string;
  onManualWardChange: (wardCode: string) => void;
  fix: GpsFix | null;
  gpsStatus: GpsStatus;
  gpsSamples: number;
  isLowAccuracy: boolean;
  onRequestGps: () => Promise<GpsFix | null>;
  exifApplied: boolean;
  leftScene: boolean;
  onLeftSceneChange: (v: boolean) => void;
  onUseNearby: (mode: 'confirm' | 'attach', reportId: string) => Promise<void>;
}

/**
 * Component Chọn Vị trí Chính xác Từng Mét (`PrecisionLocationPicker`) cho trang `/report`:
 * - Center Crosshair Pin cố định giữa màn hình, kéo bản đồ bên dưới mượt 60FPS như Google Maps / Grab.
 * - Hiển thị Vòng tròn Sai số GPS thực (`±m`) + nút định vị chính xác cao (`watchPosition` 4 giây).
 * - Thanh tìm kiếm địa chỉ / con hẻm / 95 Phường-Xã ngay trên bản đồ (ưu tiên trong `DONG_NAI_CITY_BOUNDS`).
 * - Tự động Reverse Geocoding (debounce `350ms` + `AbortController`) và quy chuẩn về 1 trong 95 Phường/Xã của TP. Đồng Nai.
 */
export function PrecisionLocationPicker({
  category,
  pin,
  onPinChange,
  address,
  onAddressChange,
  geo,
  onGeoChange,
  manualWardCode,
  onManualWardChange,
  fix,
  gpsStatus,
  gpsSamples,
  isLowAccuracy,
  onRequestGps,
  exifApplied,
  leftScene,
  onLeftSceneChange,
  onUseNearby,
}: PrecisionLocationPickerProps) {
  const { t } = useI18n();
  const [cameraCmd, setCameraCmd] = useState<CameraCommand | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [resolvingAddress, setResolvingAddress] = useState(false);

  const pushCamera = useCallback((cmd: Omit<CameraCommand, 'seq'>) => {
    setCameraCmd((prev) => ({ ...cmd, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

  // Khi EXIF GPS từ ảnh gốc có sẵn lúc vừa sang Bước 2 -> bay thẳng tới vị trí EXIF
  useEffect(() => {
    if (pin && exifApplied) {
      pushCamera({ kind: 'flyTo', lat: pin.lat, lng: pin.lng, zoom: 17 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const triggerLocate = useCallback(async () => {
    const f = await onRequestGps();
    if (f) {
      const norm = normalizeCoordinates({ lat: f.lat, lng: f.lng }, { requireVietnam: false });
      const safeLat = norm.ok ? norm.lat : f.lat;
      const safeLng = norm.ok ? norm.lng : f.lng;
      onPinChange({ lat: safeLat, lng: safeLng });
      onManualWardChange('');
      pushCamera({ kind: 'flyTo', lat: safeLat, lng: safeLng, zoom: 18 });
    } else if (!pin) {
      // Fallback thông minh về tâm Phường Trấn Biên [10.9465, 106.8235] khi thiết bị chặn quyền GPS hoàn toàn
      onPinChange({ lat: TRAN_BIEN_FALLBACK_COORDS.lat, lng: TRAN_BIEN_FALLBACK_COORDS.lng });
      onManualWardChange('');
      pushCamera({
        kind: 'flyTo',
        lat: TRAN_BIEN_FALLBACK_COORDS.lat,
        lng: TRAN_BIEN_FALLBACK_COORDS.lng,
        zoom: 16,
      });
    }
  }, [onRequestGps, onPinChange, onManualWardChange, pushCamera, pin]);

  // Tự động lấy mẫu GPS chính xác cao khi mở Bước 2 lần đầu (nếu chưa có tọa độ EXIF/pin)
  useEffect(() => {
    if (gpsStatus === 'idle' && !exifApplied && !pin) {
      void triggerLocate();
    }
  }, [gpsStatus, exifApplied, pin, triggerLocate]);

  // Tìm kiếm nhanh địa chỉ / con hẻm / 95 Phường Xã (debounce 250ms + AbortController)
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSuggestions([]);
      return;
    }
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      void searchPlacesDongNai(q, ctrl.signal).then((items) => {
        if (!ctrl.signal.aborted) setSuggestions(items);
      });
    }, 250);
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [searchQuery]);

  const handleSelectPlace = async (item: PlaceSuggestion): Promise<void> => {
    setSearchOpen(false);
    setSearchQuery(item.label);
    const resolved = await resolvePlaceSuggestion(item);
    if (!resolved) return;
    onPinChange({ lat: resolved.lat, lng: resolved.lng });
    if (item.kind === 'ward' && item.wardCode) {
      onManualWardChange(item.wardCode);
      pushCamera({ kind: 'flyTo', lat: resolved.lat, lng: resolved.lng, zoom: 15 });
    } else {
      onManualWardChange('');
      pushCamera({ kind: 'flyTo', lat: resolved.lat, lng: resolved.lng, zoom: 18 });
    }
  };

  // Reverse Geocoding tự động (debounce 350ms + AbortController) + quét trùng lặp bán kính 100m
  useEffect(() => {
    if (!pin) return;
    let cancelled = false;
    const ctrl = new AbortController();
    setResolvingAddress(true);

    const timer = window.setTimeout(async () => {
      try {
        const fallbackWard = nearestWard(pin.lat, pin.lng);
        const [g, rows] = await Promise.all([
          reverseGeocode(pin.lat, pin.lng, ctrl.signal),
          db.reports.toArray(),
        ]);
        if (cancelled) return;
        onAddressChange(g.address);
        const resolvedWard = {
          wardCode: g.wardCode ?? fallbackWard.wardCode,
          name: g.wardName ?? fallbackWard.name,
        };

        try {
          const scan = await edge.geoScan({
            lat: pin.lat,
            lng: pin.lng,
            category,
            radiusM: DUPLICATE_SCAN_RADIUS_M,
            candidates: rows.map((r) => ({
              id: r.id,
              lat: r.lat,
              lng: r.lng,
              category: r.category,
              status: r.status,
              clusterCount: r.clusterCount,
            })),
          });
          if (!cancelled) {
            onGeoChange({
              inBounds: g.inBounds && scan.inBounds,
              ward: resolvedWard,
              arterial: g.arterial ?? scan.arterial,
              nearby: scan.nearby,
              needsConfirmation: g.needsConfirmation,
              source: g.source,
              matchedAlias: g.matchedAlias,
            });
          }
        } catch (scanErr) {
          console.warn('[PrecisionLocationPicker] Worker quét trùng lỗi, dùng tính toán trực tiếp:', scanErr);
          if (!cancelled) {
            onGeoChange({
              inBounds: g.inBounds && inDongNaiBBox(pin.lat, pin.lng),
              ward: resolvedWard,
              arterial: g.arterial ?? matchArterial(pin.lat, pin.lng),
              nearby: [],
              needsConfirmation: g.needsConfirmation,
              source: g.source,
              matchedAlias: g.matchedAlias,
            });
          }
        }
      } catch (err) {
        if (!ctrl.signal.aborted && !cancelled) {
          console.warn('[PrecisionLocationPicker] Không thể phân giải địa chỉ cho tọa độ hiện tại:', err);
        }
      } finally {
        if (!cancelled) setResolvingAddress(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [pin, category, onAddressChange, onGeoChange]);

  const handleCrosshairMove = useCallback(
    (lat: number, lng: number) => {
      const norm = normalizeCoordinates({ lat, lng }, { requireVietnam: false });
      if (norm.ok) onPinChange({ lat: norm.lat, lng: norm.lng });
    },
    [onPinChange],
  );

  const handlePinDragEnd = useCallback(
    (lat: number, lng: number) => {
      const norm = normalizeCoordinates({ lat, lng }, { requireVietnam: false });
      if (!norm.ok) return;
      onPinChange({ lat: norm.lat, lng: norm.lng });
      pushCamera({ kind: 'flyTo', lat: norm.lat, lng: norm.lng });
    },
    [onPinChange, pushCamera],
  );

  const activeWardCode =
    manualWardCode || geo?.ward.wardCode || (pin ? nearestWard(pin.lat, pin.lng).wardCode : '');
  const activeWard = activeWardCode ? WARD_BY_CODE[activeWardCode] : undefined;
  const mismatchM = fix && pin ? haversineMeters(pin.lat, pin.lng, fix.lat, fix.lng) : null;
  const mismatch = mismatchM !== null && mismatchM > GPS_WARN_M;
  const nearest = geo?.nearby[0];

  return (
    <div className="space-y-3.5">
      {/* Thanh tìm kiếm địa chỉ / con hẻm / 95 Phường Xã đặt ngay phía trên khung tâm ngắm */}
      <div className="relative z-20">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
        <input
          type="search"
          className="field !min-h-12 !pl-10 !pr-10 text-sm shadow-card"
          placeholder={t('report.searchPlacePlaceholder')}
          value={searchQuery}
          onFocus={() => setSearchOpen(true)}
          onBlur={() => window.setTimeout(() => setSearchOpen(false), 180)}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label={t('report.searchPlacePlaceholder')}
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery('')}
            className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-muted hover:bg-surface-2"
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        )}
        {searchOpen && suggestions.length > 0 && (
          <ul
            role="listbox"
            className="absolute inset-x-0 top-full z-[80] mt-1 max-h-60 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-lift"
          >
            {suggestions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void handleSelectPlace(s)}
                  className="flex w-full items-start justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2"
                >
                  <span className="flex min-w-0 items-start gap-2">
                    <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
                    <span className="min-w-0">
                      <span className="font-semibold text-ink">{s.label}</span>
                      <span className="block truncate text-[11px] text-muted">{s.sublabel}</span>
                    </span>
                  </span>
                  {s.wardCode && <span className="mono shrink-0 text-[11px] text-muted">{s.wardCode}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Trạng thái đang thu mẫu GPS chính xác cao */}
      {gpsStatus === 'locating' && (
        <div className="card flex items-center gap-3 p-3" role="status">
          <Spinner className="text-brand" />
          <p className="text-sm font-semibold">
            {t('report.locating')} {gpsSamples > 0 && fix ? `(±${Math.round(fix.accuracy)}m)` : ''}
          </p>
        </div>
      )}

      {isLowAccuracy && fix && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-xl border border-warn/40 bg-warn-soft p-3 text-xs font-semibold text-warn"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{t('map.lowAccuracy', { m: Math.round(fix.accuracy) })}</span>
        </div>
      )}

      {(gpsStatus === 'denied' || gpsStatus === 'error') && (
        <div className="card space-y-2.5 border-warn/50 p-3.5" role="alert">
          <p className="flex items-start gap-2 text-sm font-bold text-warn">
            <MapPin className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {gpsStatus === 'denied' ? t('report.gpsDenied') : t('report.gpsError')}
          </p>
          <p className="text-xs text-muted">{t('report.gpsFallback')}</p>
          <div className="flex flex-wrap gap-1.5">
            {QUICK_PLACES.map((pl) => (
              <button
                key={pl.wardCode}
                type="button"
                className="chip !min-h-8 !text-xs"
                onClick={() => {
                  onPinChange({ lat: pl.lat, lng: pl.lng });
                  onManualWardChange('');
                  pushCamera({ kind: 'flyTo', lat: pl.lat, lng: pl.lng, zoom: 16 });
                }}
              >
                {pl.name}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-soft !min-h-10 !text-sm" onClick={() => void triggerLocate()}>
            <Crosshair className="h-4 w-4" aria-hidden />
            {t('report.retryGps')}
          </button>
        </div>
      )}

      {/* Nút Định vị lại vị trí của tôi + Hiển thị sai số ±mét & tầng GPS */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface p-2.5 shadow-card">
        <div className="min-w-0 text-xs">
          {fix ? (
            <p className="font-semibold text-ink">
              Độ chính xác GPS:{' '}
              <span className={`mono font-bold ${fix.accuracy <= 35 ? 'text-ok' : 'text-warn'}`}>
                ±{Math.round(fix.accuracy)}m
              </span>{' '}
              <span className="text-muted">
                ({fix.tier === 2 ? 'Định vị mạng trong nhà' : 'GPS vệ tinh'})
              </span>
            </p>
          ) : (
            <p className="font-medium text-muted">
              Kéo thả ghim trực tiếp trên bản đồ hoặc bấm định vị lại vị trí của bạn.
            </p>
          )}
        </div>
        <button
          type="button"
          className="btn btn-soft !min-h-10 !px-3 !text-xs font-bold"
          disabled={gpsStatus === 'locating'}
          onClick={() => void triggerLocate()}
        >
          <Crosshair className={`h-4 w-4 ${gpsStatus === 'locating' ? 'animate-spin' : ''}`} aria-hidden />
          Định vị lại vị trí của tôi
        </button>
      </div>

      {/* Khung Bản đồ Kéo thả Ghim Trực tiếp + Tâm ngắm Cố định Giữa Màn hình */}
      <UnifiedMapCanvas
        reports={[]}
        initialCenter={pin ? [pin.lat, pin.lng] : [TRAN_BIEN_FALLBACK_COORDS.lat, TRAN_BIEN_FALLBACK_COORDS.lng]}
        initialZoom={pin ? 17 : 15}
        fitCityOnMount={false}
        cameraCommand={cameraCmd}
        onRequestCamera={pushCamera}
        userPos={fix ? { lat: fix.lat, lng: fix.lng } : null}
        accuracyM={fix?.accuracy ?? null}
        crosshairPin={{ onChange: handleCrosshairMove }}
        draggablePin={
          pin
            ? {
                lat: pin.lat,
                lng: pin.lng,
                onDragEnd: handlePinDragEnd,
              }
            : null
        }
        showArterials
        showFitCityButton
        onLocate={() => void triggerLocate()}
        locating={gpsStatus === 'locating'}
        className="h-[46dvh] min-h-[19rem]"
        ariaLabel={t('report.mapAria')}
        topOverlay={
          fix ? (
            <div className="flex">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold shadow-card backdrop-blur-md ${
                  fix.accuracy <= 25
                    ? 'border-ok/40 bg-ok-soft/95 text-ok'
                    : fix.accuracy <= 50
                      ? 'border-brand/40 bg-surface/95 text-brand'
                      : 'border-warn/40 bg-warn-soft/95 text-warn'
                }`}
              >
                <Crosshair className="h-3.5 w-3.5" aria-hidden />
                {t('report.gpsAccuracyBadge', { m: Math.round(fix.accuracy) })}
              </span>
            </div>
          ) : undefined
        }
      />
      <p className="text-xs text-muted">{t('report.dragHint')}</p>

      {/* Thẻ Địa chỉ Đã Phân giải & Chọn Phường/Xã Tiếp nhận (95 ĐVHC) */}
      <div className="card space-y-2.5 p-3.5 text-sm">
        <div className="flex items-start justify-between gap-2">
          <p className="flex min-w-0 items-start gap-2 font-semibold">
            <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
            <span className="break-words">{address || t('report.addressLoading')}</span>
          </p>
          {resolvingAddress && <Spinner className="h-4 w-4 shrink-0 text-brand" />}
        </div>

        {pin && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="mono text-xs text-muted">
              {pin.lat.toFixed(6)}, {pin.lng.toFixed(6)}
              {fix ? ` · GPS ±${Math.round(fix.accuracy)}m` : ''}
              {exifApplied ? ' · EXIF' : ''}
            </p>
            <a
              href={googleMapsPlaceUrl(pin.lat, pin.lng)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs font-semibold text-brand underline"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              {t('map.openGoogleMaps')}
            </a>
          </div>
        )}

        {geo?.needsConfirmation && !manualWardCode && (
          <p className="rounded-xl bg-warn-soft px-3 py-2 text-xs font-semibold text-warn">
            {t('report.wardAutoSuggest')}
          </p>
        )}

        {geo?.matchedAlias && (
          <p className="rounded-xl bg-brand-soft px-3 py-1.5 text-xs text-brand">
            {t('report.aliasNormalized', { old: geo.matchedAlias, unit: geo.ward.name })}
          </p>
        )}

        <div>
          <label htmlFor="rp-ward" className="label text-xs">
            {t('report.wardSelect')}
          </label>
          <select
            id="rp-ward"
            className="field !min-h-11 text-sm"
            value={activeWardCode}
            onChange={(e) => onManualWardChange(e.target.value)}
          >
            <optgroup label={t('scope.groupPhuong')}>
              {WARDS_PHUONG.map((w) => (
                <option key={w.wardCode} value={w.wardCode}>
                  {w.name}
                </option>
              ))}
            </optgroup>
            <optgroup label={t('scope.groupXa')}>
              {WARDS_XA.map((w) => (
                <option key={w.wardCode} value={w.wardCode}>
                  {w.name}
                </option>
              ))}
            </optgroup>
          </select>
          {activeWard && <p className="mt-1 text-xs text-muted">{activeWard.zone}</p>}
        </div>

        {geo?.arterial && (
          <p className="text-xs font-semibold text-danger">{t('report.arterial', { name: geo.arterial.name })}</p>
        )}
        {geo && !geo.inBounds && (
          <p role="alert" className="font-semibold text-danger">
            {t('report.outOfBounds')}
          </p>
        )}
      </div>

      {/* Cảnh báo nếu ghim cách xa vị trí GPS thực tế của thiết bị */}
      {mismatch && (
        <div role="alert" className="space-y-2 rounded-2xl border border-warn/50 bg-warn-soft p-3 text-sm text-warn">
          <p className="flex items-start gap-2 font-bold">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {t('report.gpsMismatch', { km: ((mismatchM ?? 0) / 1000).toFixed(1) })}
          </p>
          <label className="flex min-h-11 items-center gap-2 font-semibold">
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={leftScene}
              onChange={(e) => onLeftSceneChange(e.target.checked)}
            />
            {t('report.leftScene')}
          </label>
        </div>
      )}

      {/* Gợi ý gộp vào sự cố có sẵn trong bán kính 100m */}
      {nearest && (
        <div className="card space-y-3 border-brand/50 p-3" role="status">
          <p className="font-bold">{t('report.nearbyTitle', { n: nearest.clusterCount })}</p>
          <p className="text-sm text-muted">{t('report.nearbyText', { m: Math.round(nearest.distanceM) })}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <button type="button" className="btn btn-primary" onClick={() => void onUseNearby('confirm', nearest.id)}>
              <ThumbsUp className="h-5 w-5" aria-hidden />
              {t('detail.confirm')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void onUseNearby('attach', nearest.id)}>
              {t('detail.attach')}
            </button>
          </div>
          <p className="text-xs text-muted">{t('report.nearbyIgnore')}</p>
        </div>
      )}
    </div>
  );
}
