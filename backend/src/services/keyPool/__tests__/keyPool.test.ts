import assert from 'node:assert/strict';
import {
  decryptApiKey,
  encryptApiKey,
  KeyPoolManager,
  maskApiKey,
} from '../index';

function makeHttpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export async function runKeyPoolVerificationSuite(): Promise<void> {
  const logs: { info: string[]; warn: string[]; error: string[] } = {
    info: [],
    warn: [],
    error: [],
  };

  let fakeNow = Date.parse('2026-11-25T09:00:00.000+07:00');
  const tenKeys = Array.from(
    { length: 10 },
    (_, idx) => `AIzaSyMockGeminiKeyNumber${String(idx + 1).padStart(2, '0')}_k${String(idx + 1).padStart(3, '0')}`,
  );

  // ── 1. Nạp 10 key giả lập + Giả lập Key 1, 2, 3 liên tiếp chạm 429 -> xoay sang Key 4 thành công ──
  const pool = new KeyPoolManager({
    envSource: {
      GEMINI_API_KEYS: tenKeys.slice(0, 5).join(','),
      GEMINI_API_KEY_6: tenKeys[5],
      GEMINI_API_KEY_7: tenKeys[6],
      GEMINI_API_KEY_8: tenKeys[7],
      GEMINI_API_KEY_9: tenKeys[8],
      GEMINI_API_KEY_10: tenKeys[9],
      KEY_ENCRYPTION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
    persistenceMode: 'memory',
    nowFn: () => fakeNow,
    quotaResetTimeZone: 'Asia/Ho_Chi_Minh',
    logger: {
      info: (m) => logs.info.push(m),
      warn: (m) => logs.warn.push(m),
      error: (m) => logs.error.push(m),
    },
  });

  const initialSummary = pool.getSummarySync();
  assert.equal(initialSummary.totalKeys, 10, 'Phải nạp đúng 10 key từ GEMINI_API_KEYS + GEMINI_API_KEY_6..10');
  assert.equal(initialSummary.healthyKeys, 10, '10 key ban đầu đều phải HEALTHY');

  const attemptedSlotsInFirstCall: number[] = [];
  const wallStart = performance.now();

  const firstResponse = await pool.executeWithRotation(async (apiKey, meta) => {
    attemptedSlotsInFirstCall.push(meta.slotNumber);
    if (meta.slotNumber <= 3) {
      throw makeHttpError(429, '429 Too Many Requests: RESOURCE_EXHAUSTED (RPM rate limit)');
    }
    assert.equal(apiKey, tenKeys[3], 'Lần thử thứ 4 phải nhận đúng raw key của Key #4');
    return `OK_FROM_KEY_${meta.slotNumber}`;
  });

  const elapsedMs = performance.now() - wallStart;
  assert.equal(firstResponse, 'OK_FROM_KEY_4', 'Phải tự động xoay vòng và thành công ở Key #4 trong 1 lần gọi');
  assert.deepEqual(
    attemptedSlotsInFirstCall,
    [1, 2, 3, 4],
    'Thứ tự thử trong request đầu tiên phải là Key 1 -> Key 2 -> Key 3 -> Key 4',
  );
  assert.ok(elapsedMs < 200, `Overhead xoay vòng 3 key lỗi phải < 200ms (thực tế: ${elapsedMs.toFixed(2)}ms)`);

  // Kiểm tra định dạng log xoay vòng chuẩn yêu cầu
  assert.equal(logs.warn.length, 3, 'Phải ghi đúng 3 dòng log cảnh báo xoay vòng cho Key 1..3');
  assert.match(
    logs.warn[0],
    /\[KeyPool\] Key #1 \(\.\.k001\) hit 429 -> Cooldown 60s -> Switched to Key #2 \(\.\.k002\)/,
  );
  assert.match(
    logs.warn[1],
    /\[KeyPool\] Key #2 \(\.\.k002\) hit 429 -> Cooldown 60s -> Switched to Key #3 \(\.\.k003\)/,
  );
  assert.match(
    logs.warn[2],
    /\[KeyPool\] Key #3 \(\.\.k003\) hit 429 -> Cooldown 60s -> Switched to Key #4 \(\.\.k004\)/,
  );

  // Kiểm tra trạng thái Key 1..3 đang COOLDOWN và KHÔNG bị chọn lại khi chưa hết 60s
  const snapAfter429 = await pool.listMaskedKeys();
  for (const slot of [1, 2, 3]) {
    const k = snapAfter429.keys.find((x) => x.slotNumber === slot)!;
    assert.equal(k.status, 'COOLDOWN', `Key #${slot} phải chuyển sang COOLDOWN`);
    assert.equal(k.error429Count, 1);
    assert.equal(k.cooldownRemainingMs, 60_000);
    assert.ok(!JSON.stringify(k).includes(tenKeys[slot - 1]), 'Tuyệt đối không lộ raw API key qua listMaskedKeys()');
  }
  assert.equal(snapAfter429.keys.find((x) => x.slotNumber === 4)!.status, 'HEALTHY');
  assert.equal(snapAfter429.keys.find((x) => x.slotNumber === 4)!.successCount, 1);

  // Thực hiện thêm 14 request liên tiếp trong thời gian Key 1..3 đang Cooldown (t + 30s)
  fakeNow += 30_000;
  const selectedDuringCooldown = new Set<number>();
  for (let i = 0; i < 14; i++) {
    await pool.executeWithRotation(async (_apiKey, meta) => {
      selectedDuringCooldown.add(meta.slotNumber);
      return 'OK';
    });
  }
  assert.ok(!selectedDuringCooldown.has(1), 'Key #1 đang COOLDOWN không được phép bị chọn lại');
  assert.ok(!selectedDuringCooldown.has(2), 'Key #2 đang COOLDOWN không được phép bị chọn lại');
  assert.ok(!selectedDuringCooldown.has(3), 'Key #3 đang COOLDOWN không được phép bị chọn lại');
  assert.deepEqual(
    [...selectedDuringCooldown].sort((a, b) => a - b),
    [4, 5, 6, 7, 8, 9, 10],
    'Weighted Round-Robin / LRU phải phân phối đều qua toàn bộ Key 4..10 đang HEALTHY',
  );

  // Sau khi hết 60s Cooldown (+31s nữa = +61s tổng), Key 1..3 tự động hồi phục về HEALTHY
  fakeNow += 31_000;
  assert.equal(pool.countHealthyKeys(), 10, 'Sau 61s, Key 1..3 phải tự động hồi phục về HEALTHY');

  // ── 2. Kiểm chứng Exponential Backoff (1m -> 3m -> 10m) & Reset về 1m sau khi gọi thành công ──
  let backoffClock = Date.parse('2026-11-25T14:00:00.000+07:00');
  const backoffPool = new KeyPoolManager({
    envSource: {
      GEMINI_API_KEYS: 'AIzaSyBackoffPrimaryKey_b001,AIzaSyBackoffBackupKey_b002',
    },
    persistenceMode: 'memory',
    nowFn: () => backoffClock,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

  // Lần chạm 429 thứ 1 trên Key #1 -> Cooldown 60s (1 phút)
  await backoffPool.executeWithRotation(async (_k, meta) => {
    if (meta.slotNumber === 1) throw makeHttpError(429, '429 strike 1');
    return 'OK';
  });
  let bKey1 = (await backoffPool.listMaskedKeys()).keys.find((x) => x.slotNumber === 1)!;
  assert.equal(bKey1.status, 'COOLDOWN');
  assert.equal(bKey1.cooldownRemainingMs, 60_000, 'Backoff lần 1 phải là 60s (1 phút)');

  // Tiến đồng hồ +61s + đẩy thêm 2 lượt trên Key #2 để LRU quay lại chọn Key #1 -> chạm 429 lần 2 -> 180s (3 phút)
  backoffClock += 61_000;
  for (let i = 0; i < 3; i++) {
    await backoffPool.executeWithRotation(async (_k, meta) => {
      if (meta.slotNumber === 1) throw makeHttpError(429, '429 strike 2');
      return 'OK';
    });
    if ((await backoffPool.listMaskedKeys()).keys.find((x) => x.slotNumber === 1)!.status === 'COOLDOWN') {
      break;
    }
  }
  bKey1 = (await backoffPool.listMaskedKeys()).keys.find((x) => x.slotNumber === 1)!;
  assert.equal(bKey1.status, 'COOLDOWN');
  assert.equal(bKey1.cooldownRemainingMs, 180_000, 'Backoff lần 2 phải là 180s (3 phút)');

  // Tiến đồng hồ +181s -> chạm 429 lần 3 liên tiếp -> 600s (10 phút)
  backoffClock += 181_000;
  for (let i = 0; i < 4; i++) {
    await backoffPool.executeWithRotation(async (_k, meta) => {
      if (meta.slotNumber === 1) throw makeHttpError(429, '429 strike 3');
      return 'OK';
    });
    if ((await backoffPool.listMaskedKeys()).keys.find((x) => x.slotNumber === 1)!.status === 'COOLDOWN') {
      break;
    }
  }
  bKey1 = (await backoffPool.listMaskedKeys()).keys.find((x) => x.slotNumber === 1)!;
  assert.equal(bKey1.status, 'COOLDOWN');
  assert.equal(bKey1.cooldownRemainingMs, 600_000, 'Backoff lần 3 phải là 600s (10 phút)');

  // ── 3. Lỗi hết RPD (Daily Quota) -> EXHAUSTED tới đúng 00:00 Asia/Ho_Chi_Minh ──
  for (let i = 0; i < 10; i++) {
    await pool.executeWithRotation(async (_k, meta) => {
      if (meta.slotNumber === 2) {
        throw makeHttpError(
          429,
          '429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric GenerateRequestsPerDay per day',
        );
      }
      return 'OK';
    });
    if ((await pool.listMaskedKeys()).keys.find((x) => x.slotNumber === 2)!.status === 'EXHAUSTED') {
      break;
    }
  }
  const key2Exhausted = (await pool.listMaskedKeys()).keys.find((x) => x.slotNumber === 2)!;
  assert.equal(key2Exhausted.status, 'EXHAUSTED', 'Lỗi hết quota ngày RPD phải đánh dấu EXHAUSTED');
  assert.equal(
    key2Exhausted.quotaResetAt,
    new Date('2026-11-26T00:00:00.000+07:00').toISOString(),
    'Phải hẹn giờ reset EXHAUSTED đúng 00:00:00 ngày kế tiếp theo múi giờ Asia/Ho_Chi_Minh',
  );

  // ── 4. Lỗi 401/403 -> INVALID + Bắn log cảnh báo ngay ──
  const errCountBefore = logs.error.length;
  for (let i = 0; i < 10; i++) {
    await pool.executeWithRotation(async (_k, meta) => {
      if (meta.slotNumber === 3) {
        throw makeHttpError(403, '403 PERMISSION_DENIED: API key was reported as leaked / revoked');
      }
      return 'OK';
    });
    if ((await pool.listMaskedKeys()).keys.find((x) => x.slotNumber === 3)!.status === 'INVALID') {
      break;
    }
  }
  const key3Invalid = (await pool.listMaskedKeys()).keys.find((x) => x.slotNumber === 3)!;
  assert.equal(key3Invalid.status, 'INVALID', 'Key gặp lỗi 403 phải chuyển sang INVALID');
  assert.ok(logs.error.length > errCountBefore, 'Phải bắn log error cảnh báo ngay khi phát hiện key INVALID');

  // Bước sang 00:00:01 ngày hôm sau: Key #2 (EXHAUSTED) hồi phục HEALTHY, còn Key #3 (INVALID) vẫn giữ INVALID
  fakeNow = Date.parse('2026-11-26T00:00:01.000+07:00');
  const nextDaySnap = await pool.listMaskedKeys();
  assert.equal(nextDaySnap.keys.find((x) => x.slotNumber === 2)!.status, 'HEALTHY');
  assert.equal(nextDaySnap.keys.find((x) => x.slotNumber === 3)!.status, 'INVALID');

  // ── 5. Mã hóa đối xứng AES-256-GCM + Masking bảo mật ──
  const secret = 'super_strong_key_encryption_secret_32_bytes_minimum!';
  const rawSample = 'AIzaSyD9876543210abcdefABCDEF_8xKp';
  const enc = encryptApiKey(rawSample, secret);
  assert.equal(maskApiKey(rawSample), 'AIzaSy...8xKp');
  assert.ok(!enc.encryptedKey.includes(rawSample), 'Bản mã AES-256-GCM không được chứa chuỗi rõ');
  const dec = decryptApiKey(
    { encryptedKey: enc.encryptedKey, keyFingerprint: enc.keyFingerprint },
    secret,
  );
  assert.equal(dec, rawSample, 'Giải mã AES-256-GCM phải khớp tuyệt đối bản gốc');
  assert.throws(
    () =>
      decryptApiKey(
        { encryptedKey: enc.encryptedKey, keyFingerprint: enc.keyFingerprint },
        'wrong_encryption_secret_32_bytes_xxxx',
      ),
    /Giải mã AES-256-GCM thất bại/,
    'Sai KEY_ENCRYPTION_SECRET phải bị GCM AuthTag từ chối ngay',
  );
}

if (require.main === module) {
  runKeyPoolVerificationSuite()
    .then(() => {
      console.log('✅ [KeyPool Verification] Toàn bộ kịch bản xoay vòng 10 key, Cooldown Backoff, RPD Reset & AES-256-GCM đều PASS!');
    })
    .catch((err) => {
      console.error('❌ [KeyPool Verification] Thất bại:', err);
      process.exit(1);
    });
}
