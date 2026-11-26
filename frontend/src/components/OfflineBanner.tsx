import { CloudOff, Pencil, RefreshCw, Trash2, WifiOff } from 'lucide-react';
import { useOnline, useOutbox } from '../db/hooks';
import { discardOutboxItem, processOutbox, retryFailed } from '../db/sync';
import { useI18n } from '../i18n';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../lib/authStore';

/** Offline Banner: hiển thị số đơn đang chờ trong Outbox Queue, lý do lỗi cụ thể và nút Sửa / Thử lại / Xóa. */
export function OfflineBanner({ dark = false }: { dark?: boolean }) {
  const { t } = useI18n();
  const online = useOnline();
  const outbox = useOutbox();
  const session = useSession();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const waitingAuth = outbox.filter((o) => o.state === 'waiting_auth').length;
  const failed = outbox.filter((o) => o.state === 'failed');
  if (online && outbox.length === 0) return null;

  const open = userOpen ?? failed.length > 0;
  const tone = !online ? 'bg-slate-900 text-white' : failed.length ? 'bg-danger-soft text-danger' : 'bg-warn-soft text-warn';
  return (
    <div className={`${dark ? 'border-b border-ioc-line bg-ioc-panel text-ioc-amber' : tone} px-3 py-2 text-sm`} role="status">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-1">
        {online ? <CloudOff className="h-4 w-4 shrink-0" aria-hidden /> : <WifiOff className="h-4 w-4 shrink-0" aria-hidden />}
        <p className="min-w-0 flex-1 font-semibold">
          {!online ? t('offline.banner', { n: outbox.length }) : t('offline.pending', { n: outbox.length })}
          {failed.length > 0 && failed[0].lastError ? ` · ${failed[0].lastError}` : ''}
          {online && waitingAuth > 0 && !session && (
            <> · <Link to="/auth" className="underline">{t('offline.loginToSend')}</Link></>
          )}
        </p>
        {outbox.length > 0 && (
          <button type="button" className="rounded-lg px-2 py-1 font-semibold underline" onClick={() => setUserOpen(!open)}>
            {open ? t('common.hide') : t('common.details')}
          </button>
        )}
        {online && outbox.length > 0 && (
          <button type="button" className="inline-flex items-center gap-1 rounded-lg px-2 py-1 font-semibold underline" onClick={() => void processOutbox()}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> {t('offline.syncNow')}
          </button>
        )}
      </div>
      {open && (
        <ul className="mx-auto mt-2 max-w-5xl space-y-1.5">
          {outbox.map((o) => {
            const editable = o.kind === 'create_report' || o.kind === 'proxy_report';
            const payloadTitle =
              o.payload && typeof o.payload === 'object' && 'title' in o.payload
                ? String((o.payload as { title?: unknown }).title ?? '').trim()
                : '';
            return (
              <li key={o.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-black/10 px-2.5 py-2">
                <div className="min-w-0 flex-1 space-y-0.5 text-xs">
                  <div className="flex flex-wrap items-center gap-2 font-semibold">
                    <span className="mono">{o.kind}</span>
                    {payloadTitle && <span className="break-words">{payloadTitle}</span>}
                    <span className="opacity-80">
                      ({t(`outbox.${o.state}`)} · {t('outbox.attempts', { n: o.attempts })})
                    </span>
                  </div>
                  {o.lastError && <p className="break-words font-medium">{o.lastError}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {editable && (
                    <Link
                      to={`/report?editOutbox=${encodeURIComponent(o.id)}`}
                      className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold underline"
                    >
                      <Pencil className="h-3 w-3" aria-hidden />
                      {t('outbox.edit')}
                    </Link>
                  )}
                  {(o.state === 'failed' || (online && o.attempts > 0)) && (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold underline"
                      onClick={() => void retryFailed(o.id)}
                    >
                      <RefreshCw className="h-3 w-3" aria-hidden />
                      {t('state.retry')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold underline"
                    onClick={() => void discardOutboxItem(o.id)}
                  >
                    <Trash2 className="h-3 w-3" aria-hidden />
                    {t('outbox.remove')}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
