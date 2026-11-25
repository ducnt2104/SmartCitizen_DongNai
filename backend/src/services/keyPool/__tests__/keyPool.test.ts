import assert from 'node:assert/strict';
import {
  ACTIVE_GEMINI_MODEL_CHAIN,
  buildGeminiModelChain,
  decryptApiKey,
  encryptApiKey,
  executeGeminiWithModelFallback,
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

  // ── 6. Phân loại linh hoạt (GEMINI_API_KEYS: AIzaSy* & AQ.* -> AI Studio; VERTEX_API_KEYS / vertex: -> Vertex), 404 giữ HEALTHY, 503 Backoff + Model Fallback ──
  const aqStudioLogs: { info: string[]; warn: string[]; error: string[] } = {
    info: [],
    warn: [],
    error: [],
  };
  const aqStudioPool = new KeyPoolManager({
    envSource: {
      GEMINI_API_KEYS: 'AQ.Ab8RN6MockAiStudioKey0001,AIzaSyMockBackupKey0002',
      VERTEX_API_KEYS: 'AQ.Ab8RN6VertexEnvKey0004',
      GEMINI_API_KEY_3: 'vertex:AQ.Ab8RN6ExplicitVertex0003',
    },
    persistenceMode: 'memory',
    nowFn: () => fakeNow,
    sleepFn: async () => undefined,
    logger: {
      info: (m) => aqStudioLogs.info.push(m),
      warn: (m) => aqStudioLogs.warn.push(m),
      error: (m) => aqStudioLogs.error.push(m),
    },
  });

  const routedSnap = await aqStudioPool.listMaskedKeys();
  assert.equal(routedSnap.keys[0].geminiEndpoint, 'ai_studio', 'AQ.* trong GEMINI_API_KEYS phải định tuyến AI Studio');
  assert.equal(routedSnap.keys[1].geminiEndpoint, 'ai_studio', 'AIzaSy* phải được phân loại AI Studio');
  assert.equal(routedSnap.keys[2].geminiEndpoint, 'vertex', 'Tiền tố vertex: phải định tuyến Vertex AI');
  assert.equal(routedSnap.keys[3].geminiEndpoint, 'vertex', 'VERTEX_API_KEYS phải định tuyến Vertex AI');
  assert.ok(aqStudioLogs.info.some((l) => l.includes('Loaded 4 keys (AI Studio: 2, Vertex: 2)')));

  // 6a. HTTP 404 không được đánh dấu key INVALID; cùng 1 key tự chuyển qua gemini-3.8-flash -> gemini-3.5-flash-lite
  const calledModels: Array<{ url: string; apiKeyHeader: string | null }> = [];
  const mock404Fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body ? (JSON.parse(String(init.body)) as { model?: string }) : {};
    calledModels.push({ url, apiKeyHeader: headers.get('x-goog-api-key') });
    if (body.model === 'gemini-3.8-flash') {
      return new Response(JSON.stringify({ error: { code: 404, message: 'models/gemini-3.8-flash is not found', status: 'NOT_FOUND' } }), { status: 404 });
    }
    return new Response(
      JSON.stringify({
        id: 'int_ok_aq_studio',
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'OK' }] }],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const modelChainResult = await aqStudioPool.executeWithRotation(async (apiKey, meta) => {
    assert.equal(meta.slotNumber, 1, 'Key #1 AQ.* phải được chọn đầu tiên');
    return executeGeminiWithModelFallback({
      apiKey,
      geminiEndpoint: meta.geminiEndpoint,
      keyFormat: meta.keyFormat,
      models: buildGeminiModelChain(),
      contents: 'Ping',
      timeoutMs: 5_000,
      label: 'Test404Fallback',
      fetchImpl: mock404Fetch,
    });
  });

  assert.equal(modelChainResult.modelUsed, 'gemini-3.5-flash-lite');
  assert.equal(modelChainResult.endpointUsed, 'ai_studio');
  assert.equal(calledModels.length, 2, 'Phải thử 2 model trên CÙNG Key #1 qua AI Studio Interactions API');
  assert.equal(calledModels[0].url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(calledModels[0].apiKeyHeader, 'AQ.Ab8RN6MockAiStudioKey0001');
  assert.equal(calledModels[1].url, 'https://generativelanguage.googleapis.com/v1beta/interactions');

  // Nếu cả chuỗi model đều trả 404, key vẫn PHẢI giữ trạng thái HEALTHY (không bị đánh dấu INVALID)
  const all404Pool = new KeyPoolManager({
    envSource: { GEMINI_API_KEYS: 'AIzaSyAll404TestKey000000009999' },
    persistenceMode: 'memory',
    nowFn: () => fakeNow,
    sleepFn: async () => undefined,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  await assert.rejects(
    all404Pool.executeWithRotation(async () => {
      throw makeHttpError(404, '404 models/gemini-3.8-flash is not found for API version v1beta');
    }),
  );
  const all404Snap = await all404Pool.listMaskedKeys();
  assert.equal(all404Snap.keys[0].status, 'HEALTHY', 'HTTP 404 tuyệt đối không được đánh dấu key INVALID');

  // 6b. HTTP 503 Overloaded -> Cooldown 60s + Exponential Backoff + Hạ cấp sang gemini-3.5-flash-lite sau 3 key 503
  const sleepRecorded: number[] = [];
  const overloadedPool = new KeyPoolManager({
    envSource: {
      GEMINI_API_KEYS:
        'AIzaSyOverloadKey_0000000o001,AIzaSyOverloadKey_0000000o002,AIzaSyOverloadKey_0000000o003,AIzaSyHealthyKey_00000000o004',
    },
    persistenceMode: 'memory',
    nowFn: () => fakeNow,
    retry503JitterMaxMs: 0,
    sleepFn: async (ms) => {
      sleepRecorded.push(ms);
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  const modelsSeen: boolean[] = [];
  const after503 = await overloadedPool.executeWithRotation(async (_k, meta) => {
    modelsSeen.push(Boolean(meta.preferFallbackModel));
    if (meta.slotNumber <= 3) throw makeHttpError(503, '503 UNAVAILABLE: Model is overloaded');
    return `OK_${meta.slotNumber}_${meta.fallbackModel}`;
  });
  assert.equal(after503, 'OK_4_gemini-3.5-flash-lite');
  assert.deepEqual(sleepRecorded, [500, 1_000, 1_500], '503 phải chạy Exponential Backoff 500ms -> 1000ms -> 1500ms');
  assert.deepEqual(modelsSeen, [false, false, false, true], 'Sau 3 key liên tiếp 503 phải bật preferFallbackModel=true');
  // Request kế tiếp phải nhớ model chính đang quá tải và bật preferFallbackModel ngay từ lần thử đầu tiên
  let nextReqPreferredFallback = false;
  await overloadedPool.executeWithRotation(async (_k, meta) => {
    nextReqPreferredFallback = Boolean(meta.preferFallbackModel);
    return 'OK';
  });
  assert.equal(nextReqPreferredFallback, true, 'Sau khi hạ cấp thành công phải tạm ưu tiên fallbackModel cho các request kế tiếp');
  const overloadKey1 = (await overloadedPool.listMaskedKeys()).keys[0];
  assert.equal(overloadKey1.status, 'COOLDOWN', 'HTTP 503 phải đưa key vào COOLDOWN tạm thời');
  assert.equal(overloadKey1.cooldownRemainingMs, 60_000, 'HTTP 503 phải có cooldown 60s');

  // 6c. AQ.* hỗ trợ fallback chéo hai chiều: ai_studio (403) <-> vertex (403 SERVICE_DISABLED)
  const aqFallbackUrls: string[] = [];
  const aqRecoveredVertex = await executeGeminiWithModelFallback({
    apiKey: 'AQ.Ab8RN6VertexOnlyKey001',
    geminiEndpoint: 'ai_studio',
    models: ACTIVE_GEMINI_MODEL_CHAIN,
    contents: 'Ping',
    timeoutMs: 5_000,
    label: 'TestAqFallbackToVertex',
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      aqFallbackUrls.push(url);
      if (url.includes('generativelanguage.googleapis.com')) {
        return new Response(JSON.stringify({ error: { code: 403, message: 'Generative Language API disabled', status: 'PERMISSION_DENIED' } }), { status: 403 });
      }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'VERTEX_OK' }] } }] }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.equal(aqRecoveredVertex.endpointUsed, 'vertex');
  assert.equal(aqRecoveredVertex.text, 'VERTEX_OK');
  assert.ok(aqFallbackUrls[0].includes('generativelanguage.googleapis.com'));
  assert.ok(aqFallbackUrls[1].includes('aiplatform.googleapis.com'));

  const aqRecoveredStudioUrls: string[] = [];
  const aqRecoveredStudio = await executeGeminiWithModelFallback({
    apiKey: 'AQ.Ab8RN6StudioOnlyKey002',
    geminiEndpoint: 'vertex',
    models: ACTIVE_GEMINI_MODEL_CHAIN,
    contents: 'Ping',
    timeoutMs: 5_000,
    label: 'TestAqFallbackToStudio',
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      aqRecoveredStudioUrls.push(url);
      if (url.includes('aiplatform.googleapis.com')) {
        return new Response(JSON.stringify({ error: { code: 403, message: 'Agent Platform API has not been used in project', status: 'PERMISSION_DENIED' } }), { status: 403 });
      }
      return new Response(
        JSON.stringify({ id: 'int_ok_fb', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'STUDIO_OK' }] }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch,
  });
  assert.equal(aqRecoveredStudio.endpointUsed, 'ai_studio');
  assert.equal(aqRecoveredStudio.text, 'STUDIO_OK');
  assert.ok(aqRecoveredStudioUrls[0].includes('aiplatform.googleapis.com'));
  assert.ok(aqRecoveredStudioUrls[1].includes('generativelanguage.googleapis.com'));
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
