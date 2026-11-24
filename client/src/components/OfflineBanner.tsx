import { CloudOff, RefreshCw, WifiOff } from 'lucide-react';
import { useOnline, useOutbox } from '../db/hooks';
import { discardOutboxItem, processOutbox, retryFailed } from '../db/sync';
import { useI18n } from '../i18n';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../lib/authStore';

/** Offline Banner: hiển thị số đơn đang chờ trong Outbox Queue, trạng thái chờ đăng nhập và đơn lỗi. */
export function OfflineBanner({ dark = false }: { dark?: boolean }) {
  const { t } = useI18n();
  const online = useOnline();
  const outbox = useOutbox();
  const session = useSession();
  const [open, setOpen] = useState(false);
  const waitingAuth = outbox.filter((o) => o.state === 'waiting_auth').length;
  const failed = outbox.filter((o) => o.state === 'failed');
  if (online && outbox.length === 0) return null;

  const tone = !online ? 'bg-slate-900 text-white' : failed.length ? 'bg-danger-soft text-danger' : 'bg-warn-soft text-warn';
  return (
    <div className={`${dark ? 'border-b border-ioc-line bg-ioc-panel text-ioc-amber' : tone} px-3 py-2 text-sm`} role="status">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-1">
        {online ? <CloudOff className="h-4 w-4 shrink-0" aria-hidden /> : <WifiOff className="h-4 w-4 shrink-0" aria-hidden />}
        <p className="min-w-0 flex-1 font-semibold">
          {!online ? t('offline.banner', { n: outbox.length }) : t('offline.pending', { n: outbox.length })}
          {online && waitingAuth > 0 && !session && (
            <> · <Link to="/auth" className="underline">{t('offline.loginToSend')}</Link></>
          )}
        </p>
        {outbox.length > 0 && (
          <button type="button" className="rounded-lg px-2 py-1 font-semibold underline" onClick={() => setOpen((v) => !v)}>
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
        <ul className="mx-auto mt-2 max-w-5xl space-y-1">
          {outbox.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-black/10 px-2 py-1">
              <span className="mono text-xs">{o.kind}</span>
              <span className="min-w-0 flex-1 truncate text-xs">
                {t(`outbox.${o.state}`)} · {t('outbox.attempts', { n: o.attempts })}
                {o.lastError ? ` · ${o.lastError}` : ''}
              </span>
              {o.state === 'failed' && (
                <button type="button" className="rounded px-2 py-0.5 text-xs font-semibold underline" onClick={() => void retryFailed(o.id)}>{t('state.retry')}</button>
              )}
              <button type="button" className="rounded px-2 py-0.5 text-xs font-semibold underline" onClick={() => void discardOutboxItem(o.id)}>{t('common.discard')}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
