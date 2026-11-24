/** Haversine + Bounding Box + Trục huyết mạch (nguồn duy nhất ở /shared, dùng chung với server). */
export {
  haversineMeters, inDongNaiBBox, matchArterial, nearestWard, maskPhone, normalizePhone, ARTERIAL_ROADS,
} from '@shared/geo';
export type { ArterialRoad, ArterialMatch } from '@shared/geo';
export { DONG_NAI_BBOX, CLUSTER_RADIUS_M, GPS_WARN_M } from '@shared/constants';
