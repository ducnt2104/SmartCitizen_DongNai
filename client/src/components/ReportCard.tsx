import { ChevronRight, MapPin } from 'lucide-react';
import type { ClientReport } from '@shared/types';
import { useI18n } from '../i18n';
import { CATEGORY_META } from '../lib/meta';
import { CategoryIcon, PriorityBadges, StatusBadge } from './ui';

export function ReportCard({ r, onOpen }: { r: ClientReport; onOpen: (r: ClientReport) => void }) {
  const { t, fmtDate } = useI18n();
  const thumb = r.photos[0]?.url;
  return (
    <button type="button" onClick={() => onOpen(r)} className="card flex w-full items-stretch gap-3 p-3 text-left transition-transform active:scale-[0.99]">
      {thumb ? (
        <img src={thumb} alt="" loading="lazy" className="h-20 w-20 shrink-0 rounded-xl border border-line object-cover" />
      ) : (
        <CategoryIcon r={r} />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={r.status} />
          <PriorityBadges r={r} />
        </span>
        <span className="mt-1 block break-words font-semibold leading-snug text-ink [overflow-wrap:anywhere]">{r.title}</span>
        <span className="mt-0.5 flex items-center gap-1 text-xs text-muted">
          <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{r.address}</span>
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted">
          <span className="mono">{r.code}</span>
          <span style={{ color: CATEGORY_META[r.category].color }} className="font-semibold">{t(CATEGORY_META[r.category].labelKey)}</span>
          <span>{fmtDate(r.createdAt, false)}</span>
        </span>
      </span>
      <ChevronRight className="my-auto h-5 w-5 shrink-0 text-muted" aria-hidden />
    </button>
  );
}
