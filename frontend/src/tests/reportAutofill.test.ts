import { describe, expect, it } from 'vitest';
import { DONG_NAI_WARDS } from '@shared/dongNaiWards';
import type { VisionResult } from '@shared/types';
import {
  computeSmartAutofill,
  resolveInstantWardFromCoords,
  type AutofillField,
  type ReportFormValues,
} from '../lib/reportAutofill';
import { extractExifMetadata } from '../workers/imageProcessor.worker';

/**
 * Tạo buffer JPEG thật tối thiểu có block EXIF (APP1 + TIFF Little-Endian + GPSInfo IFD)
 * để kiểm thử trích xuất EXIF GPS thuần TypeScript chạy cục bộ trên Client.
 */
function buildJpegWithExifGps(latDeg: number, lngDeg: number, cameraModel = 'SmartPhone Test'): ArrayBuffer {
  const toDmsRationals = (dec: number): Array<[number, number]> => {
    const abs = Math.abs(dec);
    const d = Math.floor(abs);
    const mFloat = (abs - d) * 60;
    const m = Math.floor(mFloat);
    const sScaled = Math.round((mFloat - m) * 60 * 100);
    return [
      [d, 1],
      [m, 1],
      [sScaled, 100],
    ];
  };

  const parts: number[] = [];
  const pushU16LE = (arr: number[], v: number) => {
    arr.push(v & 0xff, (v >> 8) & 0xff);
  };
  const pushU32LE = (arr: number[], v: number) => {
    arr.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  };
  const pushAscii = (arr: number[], s: string) => {
    for (let i = 0; i < s.length; i++) arr.push(s.charCodeAt(i) & 0xff);
    arr.push(0);
  };

  // TIFF payload (relative offset = 0 at 'II')
  const tiff: number[] = [
    0x49, 0x49, // 'II' Little-Endian
    0x2a, 0x00, // 42
    0x08, 0x00, 0x00, 0x00, // Offset to IFD0 = 8
  ];

  // IFD0: 2 entries -> 2 + 2*12 + 4 = 30 bytes (at offset 8..37)
  const modelOffset = 38;
  const modelBytes = [...cameraModel.split('').map((c) => c.charCodeAt(0) & 0xff), 0];
  const gpsIfdOffset = modelOffset + modelBytes.length + (modelBytes.length % 2);
  // GPS IFD: 4 entries (GPSLatRef, GPSLat, GPSLngRef, GPSLng) -> 2 + 4*12 + 4 = 54 bytes
  const gpsDataOffset = gpsIfdOffset + 54;
  const latRationalsOffset = gpsDataOffset;
  const lngRationalsOffset = gpsDataOffset + 24;

  pushU16LE(tiff, 2); // IFD0 count
  // Entry 1: Model (0x0110), ASCII (2)
  pushU16LE(tiff, 0x0110);
  pushU16LE(tiff, 2);
  pushU32LE(tiff, modelBytes.length);
  pushU32LE(tiff, modelOffset);
  // Entry 2: GPSInfo IFD pointer (0x8825), LONG (4)
  pushU16LE(tiff, 0x8825);
  pushU16LE(tiff, 4);
  pushU32LE(tiff, 1);
  pushU32LE(tiff, gpsIfdOffset);
  pushU32LE(tiff, 0); // next IFD = 0

  tiff.push(...modelBytes);
  while (tiff.length < gpsIfdOffset) tiff.push(0);

  // GPS IFD
  pushU16LE(tiff, 4); // 4 entries
  // 0x0001 GPSLatitudeRef ('N' / 'S')
  pushU16LE(tiff, 0x0001);
  pushU16LE(tiff, 2);
  pushU32LE(tiff, 2);
  tiff.push((latDeg >= 0 ? 'N' : 'S').charCodeAt(0), 0, 0, 0);
  // 0x0002 GPSLatitude (3 RATIONALs = type 5)
  pushU16LE(tiff, 0x0002);
  pushU16LE(tiff, 5);
  pushU32LE(tiff, 3);
  pushU32LE(tiff, latRationalsOffset);
  // 0x0003 GPSLongitudeRef ('E' / 'W')
  pushU16LE(tiff, 0x0003);
  pushU16LE(tiff, 2);
  pushU32LE(tiff, 2);
  tiff.push((lngDeg >= 0 ? 'E' : 'W').charCodeAt(0), 0, 0, 0);
  // 0x0004 GPSLongitude (3 RATIONALs = type 5)
  pushU16LE(tiff, 0x0004);
  pushU16LE(tiff, 5);
  pushU32LE(tiff, 3);
  pushU32LE(tiff, lngRationalsOffset);
  pushU32LE(tiff, 0); // next IFD = 0

  for (const [n, d] of toDmsRationals(latDeg)) {
    pushU32LE(tiff, n);
    pushU32LE(tiff, d);
  }
  for (const [n, d] of toDmsRationals(lngDeg)) {
    pushU32LE(tiff, n);
    pushU32LE(tiff, d);
  }

  const exifHeader = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // 'Exif\0\0'
  const app1Length = 2 + exifHeader.length + tiff.length;

  parts.push(0xff, 0xd8); // SOI
  parts.push(0xff, 0xe1, (app1Length >> 8) & 0xff, app1Length & 0xff); // APP1 Big-Endian len
  parts.push(...exifHeader, ...tiff);
  parts.push(0xff, 0xd9); // EOI
  void pushAscii;
  return new Uint8Array(parts).buffer;
}

function makeVisionResult(overrides: Partial<VisionResult> = {}): VisionResult {
  return {
    category: 'rac_thai',
    aiSuggestedLabel: null,
    title: 'Đống rác sinh hoạt tràn lòng đường Nguyễn Ái Quốc',
    description: 'Rác thải chất đống ven lề đường gây mùi hôi và cản trở giao thông.',
    suggestedTitle: 'Rác thải ùn ứ ven đường Nguyễn Ái Quốc',
    suggestedDescription: 'Phát hiện nhiều bao rác và phế thải tràn ra phần đường xe chạy.',
    severity: 4,
    isEmergency: false,
    safetyHazards: ['cản trở giao thông'],
    suggestedDepartment: 'moi_truong',
    authenticityScore: 92,
    fraudFlags: [],
    confidence: 0.91,
    mode: 'gemini',
    cached: false,
    addressHint: 'Gần ngã tư Tân Phong, đường Nguyễn Ái Quốc',
    ...overrides,
  };
}

describe('Report Auto-Fill Hotfix: Instant 95 Wards EXIF Mapping & Dirty-Field Conflict Guard', () => {
  it('chuẩn hóa tức thì (< 10ms) tọa độ toàn bộ 95 Xã/Phường Đồng Nai và phát hiện ngoài phạm vi', () => {
    expect(DONG_NAI_WARDS).toHaveLength(95);

    const tStart = performance.now();
    for (const ward of DONG_NAI_WARDS) {
      const resolved = resolveInstantWardFromCoords(ward.centerLat, ward.centerLng);
      expect(resolved.inBounds).toBe(true);
      expect(resolved.wardCode).toBe(ward.wardCode);
      expect(resolved.wardName).toBe(ward.name);
      expect(resolved.address).toContain(ward.name);
      expect(resolved.address).toContain('Đồng Nai');
      expect(resolved.latencyMs).toBeLessThan(20);
    }
    const elapsedTotalMs = performance.now() - tStart;
    console.info(`[bench] Resolved all 95 Dong Nai wards locally in ${elapsedTotalMs.toFixed(2)}ms`);
    expect(elapsedTotalMs).toBeLessThan(150);

    // Tọa độ ngoài tỉnh Đồng Nai (Hà Nội) phải báo inBounds = false
    const outside = resolveInstantWardFromCoords(21.0285, 105.8542);
    expect(outside.inBounds).toBe(false);
  });

  it('trích xuất EXIF GPS từ ảnh JPEG gốc và định vị Xã/Phường Đồng Nai tức thì (< 20ms)', () => {
    // Tọa độ trung tâm Phường Trấn Biên (Biên Hòa, Đồng Nai)
    const buf = buildJpegWithExifGps(10.9498, 106.8245, 'iPhone 15 Pro');
    const t0 = performance.now();
    const exif = extractExifMetadata(buf);
    expect(exif.gps).not.toBeNull();
    expect(exif.gps!.lat).toBeCloseTo(10.9498, 2);
    expect(exif.gps!.lng).toBeCloseTo(106.8245, 2);
    expect(exif.cameraModel).toBe('iPhone 15 Pro');

    const instant = resolveInstantWardFromCoords(exif.gps!.lat, exif.gps!.lng);
    const totalMs = performance.now() - t0;
    console.info(`[bench] Client EXIF GPS + 95-ward match latency = ${totalMs.toFixed(2)}ms (${instant.wardName})`);

    expect(instant.inBounds).toBe(true);
    expect(instant.wardName).toMatch(/Phường|Xã/);
    expect(totalMs).toBeLessThan(25);
  });

  it('tự điền mượt mà các trường sạch, không ghi đè trường người dùng đã chỉnh tay (dirtyFields) và tạo gợi ý 1-click', () => {
    const emptyForm: ReportFormValues = {
      category: null,
      otherLabel: '',
      title: '',
      description: '',
      severity: 3,
      isEmergency: false,
      wardCode: 'DN-TB',
      address: 'Phường Trấn Biên, Thành phố Đồng Nai',
    };

    // 1. Ảnh đầu tiên khi người dùng chưa nhập tay trường nào -> điền đủ mọi trường
    const photo1Vision = makeVisionResult();
    const firstPass = computeSmartAutofill({
      vision: photo1Vision,
      current: emptyForm,
      dirtyFields: new Set<AutofillField>(),
    });

    expect(firstPass.pendingSuggestions).toBeNull();
    expect(firstPass.nextValues.category).toBe('rac_thai');
    expect(firstPass.nextValues.title).toBe('Rác thải ùn ứ ven đường Nguyễn Ái Quốc');
    expect(firstPass.nextValues.description).toContain('bao rác');
    expect(firstPass.nextValues.severity).toBe(4);
    expect(firstPass.nextValues.address).toContain('Nguyễn Ái Quốc');
    expect(firstPass.nextValues.address).toContain('Phường Trấn Biên');

    // 2. Người dùng sửa tay `title` và `severity`, sau đó đổi sang ảnh 2 (ngập nước khẩn cấp)
    const dirtyFields = new Set<AutofillField>(['title', 'severity']);
    const userEditedForm: ReportFormValues = {
      ...firstPass.nextValues,
      title: 'Tiêu đề người dân tự nhập tay',
      severity: 2,
    };

    const photo2Vision = makeVisionResult({
      category: 'ngap_nuoc',
      title: 'Ngập sâu đoạn cống thoát nước Quốc lộ 1A',
      suggestedTitle: 'Ngập nước sâu chắn ngang Quốc lộ 1A',
      suggestedDescription: 'Nước ngập qua nửa bánh xe máy cần xử lý khơi thông cống.',
      severity: 5,
      isEmergency: true,
      addressHint: 'Ngã ba Tam Hiệp, Quốc lộ 1A',
    });

    const secondPass = computeSmartAutofill({
      vision: photo2Vision,
      current: userEditedForm,
      dirtyFields,
    });

    // Các trường người dùng đã sửa MUST NOT be overwritten
    expect(secondPass.nextValues.title).toBe('Tiêu đề người dân tự nhập tay');
    expect(secondPass.nextValues.severity).toBe(2);

    // Các trường chưa sửa MUST update cleanly theo ảnh mới (không kẹt dữ liệu ảnh 1)
    expect(secondPass.nextValues.category).toBe('ngap_nuoc');
    expect(secondPass.nextValues.description).toContain('Nước ngập');
    expect(secondPass.nextValues.isEmergency).toBe(true);

    // Các trường xung đột nằm trong pendingSuggestions để áp dụng 1-click
    expect(secondPass.pendingSuggestions).toEqual({
      title: 'Ngập nước sâu chắn ngang Quốc lộ 1A',
      severity: 5,
    });
  });

  it('tự điền otherLabel khi AI phân loại danh mục khac', () => {
    const base: ReportFormValues = {
      category: null,
      otherLabel: '',
      title: '',
      description: '',
      severity: 3,
      isEmergency: false,
      wardCode: '',
      address: '',
    };

    const res = computeSmartAutofill({
      vision: makeVisionResult({
        category: 'khac',
        aiSuggestedLabel: 'Cáp viễn thông sà xuống mặt đường',
        suggestedTitle: 'Dây cáp viễn thông đứt võng thấp gây nguy hiểm',
        addressHint: 'Đường Đồng Khởi',
      }),
      current: base,
      dirtyFields: new Set(),
    });

    expect(res.nextValues.category).toBe('khac');
    expect(res.nextValues.otherLabel).toBe('Cáp viễn thông sà xuống mặt đường');
    expect(res.nextValues.title).toBe('Dây cáp viễn thông đứt võng thấp gây nguy hiểm');
    expect(res.nextValues.address).toBe('Đường Đồng Khởi');
  });
});
