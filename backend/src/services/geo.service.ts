import type { ReverseGeocodeResult } from '../shared/types';
import { MultiTierGeocodeService } from './geocode';

/**
 * Dịch vụ Reverse Geocoding Đa Tầng cho 95 Phường/Xã TP. Đồng Nai
 * (ủy quyền cho `MultiTierGeocodeService` với cache tọa độ 5 chữ số thập phân ~1.1m).
 */
export class GeoService {
  private readonly engine = new MultiTierGeocodeService();

  async reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult> {
    return this.engine.reverseGeocode(lat, lng);
  }
}
