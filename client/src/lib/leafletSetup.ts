import L from 'leaflet';
import 'leaflet.markercluster';

let heatReady: Promise<void> | null = null;

/** leaflet.heat là script toàn cục cần `window.L`; nạp lười để không phình bundle trang chủ. */
export function ensureHeat(): Promise<void> {
  if (!heatReady) {
    (window as unknown as { L: typeof L }).L = L;
    heatReady = import('leaflet.heat').then(() => undefined);
  }
  return heatReady;
}

export { L };
