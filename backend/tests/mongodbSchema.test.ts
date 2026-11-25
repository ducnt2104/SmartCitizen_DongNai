import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { buildMongoConnectOptions, connectMongoDB } from '../src/config/db';
import {
  computePriorityScore,
  DONG_NAI_GEO_BOUNDS,
  Incident,
  INCIDENT_CATEGORIES,
  INCIDENT_STATUSES,
  incidentSchema,
  isWithinDongNaiBounds,
  LEGACY_INCIDENT_CATEGORIES,
  SpamLog,
  SPAM_LOG_TTL_SECONDS,
  spamLogSchema,
  User,
  userSchema,
} from '../src/models';
import { buildDongNaiSeedDataset } from '../src/seed/seedDongNai';
import {
  detectAndMergeDuplicateIncident,
  findDuplicateIncident,
  selectBestDuplicateCandidate,
} from '../src/services/duplicateIncident.service';

describe('MongoDB Schemas & Indexes bắt buộc', () => {
  it('incidents có đủ 2dsphere, compound IOC, media.dHash, unique sparse clientOfflineId và priorityScore', () => {
    const indexes = incidentSchema.indexes();
    const hasIndex = (keys: Record<string, unknown>, optCheck?: (opts: Record<string, unknown>) => boolean) =>
      indexes.some(([k, opts]) => JSON.stringify(k) === JSON.stringify(keys) && (!optCheck || optCheck(opts as Record<string, unknown>)));

    expect(hasIndex({ location: '2dsphere' })).toBe(true);
    expect(hasIndex({ status: 1, district: 1, priorityScore: -1, createdAt: -1 })).toBe(true);
    expect(hasIndex({ 'media.dHash': 1 })).toBe(true);
    expect(hasIndex({ clientOfflineId: 1 }, (o) => o.unique === true && o.sparse === true)).toBe(true);
    expect(hasIndex({ priorityScore: -1 })).toBe(true);
  });

  it('users có unique sparse clientOfflineId và index phân quyền địa bàn', () => {
    const indexes = userSchema.indexes();
    expect(
      indexes.some(
        ([k, o]) => JSON.stringify(k) === JSON.stringify({ clientOfflineId: 1 }) && o.unique === true && o.sparse === true,
      ),
    ).toBe(true);
    expect(userSchema.path('phoneNumber').options.unique).toBe(true);
  });

  it('spam_logs có TTL Index 30 ngày (2592000s) trên blockedAt và unique sparse clientOfflineId', () => {
    const indexes = spamLogSchema.indexes();
    expect(
      indexes.some(
        ([k, o]) => JSON.stringify(k) === JSON.stringify({ blockedAt: 1 }) && o.expireAfterSeconds === SPAM_LOG_TTL_SECONDS,
      ),
    ).toBe(true);
    expect(SPAM_LOG_TTL_SECONDS).toBe(2592000);
    expect(
      indexes.some(
        ([k, o]) => JSON.stringify(k) === JSON.stringify({ clientOfflineId: 1 }) && o.unique === true && o.sparse === true,
      ),
    ).toBe(true);
  });
});

describe('Validation địa lý Đồng Nai & Schema constraints', () => {
  it('khung bao địa lý toàn Thành phố Đồng Nai (lat 10.50–12.28, lng 106.42–107.68)', () => {
    expect(DONG_NAI_GEO_BOUNDS).toEqual({ latMin: 10.5, latMax: 12.28, lngMin: 106.42, lngMax: 107.68 });
    expect(isWithinDongNaiBounds(106.8243, 10.9465)).toBe(true); // Phường Trấn Biên
    expect(isWithinDongNaiBounds(107.3618, 11.4215)).toBe(true); // Xã Tà Lài
    expect(isWithinDongNaiBounds(107.092, 12.142)).toBe(true);   // Xã Bù Gia Mập (Bắc Đồng Nai)
    expect(isWithinDongNaiBounds(105.8542, 21.0285)).toBe(false); // Hà Nội
    expect(isWithinDongNaiBounds(10.9465, 106.8243)).toBe(false); // Bị đảo ngược [lat, lng]
  });

  it('User: chuẩn hóa SĐT +84, mặc định trustScore = 100, bắt buộc assignedArea với ward_officer', () => {
    const citizen = new User({ phoneNumber: '+84 912 345 678', fullName: 'Nguyễn Văn A' });
    expect(citizen.validateSync()).toBeUndefined();
    expect(citizen.phoneNumber).toBe('0912345678');
    expect(citizen.trustScore).toBe(100);
    expect(citizen.syncStatus).toBe('synced');

    const officerMissingArea = new User({ phoneNumber: '0912345679', fullName: 'Cán bộ thiếu địa bàn', role: 'ward_officer' });
    expect(officerMissingArea.validateSync()?.errors.assignedArea).toBeDefined();

    const officerOk = new User({
      phoneNumber: '0912345679',
      fullName: 'Cán bộ Xã Tà Lài',
      role: 'ward_officer',
      assignedArea: { district: 'Huyện Tân Phú', ward: 'Xã Tà Lài' },
    });
    expect(officerOk.validateSync()).toBeUndefined();
  });

  it('Incident: tự sinh incidentCode, đồng bộ district, chặn tọa độ ngoài Đồng Nai & dHash sai định dạng', () => {
    const valid = new Incident({
      reporterId: new Types.ObjectId(),
      category: 'giao_thong',
      title: 'Ổ gà sâu trên Tỉnh lộ 762',
      description: 'Mặt đường nứt vỡ gây nguy hiểm cho xe máy.',
      location: {
        type: 'Point',
        coordinates: [107.3618, 11.4215],
        addressText: 'Tỉnh lộ 762, Xã Tà Lài, Huyện Tân Phú, Đồng Nai',
        ward: 'Xã Tà Lài',
        district: 'Huyện Tân Phú',
      },
      media: [{ url: 'https://example.com/1.jpg', type: 'image', dHash: '0123456789abcdef', capturedAt: new Date() }],
      aiAnalysis: {
        autoCategory: 'giao_thong',
        detectedObjects: ['pothole'],
        severityLevel: 4,
        summary: 'Ổ gà lớn.',
        isValidImage: true,
      },
    });
    expect(valid.validateSync()).toBeUndefined();
    expect(valid.incidentCode).toMatch(/^DN-\d{4}-[A-Z0-9]{5}$/);
    expect(valid.district).toBe('Huyện Tân Phú');
    expect(valid.priorityScore).toBe(computePriorityScore({ severityLevel: 4, duplicateCount: 0, reporterTrustScore: 100 }));

    const outOfBounds = new Incident({
      reporterId: new Types.ObjectId(),
      category: 'moi_truong',
      title: 'Tọa độ sai ngoài Đồng Nai',
      description: 'Thử gửi tọa độ tại TP.HCM.',
      location: {
        type: 'Point',
        coordinates: [106.6297, 10.8231],
        addressText: 'TP. Hồ Chí Minh',
        ward: 'Bến Nghé',
        district: 'Quận 1',
      },
      media: [{ url: 'https://example.com/2.jpg', type: 'image', dHash: 'invalid-hash', capturedAt: new Date() }],
    });
    const err = outOfBounds.validateSync();
    expect(err?.errors['location.coordinates']).toBeDefined();
    expect(err?.errors['media.0.dHash']).toBeDefined();
  });

  it('SpamLog: yêu cầu tối thiểu 1 định danh (phoneNumber/ipHash/deviceFingerprint)', () => {
    const empty = new SpamLog({ reason: 'duplicate_dhash' });
    expect(empty.validateSync()?.errors.phoneNumber).toBeDefined();

    const valid = new SpamLog({ phoneNumber: '0912345003', reason: 'gps_out_of_dong_nai' });
    expect(valid.validateSync()).toBeUndefined();
  });
});

describe('Helper findDuplicateIncident ($nearSphere + 64-bit dHash)', () => {
  it('ưu tiên khớp dHash (Hamming <= 8) trong bán kính quét, fallback sang cùng category trong 50m', () => {
    const masterA = {
      _id: new Types.ObjectId(),
      incidentCode: 'DN-2026-AAAAA',
      category: 'moi_truong' as const,
      status: 'received',
      location: { coordinates: [106.8243, 10.9465] as [number, number] },
      media: [{ dHash: 'aaaaaaaaaaaaaaaa' }],
      duplicateControl: { isDuplicate: false, duplicateCount: 0 },
    };
    const masterB = {
      _id: new Types.ObjectId(),
      incidentCode: 'DN-2026-BBBBB',
      category: 'giao_thong' as const,
      status: 'in_progress',
      location: { coordinates: [106.8244, 10.9465] as [number, number] },
      media: [{ dHash: '5555555555555555' }],
      duplicateControl: { isDuplicate: false, duplicateCount: 1 },
    };

    // dHash cách 2 bit (<= 8) khớp masterA ngay cả khi category khác
    const byHash = selectBestDuplicateCandidate([masterB, masterA], [106.82435, 10.9465], 'giao_thong', 'aaaaaaaaaaaaaaa3', 8);
    expect(byHash?.reason).toBe('dhash_and_geo');
    expect(byHash?.masterIncident.incidentCode).toBe('DN-2026-AAAAA');
    expect(byHash?.minHammingDistance).toBe(2);

    // Ảnh góc khác hoàn toàn (Hamming lớn), nhưng cùng category giao_thong trong 50m → khớp masterB
    const byCat = selectBestDuplicateCandidate([masterA, masterB], [106.82442, 10.94652], 'giao_thong', '0f0f0f0f0f0f0f0f', 8);
    expect(byCat?.reason).toBe('same_category_geo');
    expect(byCat?.masterIncident.incidentCode).toBe('DN-2026-BBBBB');
    expect(byCat?.distanceMeters).toBeLessThan(50);
  });

  it('gửi đúng truy vấn $nearSphere tới MongoDB và cập nhật duplicateCount/priorityScore khi gộp', async () => {
    const mockMaster = {
      _id: new Types.ObjectId(),
      incidentCode: 'DN-2026-TB001',
      category: 'ha_tang_do_thi' as const,
      status: 'in_progress' as const,
      location: { coordinates: [106.8243, 10.9465] as [number, number] },
      media: [{ url: 'https://example.com/a.jpg', type: 'image' as const, dHash: 'a4c8e2f091b3d577', capturedAt: new Date() }],
      aiAnalysis: { severityLevel: 5 },
      priorityScore: 70,
      duplicateControl: { isDuplicate: false, masterIncidentId: null, duplicateCount: 1 },
      timeline: [],
      save: vi.fn().mockResolvedValue(undefined),
    };

    const exec = vi.fn().mockResolvedValue([mockMaster]);
    const limit = vi.fn().mockReturnValue({ exec });
    const findSpy = vi.spyOn(Incident, 'find').mockReturnValue({ limit } as never);

    try {
      const found = await findDuplicateIncident([106.82435, 10.94652], 'ha_tang_do_thi', 'a4c8e2f091b3d576', {
        radiusMeters: 50,
      });
      expect(found?.masterIncident.incidentCode).toBe('DN-2026-TB001');
      expect(found?.reason).toBe('dhash_and_geo');
      expect(found?.minHammingDistance).toBe(1);

      const passedFilter = findSpy.mock.calls[0][0] as Record<string, any>;
      expect(passedFilter.location.$nearSphere.$geometry).toEqual({ type: 'Point', coordinates: [106.82435, 10.94652] });
      expect(passedFilter.location.$nearSphere.$maxDistance).toBe(50);
      expect(passedFilter['duplicateControl.isDuplicate']).toBe(false);

      const merged = await detectAndMergeDuplicateIncident({
        coordinates: [106.82435, 10.94652],
        category: 'ha_tang_do_thi',
        media: [{ url: 'https://example.com/angle2.jpg', type: 'image', dHash: '0011223344556677', capturedAt: new Date() }],
        reporterTrustScore: 100,
      });
      expect(merged.duplicateControl.isDuplicate).toBe(true);
      expect(merged.duplicateControl.masterIncidentId).toEqual(mockMaster._id);
      expect(mockMaster.duplicateControl.duplicateCount).toBe(2);
      expect(mockMaster.priorityScore).toBe(82); // 5*10 + 2*6 + 20 = 82
      expect(mockMaster.media).toHaveLength(2);
      expect(mockMaster.save).toHaveBeenCalledTimes(1);
    } finally {
      findSpy.mockRestore();
    }

    await expect(findDuplicateIncident([105.85, 21.02], 'giao_thong', '0123456789abcdef')).rejects.toThrow(
      'ngoài khung bao',
    );
  });
});

describe('Kết nối MongoDB Atlas & Bộ dữ liệu Seed Đồng Nai', () => {
  it('cấu hình pool chuẩn Production (maxPoolSize=20, minPoolSize=5, w=majority) và fail-loud khi thiếu MONGODB_URI', async () => {
    const opts = buildMongoConnectOptions();
    expect(opts.maxPoolSize).toBe(20);
    expect(opts.minPoolSize).toBe(5);
    expect(opts.serverSelectionTimeoutMS).toBe(5_000);
    expect(opts.socketTimeoutMS).toBe(45_000);
    expect(opts.retryWrites).toBe(true);
    expect(opts.w).toBe('majority');
    expect(opts.autoIndex).toBe(false);
    await expect(connectMongoDB({ uri: '' })).rejects.toThrow('MONGODB_URI');
  });

  it('seedDongNai có đúng 1 Admin, 2 Cán bộ (Biên Hòa & Tà Lài - Tân Phú), 3 Dân, 8 Phản ánh và 100% pass validation', () => {
    const seed = buildDongNaiSeedDataset();
    expect(seed.users).toHaveLength(6);
    expect(seed.users.filter((u) => u.role === 'admin')).toHaveLength(1);
    expect(seed.users.filter((u) => u.role === 'ward_officer')).toHaveLength(2);
    expect(seed.users.filter((u) => u.role === 'citizen')).toHaveLength(3);
    expect(seed.users.some((u) => u.assignedArea?.ward === 'Phường Trấn Biên')).toBe(true);
    expect(seed.users.some((u) => u.assignedArea?.ward === 'Xã Tà Lài' && u.assignedArea?.district === 'Huyện Tân Phú')).toBe(true);

    expect(INCIDENT_CATEGORIES).toContain('OTHER');
    expect(seed.incidents).toHaveLength(8);
    expect(new Set(seed.incidents.map((i) => i.category)).size).toBe(LEGACY_INCIDENT_CATEGORIES.length);
    expect(new Set(seed.incidents.map((i) => i.status)).size).toBe(5);
    expect(INCIDENT_STATUSES.length).toBeGreaterThanOrEqual(5);
    expect(seed.spamLogs).toHaveLength(2);

    // Toàn bộ 6 users + 8 incidents + 2 spam_logs phải vượt qua Mongoose schema validation chặt chẽ
    for (const u of seed.users) expect(new User(u).validateSync(), `User ${u.phoneNumber}`).toBeUndefined();
    for (const inc of seed.incidents) {
      expect(new Incident(inc).validateSync(), `Incident ${inc.incidentCode}`).toBeUndefined();
      expect(isWithinDongNaiBounds(inc.location.coordinates[0], inc.location.coordinates[1])).toBe(true);
    }
    for (const log of seed.spamLogs) expect(new SpamLog(log).validateSync()).toBeUndefined();
  });
});
