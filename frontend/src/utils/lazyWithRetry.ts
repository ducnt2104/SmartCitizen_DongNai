import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

const RETRY_PREFIX = 'sc.chunk_retry.v1:';
const PRELOAD_RETRY_KEY = `${RETRY_PREFIX}__vite_preload__`;

/** Nhận diện lỗi tải dynamic chunk sau khi Render/CDN vừa deploy bản build mới (hash chunk thay đổi). */
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Unable to preload CSS|MIME type/i.test(
    msg,
  );
}

function readFlag(key: string): boolean {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    if (value) sessionStorage.setItem(key, '1');
    else sessionStorage.removeItem(key);
  } catch {
    /* bỏ qua nếu trình duyệt chặn sessionStorage */
  }
}

async function purgeStaleAssetCaches(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith('sc-shell') || k.startsWith('sc-assets')).map((k) => caches.delete(k)),
    );
  } catch (err) {
    console.warn('[lazyWithRetry] Không xóa được bộ nhớ đệm Service Worker cũ:', err);
  }
}

/**
 * Bắt sự kiện `vite:preloadError` khi sub-chunk / CSS phụ thuộc bị 404 sau khi Render deploy bản mới.
 * Tự động xóa cache Service Worker và reload đúng 01 lần duy nhất (chống lặp bằng `sessionStorage`).
 */
export function installPreloadRecovery(): void {
  if (typeof window === 'undefined') return;
  writeFlag(PRELOAD_RETRY_KEY, false);
  window.addEventListener('vite:preloadError', (ev) => {
    console.error('[vite:preloadError] Không nạp được sub-chunk sau khi cập nhật phiên bản:', ev);
    if (readFlag(PRELOAD_RETRY_KEY)) return;
    ev.preventDefault();
    writeFlag(PRELOAD_RETRY_KEY, true);
    void purgeStaleAssetCaches().finally(() => {
      window.location.reload();
    });
  });
}

/**
 * Bọc `React.lazy` an toàn cho SPA trên Render:
 * - Nếu tải chunk thất bại do trình duyệt đang giữ `index.html` cũ sau khi deploy bản mới:
 *   xóa cache shell/assets cũ và tự động reload đúng 01 lần duy nhất (chống lặp vô hạn bằng `sessionStorage`).
 * - Nếu nạp thành công: xóa cờ retry để bảo vệ cho các lần deploy tiếp theo.
 * - Nếu sau khi reload vẫn lỗi: ném lỗi lên `RouteErrorBoundary` để hiển thị UI khôi phục thay vì trắng trang.
 */
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
  chunkName: string,
): LazyExoticComponent<T> {
  const storageKey = `${RETRY_PREFIX}${chunkName}`;
  return lazy(async () => {
    try {
      const mod = await factory();
      writeFlag(storageKey, false);
      return mod;
    } catch (err) {
      console.error(`[lazyWithRetry] Lỗi nạp chunk "${chunkName}":`, err);
      if (typeof window !== 'undefined' && isChunkLoadError(err) && !readFlag(storageKey)) {
        writeFlag(storageKey, true);
        await purgeStaleAssetCaches();
        window.location.reload();
        // Trả về promise treo ngắn trong lúc trình duyệt đang chuyển trang reload để không nháy màn lỗi
        return new Promise<{ default: T }>(() => undefined);
      }
      throw err;
    }
  });
}
