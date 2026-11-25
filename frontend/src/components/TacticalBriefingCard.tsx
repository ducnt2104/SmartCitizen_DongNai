import { AlertOctagon, BrainCircuit, RefreshCw, ShieldAlert, Wrench } from 'lucide-react';
import { useEffect, useState } from 'react';
import { computeSosPriorityScore, toSeverityLabel } from '@shared/constants';
import type { ClientReport, SeverityLabel, TacticalBriefing } from '@shared/types';
import { api } from '../lib/api';

interface Props {
  report: ClientReport;
  onBriefingUpdated?: (briefing: TacticalBriefing) => void;
  compact?: boolean;
}

const SEVERITY_BADGE: Record<SeverityLabel, { bg: string; text: string; label: string }> = {
  CRITICAL: { bg: 'border-rose-500/60 bg-rose-500/20', text: 'text-rose-300', label: 'SOS KHẨN CẤP' },
  HIGH: { bg: 'border-amber-500/60 bg-amber-500/20', text: 'text-amber-300', label: 'NGHIÊM TRỌNG' },
  MEDIUM: { bg: 'border-cyan-500/50 bg-cyan-500/15', text: 'text-cyan-300', label: 'TRUNG BÌNH' },
  LOW: { bg: 'border-slate-600 bg-slate-800', text: 'text-slate-300', label: 'MỨC THẤP' },
};

/**
 * Thẻ "SmartCitizen AI Brain — Gợi ý tác chiến 3 dòng" cho Đội Cứu Hộ & Cán bộ IOC:
 *  (1) Tóm tắt rủi ro hiện trường
 *  (2) Thiết bị / nhân lực cần mang theo
 *  (3) Cảnh báo an toàn bắt buộc
 */
export function TacticalBriefingCard({ report, onBriefingUpdated, compact = false }: Props) {
  const [briefing, setBriefing] = useState<TacticalBriefing | null>(report.ai?.tacticalBriefing ?? null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setBriefing(report.ai?.tacticalBriefing ?? null);
  }, [report.id, report.ai?.tacticalBriefing]);

  useEffect(() => {
    if (report.ai?.tacticalBriefing) return;
    let cancelled = false;
    setLoading(true);
    void api<TacticalBriefing>('/api/ai/tactical-briefing', {
      method: 'POST',
      body: { reportId: report.id },
      timeoutMs: 12000,
    })
      .then((res) => {
        if (!cancelled) {
          setBriefing(res);
          onBriefingUpdated?.(res);
        }
      })
      .catch(() => {
        // Giữ nguyên nếu offline
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [report.id, report.ai?.tacticalBriefing, onBriefingUpdated]);

  const refresh = async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await api<TacticalBriefing>('/api/ai/tactical-briefing', {
        method: 'POST',
        body: { reportId: report.id, forceRefresh: true },
        timeoutMs: 15000,
      });
      setBriefing(res);
      onBriefingUpdated?.(res);
    } catch {
      // ignore offline error
    } finally {
      setLoading(false);
    }
  };

  const priorityScore =
    report.priorityScore ??
    report.ai?.priorityScore ??
    computeSosPriorityScore({
      severity: report.severity,
      isEmergency: report.isEmergency || report.emergencyLevel === 1,
      onArterial: report.onArterial,
      clusterCount: report.clusterCount,
      confirmCount: report.confirmCount,
    });
  const sevLabel: SeverityLabel =
    report.severityLabel ??
    report.ai?.severityLabel ??
    toSeverityLabel(report.severity, report.isEmergency || report.emergencyLevel === 1);
  const badge = SEVERITY_BADGE[sevLabel];

  const engineLabel =
    briefing?.mode === 'gemini'
      ? 'Gemini Flash AI'
      : briefing?.mode === 'ollama'
        ? 'Local LLM'
        : 'AI SOP Brain';

  return (
    <div className="rounded-xl border border-cyan-500/35 bg-slate-900/90 p-3 text-slate-100 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <BrainCircuit className="h-4 w-4 shrink-0 text-cyan-400" aria-hidden />
          <span className="text-xs font-extrabold uppercase tracking-wider text-cyan-300">
            AI Tactical Briefing · Gợi ý Tác chiến
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`mono rounded border px-1.5 py-0.5 text-[10px] font-extrabold ${badge.bg} ${badge.text}`}>
            {badge.label} · {priorityScore}/100
          </span>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            title="Phân tích lại bằng SmartCitizen AI Brain"
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-slate-700 bg-slate-800 text-slate-300 hover:border-cyan-500/50 hover:text-cyan-300 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden />
          </button>
        </div>
      </div>

      {briefing ? (
        <div className={`mt-2.5 space-y-2 ${compact ? 'text-xs' : 'text-xs sm:text-[13px]'} leading-relaxed`}>
          <div className="flex items-start gap-2 rounded-lg bg-slate-950/70 p-2">
            <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden />
            <p className="min-w-0 break-words">
              <strong className="text-rose-300">1. Rủi ro hiện trường:</strong>{' '}
              <span className="text-slate-200">{briefing.riskSummary}</span>
            </p>
          </div>
          <div className="flex items-start gap-2 rounded-lg bg-slate-950/70 p-2">
            <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-cyan-400" aria-hidden />
            <p className="min-w-0 break-words">
              <strong className="text-cyan-300">2. Thiết bị & nhân lực:</strong>{' '}
              <span className="text-slate-200">{briefing.equipmentAndCrew}</span>
            </p>
          </div>
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden />
            <p className="min-w-0 break-words">
              <strong className="text-amber-300">3. Cảnh báo an toàn:</strong>{' '}
              <span className="text-amber-100">{briefing.safetyWarning}</span>
            </p>
          </div>
          <p className="mono text-right text-[10px] text-slate-400">
            Nguồn: {engineLabel}
            {briefing.latencyMs !== undefined ? ` · ${briefing.latencyMs}ms` : ''}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-xs text-slate-400">
          {loading ? 'AI đang tổng hợp phương án tác chiến 3 dòng…' : 'Chưa có dữ liệu tóm tắt tác chiến.'}
        </p>
      )}
    </div>
  );
}
