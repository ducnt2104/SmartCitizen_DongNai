import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboxItem } from '../db/localDb';
import type { SyncEventDetail } from '../db/sync';
import { ApiError } from '../lib/api';
import { computeEdgeStatsAndScreenshot } from '../lib/localCvMath';

const outboxStore = new Map<string, OutboxItem>();
const reportsStore = new Map<string, Record<string, unknown>>();
const apiMock = vi.fn();
const apiMultipartMock = vi.fn();
const tokenMock = vi.fn(() => 'mock-jwt-token');

vi.mock('../db/localDb', () => ({
  db: {
    reports: {
      get: vi.fn(async (id: string) => reportsStore.get(id)),
      put: vi.fn(async (row: { id: string } & Record<string, unknown>) => {
        reportsStore.set(row.id, row);
        return row.id;
      }),
      update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        const prev = reportsStore.get(id);
        if (prev) reportsStore.set(id, { ...prev, ...patch });
        return 1;
      }),
      delete: vi.fn(async (id: string) => {
        reportsStore.delete(id);
      }),
      toArray: vi.fn(async () => [...reportsStore.values()]),
      bulkDelete: vi.fn(async () => undefined),
      bulkPut: vi.fn(async () => undefined),
    },
    outboxQueue: {
      get: vi.fn(async (id: string) => outboxStore.get(id)),
      put: vi.fn(async (item: OutboxItem) => {
        outboxStore.set(item.id, { ...item });
        return item.id;
      }),
      update: vi.fn(async (id: string, patch: Partial<OutboxItem>) => {
        const prev = outboxStore.get(id);
        if (!prev) return 0;
        outboxStore.set(id, { ...prev, ...patch });
        return 1;
      }),
      delete: vi.fn(async (id: string) => {
        outboxStore.delete(id);
      }),
      toArray: vi.fn(async () => [...outboxStore.values()]),
    },
    settings: {
      put: vi.fn(async () => undefined),
    },
    transaction: async (_mode: unknown, ...args: unknown[]) => {
      const fn = args[args.length - 1] as () => Promise<unknown>;
      return fn();
    },
  },
  putSetting: vi.fn(async () => undefined),
}));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    api: (...args: unknown[]) => apiMock(...args),
    apiMultipart: (...args: unknown[]) => apiMultipartMock(...args),
  };
});

vi.mock('../lib/authStore', () => ({
  authStore: {
    token: () => tokenMock(),
    subscribe: () => () => undefined,
    updateUser: vi.fn(),
    get: vi.fn(() => null),
  },
}));

describe('No-EXIF PC/Zalo Tolerance & Outbox Queue Recovery UX', () => {
  beforeEach(() => {
    outboxStore.clear();
    reportsStore.clear();
    apiMock.mockReset();
    apiMultipartMock.mockReset();
    tokenMock.mockReturnValue('mock-jwt-token');
    if (typeof globalThis.navigator === 'undefined') {
      Object.defineProperty(globalThis, 'navigator', {
        value: { onLine: true },
        configurable: true,
      });
    } else {
      Object.defineProperty(globalThis.navigator, 'onLine', {
        value: true,
        configurable: true,
      });
    }
  });

  it('không đánh dấu nhầm screenshot cho ảnh chụp thực tế tỷ lệ 4:3 hoặc 3:4 tải về từ máy tính/Zalo thiếu EXIF', () => {
    const W = 120;
    const H = 90; // 4:3 tỷ lệ camera phổ biến khi tải từ máy tính/Zalo (không EXIF)
    const outdoorGray = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        // Bề mặt có kết cấu vừa phải (đường nhựa/tán cây/góc tối góc sáng tự nhiên)
        const texture = ((x * 13 + y * 19 + ((x * y) % 29)) % 46) - 23;
        const sky = y < 22 ? 190 : 105;
        outdoorGray[y * W + x] = Math.max(0, Math.min(255, sky + texture));
      }
    }
    const stats = computeEdgeStatsAndScreenshot(outdoorGray, W, H, W / H, false);
    expect(stats.likelyScreenshot).toBe(false);
    expect(stats.screenshotConfidence).toBeLessThan(0.72);
  });

  it('429 không lặp lại toast thông báo lỗi liên tục, sau 4 lần chuyển failed với lý do cụ thể; cho phép retry và xóa khỏi hàng đợi', async () => {
    const { processOutbox, retryFailed, discardOutboxItem, syncBus } = await import('../db/sync');

    const events: SyncEventDetail[] = [];
    const onEv = (e: Event): void => {
      events.push((e as CustomEvent<SyncEventDetail>).detail);
    };
    syncBus.addEventListener('sync', onEv);

    try {
      const id = 'outbox-429-item';
      outboxStore.set(id, {
        id,
        kind: 'create_report',
        targetId: 'local-429',
        payload: { title: 'Đèn đường hỏng khu phố 3', category: 'den_duong' },
        state: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
        createdAt: Date.now(),
      });

      apiMock.mockRejectedValue(new ApiError(429, 'rate_limited', 'Hệ thống đang bận, vui lòng chờ giây lát', 5));

      for (let i = 0; i < 4; i++) {
        const cur = outboxStore.get(id)!;
        outboxStore.set(id, { ...cur, nextAttemptAt: 0 });
        await processOutbox();
      }

      const failedEvents = events.filter(
        (e: SyncEventDetail): e is Extract<SyncEventDetail, { type: 'item_failed' }> => e.type === 'item_failed',
      );
      const notifiedToasts = failedEvents.filter((e) => e.notify !== false);
      // Lần 1 báo nhẹ, các lần retry nền ở giữa im lặng, lần 4 báo chuyển failed -> tối đa 2 toast (không lặp vô hạn)
      expect(notifiedToasts.length).toBeLessThanOrEqual(2);
      expect(outboxStore.get(id)?.state).toBe('failed');
      expect(outboxStore.get(id)?.lastError).toContain('Hệ thống đang bận');

      // Cho phép Retry -> đưa về pending ngay lập tức
      apiMock.mockResolvedValueOnce({
        outcome: 'created',
        messageCode: 'created',
        report: { id: 'srv-1', code: 'DN-TB-2611-901' },
      });
      await retryFailed(id);
      await new Promise((r) => setTimeout(r, 20));
      expect(outboxStore.has(id)).toBe(false);

      // Giữ lại đơn failed khi lỗi 422/400 cụ thể (thay vì âm thầm xóa) & hỗ trợ Xóa khỏi hàng đợi
      const id2 = 'outbox-4xx-item';
      reportsStore.set('local-4xx', { id: 'local-4xx', syncState: 'pending' });
      outboxStore.set(id2, {
        id: id2,
        kind: 'create_report',
        targetId: 'local-4xx',
        payload: { title: 'https://promo.example spam', category: 'khac' },
        state: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
        createdAt: Date.now(),
      });
      apiMock.mockRejectedValueOnce(new ApiError(422, 'SPAM_TEXT_REJECTED', 'Nội dung chứa liên kết quảng cáo'));
      await processOutbox();

      const savedFailed = outboxStore.get(id2);
      expect(savedFailed?.state).toBe('failed');
      expect(savedFailed?.lastError).toBe('Nội dung chứa liên kết quảng cáo');
      expect(reportsStore.has('local-4xx')).toBe(false);

      await discardOutboxItem(id2);
      expect(outboxStore.has(id2)).toBe(false);
    } finally {
      syncBus.removeEventListener('sync', onEv);
    }
  });
});
