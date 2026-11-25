import { Ban, Download, FileJson, FileSpreadsheet, RotateCcw, ShieldCheck, ShieldX, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { UserProfile } from '@shared/types';
import { Spinner } from '../../components/ui';
import { DONG_NAI_WARDS } from '../../data/dongNaiWards';
import { useI18n } from '../../i18n';
import { api, ApiError, downloadFile, NetworkError } from '../../lib/api';
import { useToast } from '../../state/toast';
import { useAudit } from './useAdminData';

const WARDS_PHUONG = DONG_NAI_WARDS.filter((w) => w.kind === 'Phường');
const WARDS_XA = DONG_NAI_WARDS.filter((w) => w.kind === 'Xã');

/** Audit Log bất biến (hash chain), xuất báo cáo tháng CSV/JSON, quản trị cán bộ 95 Phường/Xã (cấp TP). */
export function AuditView({ scope, isCity }: { scope: string; isCity: boolean }) {
  const { t, fmtDate } = useI18n();
  const toast = useToast();
  const audit = useAudit();
  const [month, setMonth] = useState('2026-11');
  const [verify, setVerify] = useState<{ valid: boolean; total: number; brokenAtSeq: number | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [staff, setStaff] = useState<UserProfile[]>([]);

  // Form cấp tài khoản Cán bộ Phường/Xã (dành cho ADMIN)
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newWard, setNewWard] = useState(WARDS_PHUONG[0]?.wardCode ?? 'DN-TB');
  const [newEmail, setNewEmail] = useState('');

  useEffect(() => {
    if (!isCity) return;
    api<UserProfile[]>('/api/admin/staff')
      .then(setStaff)
      .catch((e) => console.warn('Không tải được danh sách cán bộ:', e));
  }, [isCity]);

  const fail = (e: unknown): void =>
    toast('error', t('ioc.actionFail'), e instanceof ApiError ? e.message : e instanceof NetworkError ? t('state.offlineErr') : undefined);

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
      await downloadFile(
        `/api/admin/export?format=${format}&month=${month}&scope=${encodeURIComponent(scope)}`,
        `bao-cao-${scope.replace(':', '-')}-${month}.${format}`,
      );
      toast('success', t('ioc.exported'));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const createOfficer = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy('createStaff');
    try {
      const created = await api<UserProfile>('/api/admin/staff', {
        method: 'POST',
        body: {
          staffCode: newCode.trim().toUpperCase(),
          name: newName.trim(),
          password: newPassword,
          wardCode: newWard,
          ...(newEmail.trim() ? { email: newEmail.trim() } : {}),
        },
      });
      setStaff((prev) => [created, ...prev]);
      setNewCode('');
      setNewName('');
      setNewPassword('');
      setNewEmail('');
      toast('success', t('ioc.staffCreated'));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const toggleRevoke = async (officer: UserProfile): Promise<void> => {
    setBusy(`rev-${officer.id}`);
    try {
      const nextRevoked = !officer.revoked;
      const updated = await api<UserProfile>(`/api/admin/staff/${officer.id}/revoke`, {
        method: 'PATCH',
        body: { revoked: nextRevoked },
      });
      setStaff((prev) => prev.map((s) => (s.id === officer.id ? updated : s)));
      toast('success', nextRevoked ? t('ioc.staffRevoked') : t('ioc.staffRestored'));
    } catch (err) {
      fail(err);
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
          <button type="button" className="ioc-btn ioc-btn-cyan" disabled={busy !== null} onClick={() => void exp('csv')}>
            {busy === 'csv' ? <Spinner /> : <FileSpreadsheet className="h-4 w-4" aria-hidden />}CSV
          </button>
          <button type="button" className="ioc-btn" disabled={busy !== null} onClick={() => void exp('json')}>
            {busy === 'json' ? <Spinner /> : <FileJson className="h-4 w-4" aria-hidden />}JSON
          </button>
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
              <button type="button" className="ioc-btn ioc-btn-green" disabled={busy !== null} onClick={() => void doVerify()}>
                {busy === 'verify' ? <Spinner /> : <ShieldCheck className="h-4 w-4" aria-hidden />}{t('ioc.verifyChain')}
              </button>
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
              <thead className="sticky top-0 bg-ioc-panel">
                <tr className="border-b border-ioc-line">
                  <th className="ioc-th">#</th>
                  <th className="ioc-th">{t('ioc.auditTime')}</th>
                  <th className="ioc-th">{t('ioc.auditActor')}</th>
                  <th className="ioc-th">{t('ioc.auditAction')}</th>
                  <th className="ioc-th">{t('ioc.auditTarget')}</th>
                  <th className="ioc-th">{t('ioc.auditChange')}</th>
                  <th className="ioc-th">hash</th>
                </tr>
              </thead>
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
          <div className="border-b border-ioc-line p-3">
            <h2 className="text-xs font-bold uppercase tracking-wider text-ioc-dim">{t('ioc.staff')}</h2>
            <form onSubmit={(e) => void createOfficer(e)} className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
              <input className="ioc-field mono" placeholder={t('auth.staffCode')} value={newCode} onChange={(e) => setNewCode(e.target.value)} required minLength={3} maxLength={32} />
              <input className="ioc-field" placeholder={t('profile.name')} value={newName} onChange={(e) => setNewName(e.target.value)} required minLength={2} maxLength={80} />
              <select className="ioc-field" value={newWard} onChange={(e) => setNewWard(e.target.value)} aria-label={t('ioc.colWard')}>
                <optgroup label={t('scope.groupPhuong')}>
                  {WARDS_PHUONG.map((w) => <option key={w.wardCode} value={w.wardCode}>{w.name}</option>)}
                </optgroup>
                <optgroup label={t('scope.groupXa')}>
                  {WARDS_XA.map((w) => <option key={w.wardCode} value={w.wardCode}>{w.name}</option>)}
                </optgroup>
              </select>
              <input className="ioc-field" type="password" placeholder={t('auth.passwordMinHint')} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={8} maxLength={128} />
              <input className="ioc-field" type="email" placeholder="Email (tuỳ chọn)" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
              <button type="submit" className="ioc-btn ioc-btn-cyan" disabled={busy !== null || !newCode || !newName || newPassword.length < 8}>
                {busy === 'createStaff' ? <Spinner /> : <UserPlus className="h-4 w-4" aria-hidden />} {t('ioc.staffCreateBtn')}
              </button>
            </form>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ioc-line">
                  <th className="ioc-th">{t('auth.staffCode')}</th>
                  <th className="ioc-th">{t('ioc.auditActor')}</th>
                  <th className="ioc-th">{t('ioc.colWard')}</th>
                  <th className="ioc-th">{t('ioc.colStatus')}</th>
                  <th className="ioc-th text-right">{t('ioc.auditAction')}</th>
                </tr>
              </thead>
              <tbody>
                {staff.map((s) => (
                  <tr key={s.id} className="border-b border-ioc-line/60">
                    <td className="mono px-3 py-1.5 text-ioc-cyan">{s.staffCode}</td>
                    <td className="px-3 py-1.5">{s.name}</td>
                    <td className="px-3 py-1.5 text-ioc-dim">{s.wardCode ? DONG_NAI_WARDS.find((w) => w.wardCode === s.wardCode)?.name : t('auth.unitCity')}</td>
                    <td className="px-3 py-1.5">
                      <span className={`mono text-xs font-semibold ${s.revoked ? 'text-ioc-red' : 'text-ioc-green'}`}>
                        {s.revoked ? t('ioc.staffStatusRevoked') : t('ioc.staffStatusActive')}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {s.role !== 'admin' && (
                        <button
                          type="button"
                          className={`ioc-btn !min-h-7 !px-2 !text-xs ${s.revoked ? 'ioc-btn-green' : 'ioc-btn-red'}`}
                          disabled={busy !== null}
                          onClick={() => void toggleRevoke(s)}
                        >
                          {busy === `rev-${s.id}` ? <Spinner /> : s.revoked ? <RotateCcw className="h-3.5 w-3.5" aria-hidden /> : <Ban className="h-3.5 w-3.5" aria-hidden />}
                          {s.revoked ? t('ioc.staffRestoreBtn') : t('ioc.staffRevokeBtn')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
