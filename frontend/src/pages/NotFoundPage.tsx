import { AlertTriangle, Home, Map as MapIcon, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n';

export default function NotFoundPage() {
  const { t } = useI18n();

  return (
    <section
      className="card mx-auto max-w-xl space-y-4 p-6 text-center shadow-card sm:p-8"
      aria-labelledby="not-found-heading"
    >
      <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-warn-soft text-warn">
        <AlertTriangle className="h-7 w-7" aria-hidden />
      </div>
      <p className="mono text-xs font-bold uppercase tracking-widest text-muted">404</p>
      <h1 id="not-found-heading" className="text-2xl font-extrabold text-ink">
        {t('notFound.title')}
      </h1>
      <p className="text-sm leading-relaxed text-muted">{t('notFound.text')}</p>
      <div className="flex flex-wrap justify-center gap-2 pt-2">
        <Link to="/" className="btn btn-primary">
          <Home className="h-4 w-4" aria-hidden />
          {t('nav.home')}
        </Link>
        <Link to="/map" className="btn btn-ghost">
          <MapIcon className="h-4 w-4" aria-hidden />
          {t('nav.map')}
        </Link>
        <Link to="/mine" className="btn btn-ghost">
          <Search className="h-4 w-4" aria-hidden />
          {t('nav.mine')}
        </Link>
      </div>
    </section>
  );
}
