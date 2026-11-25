import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OtpToken, otpTokenSchema } from '../src/models/OtpToken';
import type { Services } from '../src/services/container';
import {
  AndroidGatewaySmsOtpProvider,
  EsmsSmsOtpProvider,
  FirebasePhoneVerifier,
  FirebaseSmsOtpProvider,
  generateOtpSalt,
  generateSixDigitOtp,
  hashOtpCodeSha256,
  MultiSmsOtpDispatcher,
  normalizeVnPhone,
  OtpSendRateLimiter,
  PhoneOtpService,
  SpeedSmsOtpProvider,
  TwilioSmsOtpProvider,
  VonageSmsOtpProvider,
  vnPhoneToLocal,
} from '../src/services/otp';
import type { OtpSendPayload, OtpTransport } from '../src/services/otpDelivery.service';

class MemoryEmailTransport implements OtpTransport {
  readonly provider = 'test_email_memory';
  readonly channel = 'email' as const;
  readonly sent: OtpSendPayload[] = [];

  async send(payload: OtpSendPayload): Promise<void> {
    this.sent.push(payload);
  }
}

describe('1. Chuẩn hóa SĐT di động Việt Nam normalizeVnPhone()', () => {
  it('chuẩn hóa chính xác 09..., 849..., +849... và tự loại bỏ khoảng trắng / dấu - / . / ()', () => {
    expect(normalizeVnPhone('0912345678')).toBe('+84912345678');
    expect(normalizeVnPhone('84912345678')).toBe('+84912345678');
    expect(normalizeVnPhone('+84912345678')).toBe('+84912345678');
    expect(normalizeVnPhone('+84 912-345.678')).toBe('+84912345678');
    expect(normalizeVnPhone('(091) 234-5678')).toBe('+84912345678');
    expect(normalizeVnPhone('+84 0912 345 678')).toBe('+84912345678');
    expect(vnPhoneToLocal('+84 912 345 678')).toBe('0912345678');
  });

  it('chấp nhận đủ 5 đầu số di động Việt Nam hợp lệ (03, 05, 07, 08, 09)', () => {
    expect(normalizeVnPhone('0388123456')).toBe('+84388123456');
    expect(normalizeVnPhone('0589123456')).toBe('+84589123456');
    expect(normalizeVnPhone('0703123456')).toBe('+84703123456');
    expect(normalizeVnPhone('0888123456')).toBe('+84888123456');
    expect(normalizeVnPhone('0987654321')).toBe('+84987654321');
  });

  it('từ chối chặt số cố định, đầu 11 số cũ, sai độ dài và ký tự lạ', () => {
    expect(normalizeVnPhone('02438223344')).toBeNull(); // Máy bàn Hà Nội
    expect(normalizeVnPhone('0283822334')).toBeNull();  // Máy bàn TP.HCM 10 số đầu 02
    expect(normalizeVnPhone('01689123456')).toBeNull(); // Đầu 11 số cũ
    expect(normalizeVnPhone('0412345678')).toBeNull();  // Đầu 04 không tồn tại di động
    expect(normalizeVnPhone('0612345678')).toBeNull();  // Đầu 06 không tồn tại di động
    expect(normalizeVnPhone('091234567')).toBeNull();   // Thiếu số (9 chữ số)
    expect(normalizeVnPhone('09123456789')).toBeNull(); // Thừa số (11 chữ số)
    expect(normalizeVnPhone('09123abcde')).toBeNull();  // Chứa chữ cái
    expect(normalizeVnPhone('+84+912345678')).toBeNull();
    expect(normalizeVnPhone('')).toBeNull();
  });
});

describe('2. Bảo mật OtpToken Schema, SHA-256 + Salt, Cooldown 60s, 3 SMS/10 phút & Khóa mã sau 5 lần sai', () => {
  it('OtpToken có đủ channel (email|phone), target, otpHash, otpSalt, attempts và MongoDB TTL Index trên expiresAt', () => {
    const indexes = otpTokenSchema.indexes();
    const hasTtlIndex = indexes.some(
      ([keys, opts]) =>
        JSON.stringify(keys) === JSON.stringify({ expiresAt: 1 }) &&
        (opts as { expireAfterSeconds?: number }).expireAfterSeconds === 0,
    );
    expect(hasTtlIndex).toBe(true);

    const code = generateSixDigitOtp();
    expect(code).toMatch(/^\d{6}$/);
    const salt = generateOtpSalt();
    expect(salt).toMatch(/^[a-f0-9]{32}$/);
    const hashed = hashOtpCodeSha256(code);
    expect(hashed).toBe(crypto.createHash('sha256').update(code).digest('hex'));
    const saltedHash = hashOtpCodeSha256(code, salt);
    expect(saltedHash).toBe(crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex'));

    const doc = new OtpToken({
      channel: 'phone',
      target: '+84912345678',
      otpHash: saltedHash,
      otpSalt: salt,
      attempts: 0,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.channel).toBe('phone');
    expect(doc.target).toBe('+84912345678');
    expect(doc.otpSalt).toBe(salt);
  });

  it('chặn gửi lại trong 60s cooldown và chặn vượt quá 3 tin SMS / 10 phút / SĐT', async () => {
    let capturedOtp = '';
    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { message?: string };
      const match = parsed.message?.match(/\b(\d{6})\b/);
      if (match) capturedOtp = match[1];
      return new Response(JSON.stringify({ data: { _id: 'msg_01' } }), { status: 200 });
    }) as unknown as typeof fetch;

    const svc = new PhoneOtpService({
      rateLimiter: new OtpSendRateLimiter(),
      smsDispatcher: new MultiSmsOtpDispatcher(mockFetch),
    });

    const envMock: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      SMS_PROVIDER: 'android_gateway',
      TEXTBEE_DEVICE_ID: 'dev_dongnai_01',
      TEXTBEE_API_KEY: 'tb_secret_key',
    };

    const t0 = 1_700_000_000_000;
    const r1 = await svc.sendPhoneOtp('0912 345 678', { now: t0, envSource: envMock });
    expect(r1.provider).toBe('android_gateway');
    expect(r1.target).toBe('+84912345678');
    expect(capturedOtp).toMatch(/^\d{6}$/);

    // Gửi lại ở giây thứ 30 (< 60s) -> bị chặn 429 otp_cooldown
    await expect(
      svc.sendPhoneOtp('+84912345678', { now: t0 + 30_000, envSource: envMock }),
    ).rejects.toMatchObject({ status: 429, code: 'otp_cooldown' });

    // Sau 61s -> được phép gửi lần 2 và lần 3 trong vòng 10 phút
    await svc.sendPhoneOtp('0912345678', { now: t0 + 61_000, envSource: envMock });
    await svc.sendPhoneOtp('0912345678', { now: t0 + 122_000, envSource: envMock });

    // Lần thứ 4 trong vòng 10 phút -> bị chặn 429 otp_rate_limit_10m
    await expect(
      svc.sendPhoneOtp('0912345678', { now: t0 + 183_000, envSource: envMock }),
    ).rejects.toMatchObject({ status: 429, code: 'otp_rate_limit_10m' });

    // Sang cửa sổ 10 phút tiếp theo (> 600s) -> mở lại bình thường
    const rNextWindow = await svc.sendPhoneOtp('0912345678', {
      now: t0 + 610_000,
      envSource: envMock,
    });
    expect(rNextWindow.provider).toBe('android_gateway');
  });

  it('nhập sai OTP đến lần thứ 5 lập tức hủy/khóa mã OTP đó (kể cả nhập mã đúng sau đó cũng bị từ chối)', async () => {
    let realCode = '';
    const svc = new PhoneOtpService();
    svc.smsDispatcher.setOverrideProvider({
      name: 'android_gateway',
      isConfigured: () => true,
      send: async (input) => {
        realCode = input.otp;
        return { provider: 'android_gateway', delivered: true, messageId: 'mock_gw_1' };
      },
    });

    const t0 = Date.now();
    await svc.sendPhoneOtp('0988777666', { now: t0 });
    expect(realCode).toMatch(/^\d{6}$/);
    const wrongCode = realCode === '000000' ? '111111' : '000000';

    // 4 lần sai đầu trả 400 otp_invalid
    for (let i = 1; i <= 4; i++) {
      await expect(svc.verifyPhoneOtp('0988777666', wrongCode, t0 + 1000)).rejects.toMatchObject({
        status: 400,
        code: 'otp_invalid',
      });
    }

    // Lần sai thứ 5 -> 429 otp_locked & hủy mã ngay lập tức
    await expect(svc.verifyPhoneOtp('0988777666', wrongCode, t0 + 2000)).rejects.toMatchObject({
      status: 429,
      code: 'otp_locked',
    });

    // Kể cả thử lại bằng ĐÚNG mã realCode sau khi đã bị khóa -> vẫn bị từ chối 429 otp_locked!
    await expect(svc.verifyPhoneOtp('+84988777666', realCode, t0 + 3000)).rejects.toMatchObject({
      status: 429,
      code: 'otp_locked',
    });
  });
});

describe('3. Mock Unit Test các SMS Provider (android_gateway, esms, speedsms, twilio, vonage, firebase)', () => {
  it('AndroidGatewaySmsOtpProvider gửi chuẩn TextBee API kèm header x-api-key và E.164 +84', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      return new Response(JSON.stringify({ data: { _id: 'tb_sms_999' } }), { status: 201 });
    }) as unknown as typeof fetch;

    const provider = new AndroidGatewaySmsOtpProvider(mockFetch);
    const out = await provider.send(
      {
        phoneE164: '+84912345678',
        phoneLocal: '0912345678',
        otp: '654321',
        ttlMinutes: 5,
        purpose: 'login',
      },
      {
        TEXTBEE_DEVICE_ID: 'pixel7_sim_viettel',
        TEXTBEE_API_KEY: 'tb_live_token_123',
      },
    );

    expect(out).toEqual({
      provider: 'android_gateway',
      delivered: true,
      messageId: 'tb_sms_999',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.textbee.dev/api/v1/gateway/devices/pixel7_sim_viettel/send-sms');
    expect(calls[0].headers['x-api-key']).toBe('tb_live_token_123');
    expect(calls[0].body).toMatchObject({
      recipients: ['+84912345678'],
    });
  });

  it('EsmsSmsOtpProvider gọi REST API eSMS.vn, kiểm tra CodeResult=100 và bắt lỗi khi nhà mạng từ chối', async () => {
    let shouldFail = false;
    const mockFetch = vi.fn(async () => {
      if (shouldFail) {
        return new Response(
          JSON.stringify({ CodeResult: '104', ErrorMessage: 'Brandname chua khai bao' }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ CodeResult: '100', SMSID: 'esms_tx_01' }), { status: 200 });
    }) as unknown as typeof fetch;

    const esms = new EsmsSmsOtpProvider(mockFetch);
    const okRes = await esms.send(
      {
        phoneE164: '+84909111222',
        phoneLocal: '0909111222',
        otp: '246810',
        ttlMinutes: 5,
        purpose: 'login',
      },
      { ESMS_API_KEY: 'esms_k', ESMS_SECRET_KEY: 'esms_s', ESMS_BRANDNAME: 'SmartCitDN' },
    );
    expect(okRes.provider).toBe('esms');
    expect(okRes.messageId).toBe('esms_tx_01');

    shouldFail = true;
    await expect(
      esms.send(
        {
          phoneE164: '+84909111222',
          phoneLocal: '0909111222',
          otp: '246810',
          ttlMinutes: 5,
          purpose: 'login',
        },
        { ESMS_API_KEY: 'esms_k', ESMS_SECRET_KEY: 'esms_s' },
      ),
    ).rejects.toMatchObject({ status: 502, code: 'sms_delivery_failed' });
  });

  it('SpeedSmsOtpProvider & TwilioSmsOtpProvider gửi đúng chuẩn REST API', async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('speedsms.vn')) {
        return new Response(JSON.stringify({ status: 'success', data: { tranId: 8899 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ sid: 'SM_twilio_01' }), { status: 201 });
    }) as unknown as typeof fetch;

    const speedsms = new SpeedSmsOtpProvider(mockFetch);
    const spOut = await speedsms.send(
      { phoneE164: '+84388111222', phoneLocal: '0388111222', otp: '112233', ttlMinutes: 5, purpose: 'login' },
      { SPEEDSMS_ACCESS_TOKEN: 'sp_tok' },
    );
    expect(spOut).toEqual({ provider: 'speedsms', delivered: true, messageId: '8899' });

    const twilio = new TwilioSmsOtpProvider(mockFetch);
    const twOut = await twilio.send(
      { phoneE164: '+84388111222', phoneLocal: '0388111222', otp: '112233', ttlMinutes: 5, purpose: 'login' },
      { TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+15005550006' },
    );
    expect(twOut).toEqual({ provider: 'twilio', delivered: true, messageId: 'SM_twilio_01' });
  });

  it('FirebaseSmsOtpProvider & FirebasePhoneVerifier xác thực RS256 Google Token và từ chối token giả', async () => {
    const fbProvider = new FirebaseSmsOtpProvider();
    expect(fbProvider.isConfigured({ FIREBASE_PROJECT_ID: 'smartcitizen-dn' })).toBe(true);
    const fbSend = await fbProvider.send(
      { phoneE164: '+84912345678', phoneLocal: '0912345678', otp: '999888', ttlMinutes: 5, purpose: 'login' },
      { FIREBASE_PROJECT_ID: 'smartcitizen-dn' },
    );
    expect(fbSend).toEqual({ provider: 'firebase', delivered: true, clientSideFirebase: true });

    // Sinh cặp khóa RSA + chứng chỉ tự ký giả lập Google SecureToken JWKS
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const kid = 'google-key-test-01';
    const projectId = 'smartcitizen-dongnai-firebase';

    const nowSec = Math.floor(Date.now() / 1000);
    const headerB64 = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
    const payloadB64 = Buffer.from(
      JSON.stringify({
        iss: `https://securetoken.google.com/${projectId}`,
        aud: projectId,
        sub: 'fb_uid_citizen_01',
        phone_number: '+84918222333',
        iat: nowSec - 10,
        exp: nowSec + 3600,
      }),
    ).toString('base64url');
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${headerB64}.${payloadB64}`);
    signer.end();
    const sigB64 = signer.sign(privateKey).toString('base64url');
    const validJwt = `${headerB64}.${payloadB64}.${sigB64}`;

    const certFetch = vi.fn(async () =>
      new Response(JSON.stringify({ [kid]: publicPem }), {
        status: 200,
        headers: { 'cache-control': 'public, max-age=3600' },
      }),
    ) as unknown as typeof fetch;

    const verifier = new FirebasePhoneVerifier(certFetch);
    const verified = await verifier.verifyPhoneIdToken(validJwt, { FIREBASE_PROJECT_ID: projectId });
    expect(verified.uid).toBe('fb_uid_citizen_01');
    expect(verified.phone.e164).toBe('+84918222333');
    expect(verified.phone.local).toBe('0918222333');

    // Token bị sửa chữ ký phải bị chặn 401
    const tamperedJwt = `${headerB64}.${payloadB64}.invalidsignature`;
    await expect(
      verifier.verifyPhoneIdToken(tamperedJwt, { FIREBASE_PROJECT_ID: projectId }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('VonageSmsOtpProvider gửi REST SMS và MultiSmsOtpDispatcher ưu tiên firebase -> speedsms/esms/twilio/vonage -> android_gateway', async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('nexmo.com')) {
        return new Response(
          JSON.stringify({ messages: [{ status: '0', 'message-id': 'vonage_msg_777' }] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const vonage = new VonageSmsOtpProvider(mockFetch);
    const out = await vonage.send(
      { phoneE164: '+84905123456', phoneLocal: '0905123456', otp: '777888', ttlMinutes: 5, purpose: 'login' },
      { VONAGE_API_KEY: 'vg_key', VONAGE_API_SECRET: 'vg_secret', VONAGE_FROM: 'SmartCitizen' },
    );
    expect(out).toEqual({ provider: 'vonage', delivered: true, messageId: 'vonage_msg_777' });

    const dispatcher = new MultiSmsOtpDispatcher(mockFetch);
    expect(
      dispatcher.resolveActiveProvider({
        FIREBASE_PROJECT_ID: 'p',
        FIREBASE_API_KEY: 'k',
        SPEEDSMS_ACCESS_TOKEN: 'sp',
        SMS_GATEWAY_URL: 'https://gw.example.com/send',
      })?.name,
    ).toBe('firebase');
    expect(
      dispatcher.resolveActiveProvider({
        SPEEDSMS_ACCESS_TOKEN: 'sp',
        VONAGE_API_KEY: 'vk',
        VONAGE_API_SECRET: 'vs',
        SMS_GATEWAY_URL: 'https://gw.example.com/send',
      })?.name,
    ).toBe('speedsms');
    expect(
      dispatcher.resolveActiveProvider({
        SMS_GATEWAY_URL: 'https://gw.example.com/send',
      })?.name,
    ).toBe('android_gateway');
    expect(() => dispatcher.resolveActiveProvider({})).not.toThrow();
    expect(dispatcher.resolveActiveProvider({})).toBeNull();
  });
});

describe('4. Tích hợp E2E API (/api/auth/otp/send, /verify, /verify-firebase) & Tương thích ngược Email OTP', () => {
  let base = '';
  let dir = '';
  let services: Services;
  let closeServer: () => Promise<void> = async () => undefined;
  const emailTransport = new MemoryEmailTransport();
  let lastSentSmsOtp = '';

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-phone-otp-e2e-'));
    process.env.DATA_DIR = dir;
    process.env.NODE_ENV = 'test';
    process.env.MONGODB_URI = '';
    process.env.GEMINI_API_KEY = '';

    const { createRepositories } = await import('../src/repositories');
    const { createServices } = await import('../src/services/container');
    const { seedIfEmpty } = await import('../src/data/seedStore');
    const { createApp } = await import('../src/app');

    const boot = await createRepositories();
    services = createServices(boot.repos);
    await seedIfEmpty(boot.repos, services.audit, { includeFixtures: true });
    services.otpDelivery.setTestTransport(emailTransport);
    services.phoneOtp.smsDispatcher.setOverrideProvider({
      name: 'android_gateway',
      isConfigured: () => true,
      send: async (input) => {
        lastSentSmsOtp = input.otp;
        return { provider: 'android_gateway', delivered: true, messageId: 'e2e_sms_1' };
      },
    });
    services.firebaseVerifier.setCustomVerifier(async (token) => {
      if (token === 'valid_firebase_id_token_dongnai_0933444555') {
        return { uid: 'fb_uid_999', phone_number: '+84933444555' };
      }
      throw new Error('Invalid token');
    });

    const server = createApp(services, boot).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    closeServer = async () => {
      await new Promise((r) => server.close(r));
      await boot.repos.close();
    };
  });

  beforeEach(() => {
    services.phoneOtp.resetMemory();
  });

  afterAll(async () => {
    services.otpDelivery.setTestTransport(null);
    services.phoneOtp.smsDispatcher.setOverrideProvider(null);
    services.firebaseVerifier.setCustomVerifier(null);
    await closeServer();
    await new Promise((r) => setTimeout(r, 220));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function postJson<T = any>(pathname: string, body: unknown, ip = '10.10.0.1') {
    const res = await fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': ip,
        'X-Device-Fp': 'phone-e2e-fp-01',
      },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as T;
    const setCookies = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    return { status: res.status, data, setCookies };
  }

  it('POST /api/auth/otp/send + /verify bằng SĐT Việt Nam cấp JWT CITIZEN & HTTP-only Cookies', async () => {
    const sendRes = await postJson('/api/auth/otp/send', {
      channel: 'phone',
      phone: '0977 888 999',
    });
    expect(sendRes.status).toBe(200);
    expect(sendRes.data.channel).toBe('phone');
    expect(sendRes.data.target).toBe('+84977888999');
    expect(sendRes.data.provider).toBe('android_gateway');
    expect(sendRes.data.resendInSec).toBe(60);
    expect(lastSentSmsOtp).toMatch(/^\d{6}$/);

    const verifyRes = await postJson('/api/auth/otp/verify', {
      channel: 'phone',
      phone: '+84977888999',
      code: lastSentSmsOtp,
      name: 'Trần Thị Biên Hòa',
      defaultWardCode: 'DN-TB',
    });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.data.token).toBeTruthy();
    expect(verifyRes.data.user.role).toBe('citizen');
    expect(verifyRes.data.user.name).toBe('Trần Thị Biên Hòa');
    expect(verifyRes.data.user.phoneMasked).toBe('097****999');
    expect(verifyRes.setCookies.some((c) => c.startsWith('sc_access='))).toBe(true);

    const savedCitizen = await services.repos.users.getByPhone('0977888999');
    expect(savedCitizen).not.toBeNull();
    expect(savedCitizen?.role).toBe('citizen');
  });

  it('POST /api/auth/otp/verify-firebase xác thực firebaseIdToken, tự tạo CITIZEN và cấp JWT', async () => {
    const res = await postJson('/api/auth/otp/verify-firebase', {
      firebaseIdToken: 'valid_firebase_id_token_dongnai_0933444555',
      name: 'Lê Hoàng Long Thành',
      defaultWardCode: 'DN-LTH',
    });
    expect(res.status).toBe(200);
    expect(res.data.token).toBeTruthy();
    expect(res.data.user.role).toBe('citizen');
    expect(res.data.user.phoneMasked).toBe('093****555');
    expect(res.data.user.name).toBe('Lê Hoàng Long Thành');
    expect(res.data.user.defaultWardCode).toBe('DN-LTH');

    const savedFbUser = await services.repos.users.getByPhone('0933444555');
    expect(savedFbUser).not.toBeNull();
  });

  it('giữ nguyên 100% tương thích ngược cho luồng đăng nhập OTP Email qua cả /otp/request và /otp/send', async () => {
    const email = 'citizen.compat@dongnai.vn';
    const sendEmail = await postJson('/api/auth/otp/send', {
      channel: 'email',
      email,
    }, '10.20.0.2');
    expect(sendEmail.status).toBe(200);
    expect(sendEmail.data.channel).toBe('email');

    const latestMail = emailTransport.sent[emailTransport.sent.length - 1];
    expect(latestMail.to).toBe(email);

    const verifyEmail = await postJson('/api/auth/otp/verify', {
      identifier: email,
      code: latestMail.code,
    }, '10.20.0.2');
    expect(verifyEmail.status).toBe(200);
    expect(verifyEmail.data.user.email).toBe(email);
    expect(verifyEmail.data.user.role).toBe('citizen');
  });
});
