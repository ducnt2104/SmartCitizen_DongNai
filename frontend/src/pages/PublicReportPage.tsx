import { ArrowLeft, MapPin, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ClientReport } from '@shared/types';
import { WARD_BY_CODE } from '../data/dongNaiWards';
import { BeforeAfterSlider, Timeline } from '../components/Timeline';
import { EmptyState, PriorityBadges, Spinner, StatusBadge } from '../components/ui';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { CATEGORY_META } from '../lib/meta';

export default function PublicReportPage() {
  const { code = '' } = useParams();
  const { t, fmtDate } = useI18n();
  const [report, setReport] = useState<ClientReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFoundErr, setNotFoundErr] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setNotFoundErr(false);
    void api<ClientReport[]>(`/api/reports/lookup?q=${encodeURIComponent(code)}`)
      .then((list) => {
        if (!active) return;
        const found = list.find((r) => r.code.toLowerCase() === code.toLowerCase()) ?? list[0] ?? null;
        if (!found) setNotFoundErr(true);
        setReport(found);
      })
      .catch(() => {
        if (!active) return;
        setNotFoundErr(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [code]);

  if (loading) {
    return (
      <div className="card flex justify-center p-10">
        <Spinner className="text-brand" />
      </div>
    );
  }

  if (notFoundErr || !report) {
    return (
      <div className="card p-6">
        <EmptyState
          title="Không tìm thấy hồ sơ phản ánh"
          text={`Mã hồ sơ "${code}" không tồn tại hoặc chưa được công khai trên hệ thống SmartCitizen Đồng Nai.`}
          action={<Link to="/mine" className="btn btn-primary">Quay lại tra cứu</Link>}
        />
      </div>
    );
  }

  const ward = WARD_BY_CODE[report.wardCode];
  const mainPhoto = report.photos[0];
  return (
    <article className="mx-auto max-w-3xl space-y-4">
      <Link to="/map" className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand hover:underline">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Xem trên Bản đồ Đồng Nai
      </Link>
      <div className="card space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={report.status} />
          <PriorityBadges r={report} />
          <span className="mono rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-semibold text-muted">
            {report.code}
          </span>
        </div>
        <h1 className="text-xl font-extrabold text-ink sm:text-2xl">{report.title}</h1>
        <p className="text-sm leading-relaxed text-muted">{report.description}</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <span className="flex items-center gap-1 font-semibold text-ink">
            <MapPin className="h-3.5 w-3.5 text-brand" aria-hidden />
            {report.address} {ward ? `(${ward.name})` : ''}
          </span>
          <span style={{ color: CATEGORY_META[report.category].color }} className="font-bold">
            {t(CATEGORY_META[report.category].labelKey)}
          </span>
          <span>Ghi nhận: {fmtDate(report.createdAt)}</span>
        </div>

        {mainPhoto && !report.afterPhoto && (
          <img
            src={mainPhoto.url}
            alt={report.title}
            width={800}
            height={500}
            loading="lazy"
            decoding="async"
            className="aspect-[16/10] w-full rounded-2xl border border-line object-cover"
          />
        )}

        {mainPhoto && report.afterPhoto && (
          <BeforeAfterSlider
            before={mainPhoto.url}
            after={report.afterPhoto.url}
            labelBefore={t('detail.before')}
            labelAfter={t('detail.after')}
          />
        )}

        <div className="rounded-xl bg-surface-2 p-3 text-xs text-muted">
          <p className="flex items-center gap-1.5 font-bold text-ink">
            <ShieldCheck className="h-4 w-4 text-brand" aria-hidden />
            Độ tin cậy hiện trường: {report.ai.authenticityScore}/100
          </p>
        </div>

        <div>
          <h2 className="mb-2 text-sm font-bold text-ink">{t('timeline.title')}</h2>
          <Timeline r={report} />
        </div>
      </div>
    </article>
  );
}
