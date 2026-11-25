import { DEPARTMENT_BY_CATEGORY } from '@shared/constants';
import { nearestWard, matchArterial } from '@shared/geo';
import type { Category, ClientReport, VisionResult } from '@shared/types';
import { db } from '../db/localDb';
import { enqueue } from '../db/sync';
import type { EdgeStatsMsg, ExtractedExifMetadata } from '../lib/imageProcessor';
import { authStore } from './authStore';

export interface SubmitPhotoPayload {
  dHash: string;
  displayBlob?: Blob;
  aiBlob?: Blob;
  previewUrl?: string;
  dataUrl?: string;
  exif?: ExtractedExifMetadata;
}

export interface SubmitInput {
  category: Category;
  aiSuggestedLabel?: string | null;
  title: string;
  description: string;
  severity?: 1 | 2 | 3 | 4 | 5;
  isEmergency?: boolean;
  lat: number;
  lng: number;
  wardCode: string;
  address: string;
  photo: SubmitPhotoPayload;
  deviceLat?: number;
  deviceLng?: number;
  leftScene: boolean;
  seniorSubmitted: boolean;
  edge?: EdgeStatsMsg;
  vision: VisionResult | null;
  formLoadedAt?: number;
  website?: string;
}

export function newKey(): string {
  return crypto.randomUUID();
}

/**
 * Local-First: ghi hồ sơ lạc quan vào IndexedDB + Outbox trong cùng một giao dịch → UI hiển thị tức thì,
 * đồng bộ nền với Exponential Backoff; `idempotencyKey` đảm bảo gửi lại không tạo bản trùng.
 */
export async function submitReport(input: SubmitInput, proxy: boolean): Promise<ClientReport> {
  const key = newKey();
  const id = `rp_${key}`;
  const now = new Date().toISOString();
  const arterial = matchArterial(input.lat, input.lng);
  const ward = nearestWard(input.lat, input.lng);
  const v = input.vision;
  const optimistic: ClientReport = {
    id,
    code: `CHO-${key.slice(0, 6).toUpperCase()}`,
    category: input.category,
    aiSuggestedLabel: input.category === 'khac' ? (input.aiSuggestedLabel ?? v?.aiSuggestedLabel ?? null) : null,
    title: input.title,
    description: input.description,
    severity: input.severity ?? v?.severity ?? 3,
    isEmergency: input.isEmergency ?? v?.isEmergency ?? false,
    emergencyLevel: 0,
    priority: 'normal',
    status: 'received',
    wardCode: input.wardCode || ward.wardCode,
    address: input.address,
    roadName: arterial?.name ?? null,
    onArterial: arterial !== null,
    lat: input.lat,
    lng: input.lng,
    photos: [
      {
        id: `ph_${key}`,
        url: input.photo.previewUrl ?? input.photo.dataUrl ?? '',
        dHash: input.photo.dHash,
        kind: 'before',
        takenBy: 'me',
        createdAt: now,
      },
    ],
    afterPhoto: null,
    clusterCount: 1,
    reporterPhoneMasked: '',
    isProxyReport: proxy,
    proxyVolunteerId: null,
    seniorSubmitted: input.seniorSubmitted,
    needsFieldVerification: false,
    assignedVolunteerId: null,
    verification: null,
    ai: {
      authenticityScore: v?.authenticityScore ?? 0, fraudFlags: v?.fraudFlags ?? [], confidence: v?.confidence ?? 0,
      safetyHazards: v?.safetyHazards ?? [], suggestedDepartment: v?.suggestedDepartment ?? DEPARTMENT_BY_CATEGORY[input.category],
      mode: v?.mode ?? 'fallback',
    },
    gpsMismatchWarning: false,
    gpsDistanceKm: null,
    quarantine: null,
    possibleDuplicateOf: null,
    department: null,
    slaDueAt: null,
    dispatches: [],
    resolvedAt: null,
    resolution: null,
    rating: null,
    timeline: [{ stage: 'received', at: now, note: 'Đã lưu trên thiết bị — chờ đồng bộ' }],
    source: 'user',
    createdAt: now,
    updatedAt: now,
    confirmCount: 0,
    contributorCount: 1,
    syncState: 'pending',
    mine: true,
  };

  const payload = {
    idempotencyKey: key,
    category: input.category,
    ...(input.category === 'khac' && input.aiSuggestedLabel ? { aiSuggestedLabel: input.aiSuggestedLabel } : {}),
    title: input.title,
    description: input.description,
    ...(input.severity !== undefined ? { severity: input.severity } : {}),
    ...(input.isEmergency !== undefined ? { isEmergency: input.isEmergency } : {}),
    lat: input.lat,
    lng: input.lng,
    wardCode: input.wardCode,
    address: input.address,
    dHash: input.photo.dHash,
    ...(input.photo.dataUrl && !input.photo.displayBlob ? { photo: { dataUrl: input.photo.dataUrl, dHash: input.photo.dHash } } : {}),
    ...(input.photo.displayBlob ? { displayBlob: input.photo.displayBlob } : {}),
    ...(input.photo.aiBlob ? { aiBlob: input.photo.aiBlob } : {}),
    ...(input.photo.exif ? { exif: input.photo.exif } : {}),
    ...(input.deviceLat !== undefined && input.deviceLng !== undefined ? { deviceLat: input.deviceLat, deviceLng: input.deviceLng } : {}),
    leftScene: input.leftScene,
    isProxyReport: proxy,
    seniorSubmitted: input.seniorSubmitted,
    ...(input.edge ? { edge: input.edge } : {}),
    ...(input.formLoadedAt ? { formLoadedAt: input.formLoadedAt } : {}),
    ...(input.website ? { website: input.website } : {}),
  };

  await db.transaction('rw', db.reports, db.outboxQueue, async () => {
    await db.reports.put(optimistic);
    await db.outboxQueue.put({
      id: key, kind: proxy ? 'proxy_report' : 'create_report', targetId: id, payload, state: authStore.token() ? 'pending' : 'waiting_auth',
      attempts: 0, nextAttemptAt: 0, lastError: null, createdAt: Date.now(),
    });
  });
  await enqueue({ id: key, kind: proxy ? 'proxy_report' : 'create_report', targetId: id, payload });
  return optimistic;
}

const CONFIRMED_KEY = 'sc.confirmed.v1';
export function confirmedIds(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(CONFIRMED_KEY) ?? '[]') as string[]);
  } catch (err) {
    console.warn('Danh sách đã xác nhận bị hỏng:', err);
    return new Set();
  }
}

/** "Cùng xác nhận (+1 Ưu tiên)": cập nhật lạc quan ngay, đồng bộ qua Outbox. */
export async function confirmReport(report: ClientReport): Promise<void> {
  const ids = confirmedIds();
  if (ids.has(report.id)) return;
  ids.add(report.id);
  localStorage.setItem(CONFIRMED_KEY, JSON.stringify([...ids]));
  await db.reports.update(report.id, { confirmCount: report.confirmCount + 1 });
  await enqueue({ id: `cf-${report.id}-${authStore.get()?.user.id ?? 'anon'}`, kind: 'confirm', targetId: report.id, payload: null });
}

export async function rateReport(report: ClientReport, stars: number, comment: string): Promise<void> {
  await db.reports.update(report.id, { rating: { stars: stars as 1 | 2 | 3 | 4 | 5, comment, at: new Date().toISOString() } });
  await enqueue({ id: `rt-${report.id}`, kind: 'rate', targetId: report.id, payload: { stars, comment } });
}

export async function attachAngle(
  report: ClientReport,
  photo: { dHash: string; displayBlob?: Blob; aiBlob?: Blob; dataUrl?: string },
): Promise<void> {
  const payload = photo.displayBlob
    ? { displayBlob: photo.displayBlob, ...(photo.aiBlob ? { aiBlob: photo.aiBlob } : {}), dHash: photo.dHash }
    : { photo: { dataUrl: photo.dataUrl ?? '', dHash: photo.dHash } };
  await enqueue({ id: `at-${report.id}-${photo.dHash}`, kind: 'attach_photo', targetId: report.id, payload });
}
