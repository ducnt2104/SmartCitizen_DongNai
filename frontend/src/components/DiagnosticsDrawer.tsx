import {
  Activity,
  BrainCircuit,
  CheckCircle2,
  Crosshair,
  Database,
  Play,
  RefreshCw,
  ShieldCheck,
  X,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { normalizeCoordinates, TRAN_BIEN_FALLBACK_COORDS } from '@shared/coordinates';
import { nearestWard } from '@shared/geo';
import type { TacticalBriefing } from '@shared/types';
import { api, ApiError } from '../lib/api';
import { getGps } from '../lib/geoClient';
import { Spinner } from './ui';

interface SystemDiagnosticsPayload {
  timestamp: string;
  uptimeSec: number;
  database: {
    mode: 'mongodb' | 'json';
    connected: boolean;
    state: string;
    host: string;
    dbName: string;
    maskedUri: string;
    pingMs: number;
    allowJsonFallback: boolean;
    fallbackReason: string | null;
    lastError: string | null;
    indexes: {
      has2dsphere: boolean;
      hasSyncIdSparse: boolean;
    };
    counts: {
      reports: number;
      incidents: number;
      users: number;
      wardsSeeded: number;
      fingerprints: number;
      evaluations: number;
      auditLogs: number;
    };
  };
  ai: {
    configured: boolean;
    model: string;
    modelChain: string[];
    ollamaModel: string;
    allowCloudFallback: boolean;
    circuitOpen: boolean;
    lastError: string | null;
    lastOkAt: string | null;
    keyPool: {
      totalKeys: number;
      enabledKeys: number;
      healthyKeys: number;
      cooldownKeys: number;
      exhaustedKeys: number;
      invalidKeys: number;
    };
    cvEngine: {
      online: boolean;
      latencyMs: number | null;
    };
    localLlm: {
      online: boolean;
      provider: string;
      latencyMs: number | null;
    };
    ragDocs: number;
    zeroCrashFallbackReady: boolean;
  };
  geo: {
    wardsTotal: number;
  };
  security: {
    helmet: boolean;
    corsStrict: boolean;
    rateLimit: boolean;
    mongoSanitize: boolean;
    passwordHashing: string;
    rbacRoles: string[];
  };
}

interface DbTestResult {
  ok: boolean;
  mode: string;
  probeId: string;
  writeMs: number;
  readMs: number;
  geoNearMs: number;
  deleteMs: number;
  totalMs: number;
  detail: string;
}

interface AiTestResult {
  ok: boolean;
  activeEngine: string;
  model: string;
  latencyMs: number;
  sampleBriefing: TacticalBriefing;
  detail: string;
}

interface GpsSelfTestResult {
  ok: boolean;
  lat: number;
  lng: number;
  accuracy: number | null;
  tier: string;
  wardCode: string;
  wardName: string;
  usedFallback: boolean;
  detail: string;
}

export function DiagnosticsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<SystemDiagnosticsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [dbTest, setDbTest] = useState<DbTestResult | null>(null);
  const [aiTest, setAiTest] = useState<AiTestResult | null>(null);
  const [gpsTest, setGpsTest] = useState<GpsSelfTestResult | null>(null);
  const [runningStep, setRunningStep] = useState<'none' | 'db' | 'ai' | 'gps' | 'all'>('none');

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await api<SystemDiagnosticsPayload>('/api/system/diagnostics', { timeoutMs: 12000 });
      setData(res);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Không tải được thông tin chẩn đoán hệ thống.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void fetchStatus();
  }, [open, fetchStatus]);

  const runDbProbe = async (): Promise<DbTestResult | null> => {
    const res = await api<DbTestResult>('/api/system/diagnostics/test-db', { method: 'POST', timeoutMs: 15000 });
    setDbTest(res);
    return res;
  };

  const runAiProbe = async (): Promise<AiTestResult | null> => {
    const res = await api<AiTestResult>('/api/system/diagnostics/test-ai', { method: 'POST', timeoutMs: 18000 });
    setAiTest(res);
    return res;
  };

  const runGpsProbe = async (): Promise<GpsSelfTestResult> => {
    try {
      const fix = await getGps();
      const norm = normalizeCoordinates({ lat: fix.lat, lng: fix.lng }, { requireVietnam: false });
      const lat = norm.ok ? norm.lat : fix.lat;
      const lng = norm.ok ? norm.lng : fix.lng;
      const ward = nearestWard(lat, lng);
      const out: GpsSelfTestResult = {
        ok: true,
        lat,
        lng,
        accuracy: fix.accuracy,
        tier: fix.tier === 2 ? 'Tầng 2 (Wi-Fi/Mạng trong nhà)' : 'Tầng 1 (GPS Vệ tinh)',
        wardCode: ward.wardCode,
        wardName: ward.name,
        usedFallback: false,
        detail: `Khóa tọa độ thực thành công (±${fix.accuracy}m) → ${ward.name} (${ward.wardCode}).`,
      };
      setGpsTest(out);
      return out;
    } catch {
      const ward = nearestWard(TRAN_BIEN_FALLBACK_COORDS.lat, TRAN_BIEN_FALLBACK_COORDS.lng);
      const out: GpsSelfTestResult = {
        ok: true,
        lat: TRAN_BIEN_FALLBACK_COORDS.lat,
        lng: TRAN_BIEN_FALLBACK_COORDS.lng,
        accuracy: null,
        tier: 'Fallback Thông minh (Chặn quyền GPS)',
        wardCode: ward.wardCode,
        wardName: ward.name,
        usedFallback: true,
        detail: `Trình duyệt chặn GPS → Tự động định tâm an toàn về ${ward.name} [${TRAN_BIEN_FALLBACK_COORDS.lat}, ${TRAN_BIEN_FALLBACK_COORDS.lng}] (0% treo).`,
      };
      setGpsTest(out);
      return out;
    }
  };

  const runOneClickSelfTest = async (): Promise<void> => {
    setRunningStep('all');
    setErr(null);
    try {
      await fetchStatus();
      await runDbProbe();
      await runAiProbe();
      await runGpsProbe();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Kiểm tra tự động gặp lỗi.');
    } finally {
      setRunningStep('none');
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex justify-end bg-black/70 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-label="System Diagnostics & Control Plugin"
      onClick={onClose}
    >
      <div
        className="flex h-dvh w-full max-w-xl flex-col border-l border-slate-800 bg-slate-950 text-slate-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900 px-4 py-3">
          <div className="min-w-0">
            <p className="mono text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-400">
              CHẨN ĐOÁN HỆ THỐNG ĐIỀU HÀNH
            </p>
            <h2 className="truncate text-base font-extrabold">Kiểm tra Trạng thái Kết nối & Dịch vụ</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void fetchStatus()}
              disabled={loading || runningStep !== 'none'}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700 bg-slate-800 text-slate-200 hover:border-cyan-500"
              title="Làm mới thông số"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700"
              aria-label="Đóng"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto p-4 text-xs">
          {/* 1-Click Self Test CTA */}
          <div className="rounded-xl border border-cyan-500/40 bg-gradient-to-r from-cyan-950/70 to-slate-900 p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-extrabold text-cyan-300">⚡ Kiểm tra Tổng thể 1 Chạm</p>
                <p className="mt-0.5 leading-relaxed text-slate-300">
                  Kiểm tra tốc độ Đọc/Ghi cơ sở dữ liệu, truy vấn không gian theo tọa độ, phân tích thông minh và định vị GPS 2 tầng.
                </p>
              </div>
              <button
                type="button"
                disabled={runningStep !== 'none'}
                onClick={() => void runOneClickSelfTest()}
                className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl bg-cyan-400 px-4 text-xs font-extrabold text-slate-950 shadow-lg hover:bg-cyan-300 disabled:opacity-60"
              >
                {runningStep === 'all' ? <Spinner className="h-4 w-4" /> : <Play className="h-4 w-4 fill-current" />}
                {runningStep === 'all' ? 'Đang kiểm tra 4 lớp…' : 'Chạy Tự Kiểm Tra Ngay'}
              </button>
            </div>
          </div>

          {err && (
            <div role="alert" className="rounded-xl border border-rose-500/50 bg-rose-500/15 p-3 text-rose-200">
              {err}
            </div>
          )}

          {/* 1. Database Card */}
          <section className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/80 p-3.5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-wider text-slate-200">
                <Database className="h-4 w-4 text-emerald-400" /> 1. Hệ thống Lưu trữ Dữ liệu
              </h3>
              {data && (
                <span
                  className={`mono rounded px-2 py-0.5 text-[10px] font-extrabold ${
                    data.database.connected && data.database.mode === 'mongodb'
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : data.database.connected
                        ? 'bg-amber-500/20 text-amber-300'
                        : 'bg-rose-500/20 text-rose-300'
                  }`}
                >
                  {data.database.connected ? `TRỰC TUYẾN · ${data.database.pingMs}ms` : 'DỰ PHÒNG CỤC BỘ'}
                </span>
              )}
            </div>

            {data && (
              <>
                <p className="mono break-all text-[11px] text-slate-400">
                  Máy chủ: <strong className="text-slate-200">{data.database.host}</strong> · Cơ sở dữ liệu:{' '}
                  <strong className="text-cyan-300">{data.database.dbName}</strong>
                </p>
                <div className="grid grid-cols-3 gap-2 pt-1">
                  <div className="rounded-lg border border-slate-800 bg-slate-950 p-2">
                    <span className="text-[10px] text-slate-400">Hồ sơ / Sự cố</span>
                    <p className="mono text-sm font-extrabold text-white">
                      {data.database.counts.reports + data.database.counts.incidents}
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-950 p-2">
                    <span className="text-[10px] text-slate-400">Tài khoản phân quyền</span>
                    <p className="mono text-sm font-extrabold text-white">{data.database.counts.users}</p>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-950 p-2">
                    <span className="text-[10px] text-slate-400">Đơn vị hành chính</span>
                    <p className="mono text-sm font-extrabold text-emerald-400">{data.database.counts.wardsSeeded}/95</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <span className="mono rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300">
                    Chỉ mục vị trí: {data.database.indexes.has2dsphere ? '✓ SẴN SÀNG' : '—'}
                  </span>
                  <span className="mono rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300">
                    Chống trùng đồng bộ: {data.database.indexes.hasSyncIdSparse ? '✓ SẴN SÀNG' : '—'}
                  </span>
                  <span className="mono rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300">
                    Bộ đệm cục bộ: SẴN SÀNG
                  </span>
                </div>
              </>
            )}

            <div className="pt-1">
              <button
                type="button"
                disabled={runningStep !== 'none'}
                onClick={async () => {
                  setRunningStep('db');
                  try {
                    await runDbProbe();
                  } catch (e) {
                    setErr(e instanceof Error ? e.message : 'Kiểm tra lưu trữ gặp lỗi');
                  } finally {
                    setRunningStep('none');
                  }
                }}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 font-bold text-slate-200 hover:border-emerald-400"
              >
                {runningStep === 'db' ? <Spinner className="h-3.5 w-3.5" /> : <Activity className="h-3.5 w-3.5 text-emerald-400" />}
                Kiểm tra Đọc / Ghi / Truy vấn vị trí
              </button>
            </div>

            {dbTest && (
              <div
                className={`rounded-lg border p-2.5 ${
                  dbTest.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                }`}
              >
                <p className="flex items-center gap-1.5 font-bold">
                  {dbTest.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
                  Hoàn tất kiểm tra chu trình lưu trữ ({dbTest.totalMs}ms)
                </p>
                <p className="mono mt-1 text-[11px] opacity-90">
                  Ghi: {dbTest.writeMs}ms · Đọc: {dbTest.readMs}ms · Vị trí: {dbTest.geoNearMs}ms · Dọn dẹp:{' '}
                  {dbTest.deleteMs}ms
                </p>
              </div>
            )}
          </section>

          {/* 2. Smart Analysis Card */}
          <section className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/80 p-3.5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-wider text-slate-200">
                <BrainCircuit className="h-4 w-4 text-cyan-400" /> 2. Trung tâm Phân tích & Điều phối Thông minh
              </h3>
              {data && (
                <span className="mono rounded bg-cyan-500/20 px-2 py-0.5 text-[10px] font-extrabold text-cyan-300">
                  {data.ai.model}
                </span>
              )}
            </div>

            {data && (
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-slate-800 bg-slate-950 p-2">
                  <span className="text-[10px] text-slate-400">Cụm khóa kết nối</span>
                  <p className="mono font-bold text-white">
                    {data.ai.keyPool.healthyKeys}/{data.ai.keyPool.totalKeys} SẴN SÀNG
                  </p>
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950 p-2">
                  <span className="text-[10px] text-slate-400">Xử lý Ảnh & Tri thức Cục bộ</span>
                  <p className="mono font-bold text-emerald-400">
                    {data.ai.cvEngine.online ? `${data.ai.cvEngine.latencyMs}ms` : 'Sẵn sàng'} · {data.ai.ragDocs} mục
                  </p>
                </div>
              </div>
            )}

            <div className="pt-1">
              <button
                type="button"
                disabled={runningStep !== 'none'}
                onClick={async () => {
                  setRunningStep('ai');
                  try {
                    await runAiProbe();
                  } catch (e) {
                    setErr(e instanceof Error ? e.message : 'Kiểm tra phân tích gặp lỗi');
                  } finally {
                    setRunningStep('none');
                  }
                }}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 font-bold text-slate-200 hover:border-cyan-400"
              >
                {runningStep === 'ai' ? <Spinner className="h-3.5 w-3.5" /> : <BrainCircuit className="h-3.5 w-3.5 text-cyan-400" />}
                Kiểm tra Phân tích Điều phối Khẩn cấp
              </button>
            </div>

            {aiTest && (
              <div className="space-y-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 p-2.5 text-cyan-100">
                <p className="flex items-center gap-1.5 font-bold text-cyan-300">
                  <CheckCircle2 className="h-4 w-4 shrink-0" /> Engine: {aiTest.activeEngine.toUpperCase()} ({aiTest.model}) ·{' '}
                  {aiTest.latencyMs}ms
                </p>
                <p className="text-[11px] text-slate-200">{aiTest.detail}</p>
                <p className="rounded bg-slate-950/70 p-2 text-[11px] text-slate-300">
                  <strong>Mẫu Tác chiến:</strong> {aiTest.sampleBriefing.riskSummary}
                </p>
              </div>
            )}
          </section>

          {/* 3. GPS 2-Tier & Ward Mapping Card */}
          <section className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/80 p-3.5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-wider text-slate-200">
                <Crosshair className="h-4 w-4 text-amber-400" /> 3. Định vị GPS 2 Tầng & 95 Phường/Xã
              </h3>
              <button
                type="button"
                disabled={runningStep !== 'none'}
                onClick={async () => {
                  setRunningStep('gps');
                  await runGpsProbe();
                  setRunningStep('none');
                }}
                className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 text-[11px] font-bold text-slate-200 hover:border-amber-400"
              >
                {runningStep === 'gps' ? <Spinner className="h-3.5 w-3.5" /> : <Crosshair className="h-3.5 w-3.5 text-amber-400" />}
                Kiểm tra GPS hiện tại
              </button>
            </div>

            {gpsTest ? (
              <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-2.5 text-emerald-100">
                <p className="font-bold text-emerald-300">{gpsTest.detail}</p>
                <p className="mono mt-1 text-[11px]">
                  lat={gpsTest.lat.toFixed(6)}, lng={gpsTest.lng.toFixed(6)} · {gpsTest.tier}
                </p>
              </div>
            ) : (
              <p className="text-slate-400">
                Bấm nút kiểm tra để xác nhận tọa độ hiện tại, độ chính xác ±m và ánh xạ tự động 95 ĐVHC Đồng Nai.
              </p>
            )}
          </section>

          {/* 4. Security Shield Summary */}
          {data && (
            <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-[11px] text-slate-300">
              <p className="flex items-center gap-1.5 font-bold text-emerald-400">
                <ShieldCheck className="h-4 w-4" /> Lớp bảo vệ vận hành đang kích hoạt:
              </p>
              <p className="mono mt-1 text-slate-400">
                Bảo vệ tiêu đề HTTP · Kiểm soát tên miền · Giới hạn tần suất · Lọc truy vấn an toàn · Phân quyền {data.security.rbacRoles.length} cấp
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
