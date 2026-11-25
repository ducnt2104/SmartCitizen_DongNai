import { computeSosPriorityScore, toSeverityLabel } from './constants';
import type { Category, ClientReport, Photo, Report, ReportSummary, ScopeStats } from './types';
import { CATEGORIES } from './types';

function sanitizePhotoForClient(p: Photo): Photo {
  if (p.mediaId && p.url.startsWith('data:image/')) {
    return {
      ...p,
      url: `/api/media/${p.mediaId}`,
      thumbnailUrl: p.thumbnailUrl ?? `/api/media/${p.mediaId}?variant=thumb`,
    };
  }
  return p;
}

export function toClientReport(r: Report): ClientReport {
  const { reporterId: _rid, contributors, confirmations, ...rest } = r;
  void _rid;
  const safeConfirmCount = Array.isArray(confirmations)
    ? confirmations.length
    : ((r as unknown as { confirmCount?: number }).confirmCount ?? 0);
  const safeContributorCount = Array.isArray(contributors)
    ? contributors.length
    : ((r as unknown as { contributorCount?: number }).contributorCount ?? 1);
  const priorityScore =
    r.priorityScore ??
    r.ai?.priorityScore ??
    computeSosPriorityScore({
      severity: r.severity,
      isEmergency: r.isEmergency || r.emergencyLevel === 1,
      onArterial: r.onArterial,
      clusterCount: r.clusterCount,
      confirmCount: safeConfirmCount,
    });
  const severityLabel =
    r.severityLabel ?? r.ai?.severityLabel ?? toSeverityLabel(r.severity, r.isEmergency || r.emergencyLevel === 1);
  const safePhotos = Array.isArray(r.photos) ? r.photos.map(sanitizePhotoForClient) : [];
  const safeAfterPhoto = r.afterPhoto ? sanitizePhotoForClient(r.afterPhoto) : null;
  return {
    ...rest,
    photos: safePhotos,
    afterPhoto: safeAfterPhoto,
    priorityScore,
    severityLabel,
    confirmCount: safeConfirmCount,
    contributorCount: safeContributorCount,
  };
}

/** Bản tóm tắt nhẹ cho endpoint bản đồ bbox (loại bỏ payload ảnh base64 lớn). */
export function toReportSummary(r: Report): ReportSummary {
  const safeConfirmCount = Array.isArray(r.confirmations)
    ? r.confirmations.length
    : ((r as unknown as { confirmCount?: number }).confirmCount ?? 0);
  const priorityScore =
    r.priorityScore ??
    r.ai?.priorityScore ??
    computeSosPriorityScore({
      severity: r.severity,
      isEmergency: r.isEmergency || r.emergencyLevel === 1,
      onArterial: r.onArterial,
      clusterCount: r.clusterCount,
      confirmCount: safeConfirmCount,
    });
  const severityLabel =
    r.severityLabel ?? r.ai?.severityLabel ?? toSeverityLabel(r.severity, r.isEmergency || r.emergencyLevel === 1);
  const firstPhoto = r.photos?.[0];
  const rawThumb = firstPhoto?.thumbnailUrl ?? (firstPhoto?.mediaId ? `/api/media/${firstPhoto.mediaId}?variant=thumb` : firstPhoto?.url);
  const thumbnailUrl = rawThumb && !rawThumb.startsWith('data:') ? rawThumb : null;
  return {
    id: r.id,
    code: r.code,
    category: r.category,
    title: r.title,
    severity: r.severity,
    severityLabel,
    priorityScore,
    isEmergency: r.isEmergency,
    emergencyLevel: r.emergencyLevel,
    priority: r.priority,
    status: r.status,
    wardCode: r.wardCode,
    lat: r.lat,
    lng: r.lng,
    clusterCount: r.clusterCount,
    confirmCount: safeConfirmCount,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    createdAt: r.createdAt,
  };
}

type StatsInput = Pick<ClientReport, 'category' | 'status' | 'createdAt' | 'resolvedAt' | 'isEmergency' | 'slaDueAt' | 'wardCode'>;

/** Thống kê dùng chung cho server và bản local-first để hai nơi luôn cho cùng số liệu. */
export function computeStats(list: readonly StatsInput[], scope: string, nowMs: number = Date.now()): ScopeStats {
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  let resolved = 0;
  let sumMs = 0;
  let emergency = 0;
  let quarantined = 0;
  let slaOverdue = 0;
  for (const r of list) {
    byCategory[r.category] += 1;
    if (r.status === 'resolved' && r.resolvedAt) {
      resolved += 1;
      sumMs += Date.parse(r.resolvedAt) - Date.parse(r.createdAt);
    } else if (r.status !== 'quarantined' && r.status !== 'rejected') {
      if (r.isEmergency) emergency += 1;
      if (r.slaDueAt && Date.parse(r.slaDueAt) < nowMs) slaOverdue += 1;
    }
    if (r.status === 'quarantined') quarantined += 1;
  }
  const total = list.length;
  return {
    scope,
    total,
    resolved,
    open: total - resolved,
    resolvedPct: total === 0 ? 0 : Math.round((resolved / total) * 1000) / 10,
    avgDays: resolved === 0 ? 0 : Math.round((sumMs / resolved / 86400000) * 10) / 10,
    byCategory,
    emergency,
    quarantined,
    slaOverdue,
  };
}
