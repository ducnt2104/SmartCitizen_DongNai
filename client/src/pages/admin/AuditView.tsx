import { Download, FileJson, FileSpreadsheet, ShieldCheck, ShieldX } from 'lucide-react';
import { useState } from 'react';
import { DONG_NAI_WARDS } from '../../data/dongNaiWards';
import { useI18n } from '../../i18n';
import { api, ApiError, downloadFile, NetworkError } from '../../lib/api';
import { useToast } from '../../state/toast';
import { Spinner } from '../../components/ui';
import { useAudit } from './useAdminData';
import { useEffect } from 'react';
import type { UserProfile } from '@shared/types';

/** Audit Log bất biến (hash chain), xuất báo cáo tháng CSV/JSON, danh sách cán bộ (cấp TP). */
export function AuditView({ scope, isCity }: { scope: string; isCity: boolean }) {
  const { t, fmtDate } = useI18n();
  const toast = useToast();
  const audit = useAudit();
  const [month, setMonth] = useState('2026-11');
  const [verify, setVerify] = useState<{ valid: boolean; total: number; brokenAtSeq: number | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [staff, setStaff] = useState<UserProfile[]>([]);

  useEffect(() => {
    if (!isCity) return;
    api<UserProfile[]>('/api/admin/staff').then(setStaff).catch((e) => console.warn('Không tải được danh sách cán bộ:', e));
  }, [isCity]);

  const fail = (e: unknown): void => toast('error', t('ioc.actionFail'), e instanceof ApiError ? e.message : e instanceof NetworkError ? t('state.offlineErr') : undefined);

  const doVerify = async (): Promise<void> => {
    setBusy('verify');
    try {
      setVerify(await api('/api/admin/audit/verify'));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const exp = async (format: 'csv' | 'json'): Promise<void> => {
    setBusy(format);
    try {
      await downloadFile(`/api/admin/export?format=${format}&month=${month}&scope=${encodeURIComponent(scope)}`, `bao-cao-${scope.replace(':', '-')}-${month}.${format}`);
      toast('success', t('ioc.exported'));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <section className="ioc-panel p-3" aria-label={t('ioc.export')}>
        <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-ioc-dim">{t('ioc.export')}</h2>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="mo" className="mb-1 block text-[11px] font-semibold text-ioc-dim">{t('ioc.month')}</label>
            <input id="mo" type="month" className="ioc-field mono" value={month} onChange={(e) => setMonth(e.target.value)} />
          </div>
          <button type="button" className="ioc-btn ioc-btn-cyan" disabled={busy !== null} onClick={() => void exp('csv')}>{busy === 'csv' ? <Spinner /> : <FileSpreadsheet className="h-4 w-4" aria-hidden />}CSV</button>
          <button type="button" className="ioc-btn" disabled={busy !== null} onClick={() => void exp('json')}>{busy === 'json' ? <Spinner /> : <FileJson className="h-4 w-4" aria-hidden />}JSON</button>
          <p className="text-xs text-ioc-dim"><Download className="mr-1 inline h-3.5 w-3.5" aria-hidden />{t('ioc.exportNote')}</p>
        </div>
      </section>

      <section className="ioc-panel overflow-hidden" aria-label={t('ioc.audit')}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ioc-line p-3">
          <h2 className="text-xs font-bold uppercase tracking-wider text-ioc-dim">{t('ioc.audit')}</h2>
          {isCity && (
            <div className="flex items-center gap-2">
              {verify && (verify.valid
                ? <span className="mono flex items-center gap-1 text-xs font-semibold text-ioc-green"><ShieldCheck className="h-4 w-4" aria-hidden />{t('ioc.chainOk', { n: verify.total })}</span>
                : <span className="mono flex items-center gap-1 text-xs font-semibold text-ioc-red"><ShieldX className="h-4 w-4" aria-hidden />{t('ioc.chainBroken', { n: verify.brokenAtSeq ?? 0 })}</span>)}
              <button type="button" className="ioc-btn ioc-btn-green" disabled={busy !== null} onClick={() => void doVerify()}>{busy === 'verify' ? <Spinner /> : <ShieldCheck className="h-4 w-4" aria-hidden />}{t('ioc.verifyChain')}</button>
            </div>
          )}
        </div>
        {!audit.data && audit.loading ? (
          <div className="space-y-1 p-2">{Array.from({ length: 5 }, (_, i) => <div key={i} className="ioc-skeleton h-8" />)}</div>
        ) : audit.error ? (
          <p className="p-4 text-sm text-ioc-red">{audit.error}</p>
        ) : (audit.data?.length ?? 0) === 0 ? (
          <p className="p-6 text-center text-sm text-ioc-dim">{t('ioc.auditEmpty')}</p>
        ) : (
          <div className="max-h-[60dvh] overflow-auto">
            <table className="w-full min-w-[46rem] text-xs">
              <thead className="sticky top-0 bg-ioc-panel"><tr className="border-b border-ioc-line"><th className="ioc-th">#</th><th className="ioc-th">{t('ioc.auditTime')}</th><th className="ioc-th">{t('ioc.auditActor')}</th><th className="ioc-th">{t('ioc.auditAction')}</th><th className="ioc-th">{t('ioc.auditTarget')}</th><th className="ioc-th">{t('ioc.auditChange')}</th><th className="ioc-th">hash</th></tr></thead>
              <tbody>
                {audit.data!.map((e) => (
                  <tr key={e.id} className="border-b border-ioc-line/60 align-top hover:bg-ioc-raised">
                    <td className="mono px-3 py-1.5 text-ioc-dim">{e.seq}</td>
                    <td className="mono whitespace-nowrap px-3 py-1.5">{fmtDate(e.timestamp)}</td>
                    <td className="px-3 py-1.5">{e.actorName}<span className="mono block text-[10px] text-ioc-dim">{e.role}</span></td>
                    <td className="mono px-3 py-1.5 text-ioc-cyan">{e.action}</td>
                    <td className="mono max-w-[8rem] truncate px-3 py-1.5">{e.targetId}</td>
                    <td className="mono max-w-[16rem] px-3 py-1.5 text-[10px] text-ioc-dim"><span className="block truncate">{JSON.stringify(e.beforeState)}</span><span className="block truncate text-ioc-text">→ {JSON.stringify(e.afterState)}</span></td>
                    <td className="mono px-3 py-1.5 text-[10px] text-ioc-dim">{e.hash.slice(0, 10)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {isCity && (
        <section className="ioc-panel overflow-hidden" aria-label={t('ioc.staff')}>
          <h2 className="border-b border-ioc-line p-3 text-xs font-bold uppercase tracking-wider text-ioc-dim">{t('ioc.staff')}</h2>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-ioc-line"><th className="ioc-th">{t('auth.staffCode')}</th><th className="ioc-th">{t('ioc.auditActor')}</th><th className="ioc-th">{t('ioc.colWard')}</th></tr></thead>
            <tbody>
              {staff.map((s) => (
                <tr key={s.id} className="border-b border-ioc-line/60">
                  <td className="mono px-3 py-1.5 text-ioc-cyan">{s.staffCode}</td><td className="px-3 py-1.5">{s.name}</td>
                  <td className="px-3 py-1.5 text-ioc-dim">{s.wardCode ? DONG_NAI_WARDS.find((w) => w.wardCode === s.wardCode)?.name : t('auth.unitCity')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
