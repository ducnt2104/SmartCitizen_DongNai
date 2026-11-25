import { HttpError } from '../../utils/errors';

export const SMS_PROVIDER_MODES = [
  'auto',
  'firebase',
  'android_gateway',
  'esms',
  'speedsms',
  'twilio',
  'demo',
] as const;

export type SmsProviderMode = (typeof SMS_PROVIDER_MODES)[number];
export type ConcreteSmsProviderName = Exclude<SmsProviderMode, 'auto'>;

export interface SmsOtpSendInput {
  /** SĐT chuẩn E.164: `+84912345678` */
  phoneE164: string;
  /** SĐT nội địa 10 số: `0912345678` */
  phoneLocal: string;
  /** Mã OTP 6 chữ số */
  otp: string;
  /** Thời hạn hiệu lực (phút, mặc định 5) */
  ttlMinutes: number;
  purpose: 'login' | 'reset_password' | 'verify_phone';
}

export interface SmsOtpSendResult {
  provider: ConcreteSmsProviderName;
  delivered: boolean;
  /** Cờ báo cho Frontend kích hoạt luồng `signInWithPhoneNumber` của Firebase Auth */
  clientSideFirebase?: boolean;
  messageId?: string;
  /** Kênh dự phòng thực tế được kích hoạt khi chưa cấu hình cổng SMS nhà mạng */
  fallbackChannel?: 'telegram' | 'email';
  /** CHỈ xuất hiện khi đang ở chế độ thử nghiệm VÀ `ALLOW_DEMO_OTP=true` */
  devOtpPreview?: string;
}

export interface RuntimeFirebaseClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId?: string;
}

export interface SmsOtpProvider {
  readonly name: ConcreteSmsProviderName;
  isConfigured(envSource?: NodeJS.ProcessEnv): boolean;
  send(input: SmsOtpSendInput, envSource?: NodeJS.ProcessEnv): Promise<SmsOtpSendResult>;
}

export type FetchLike = typeof fetch;

const SMS_HTTP_TIMEOUT_MS = 8_000;

function readEnv(envSource: NodeJS.ProcessEnv, key: string): string {
  return (envSource[key] ?? '').trim();
}

function isTruthyEnv(envSource: NodeJS.ProcessEnv, key: string): boolean {
  return ['1', 'true', 'yes'].includes(readEnv(envSource, key).toLowerCase());
}

export function hasTelegramOtpFallback(envSource: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(readEnv(envSource, 'TELEGRAM_BOT_TOKEN') && readEnv(envSource, 'TELEGRAM_CHAT_ID'));
}

function buildSmsText(otp: string, ttlMinutes: number): string {
  return `[SmartCitizen Dong Nai] Ma xac thuc OTP cua ban la ${otp}. Hieu luc ${ttlMinutes} phut. Tuyet doi khong chia se ma nay.`;
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs = SMS_HTTP_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    const isAbort =
      err instanceof Error &&
      (err.name === 'AbortError' || err.name === 'TimeoutError' || /abort|timed?\s*out/i.test(err.message));
    if (isAbort) {
      throw new HttpError(
        504,
        `Kết nối tới cổng SMS quá thời gian chờ (${Math.round(timeoutMs / 1000)}s). Vui lòng thử lại.`,
        'sms_provider_timeout',
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpError(502, `Lỗi kết nối mạng tới cổng SMS: ${msg}`, 'sms_network_error');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 1. Strategy `firebase`:
 * Google Firebase Phone Auth gửi SMS thật trực tiếp từ hạ tầng Google tới điện thoại người dân
 * thông qua `RecaptchaVerifier` ẩn + `signInWithPhoneNumber`, sau đó server xác thực `firebaseIdToken`.
 */
export class FirebaseSmsOtpProvider implements SmsOtpProvider {
  readonly name = 'firebase' as const;

  getClientConfig(envSource: NodeJS.ProcessEnv = process.env): RuntimeFirebaseClientConfig | null {
    const apiKey = readEnv(envSource, 'FIREBASE_API_KEY') || readEnv(envSource, 'VITE_FIREBASE_API_KEY');
    const projectId = readEnv(envSource, 'FIREBASE_PROJECT_ID') || readEnv(envSource, 'VITE_FIREBASE_PROJECT_ID');
    if (!apiKey || !projectId) return null;
    const authDomain =
      readEnv(envSource, 'FIREBASE_AUTH_DOMAIN') ||
      readEnv(envSource, 'VITE_FIREBASE_AUTH_DOMAIN') ||
      `${projectId}.firebaseapp.com`;
    const appId = readEnv(envSource, 'FIREBASE_APP_ID') || readEnv(envSource, 'VITE_FIREBASE_APP_ID') || undefined;
    return { apiKey, authDomain, projectId, appId };
  }

  isConfigured(envSource: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(
      readEnv(envSource, 'FIREBASE_PROJECT_ID') ||
        readEnv(envSource, 'VITE_FIREBASE_PROJECT_ID') ||
        readEnv(envSource, 'FIREBASE_SERVICE_ACCOUNT_JSON'),
    );
  }

  async send(_input: SmsOtpSendInput, envSource: NodeJS.ProcessEnv = process.env): Promise<SmsOtpSendResult> {
    if (!this.isConfigured(envSource)) {
      throw new HttpError(
        503,
        'Kênh xác thực Firebase Phone Auth chưa được cấu hình đầy đủ.',
        'sms_provider_not_configured',
      );
    }
    return {
      provider: 'firebase',
      delivered: true,
      clientSideFirebase: true,
    };
  }
}

/**
 * 2. Strategy `android_gateway`:
 * Bắn tin nhắn SMS thật trực tiếp từ SIM vật lý trên máy Android của đội thi (TextBee.dev hoặc SMS Gateway Webhook tùy chỉnh)
 * tới máy Ban Giám Khảo chỉ trong ~2 giây mà không cần chờ duyệt Brandname nhà mạng.
 */
export class AndroidGatewaySmsOtpProvider implements SmsOtpProvider {
  readonly name = 'android_gateway' as const;

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  private resolveEndpoint(envSource: NodeJS.ProcessEnv): { url: string; apiKey: string; isTextBee: boolean } | null {
    const customUrl = readEnv(envSource, 'SMS_GATEWAY_URL');
    const textbeeDeviceId = readEnv(envSource, 'TEXTBEE_DEVICE_ID');
    const textbeeKey = readEnv(envSource, 'TEXTBEE_API_KEY');
    const genericKey = readEnv(envSource, 'SMS_GATEWAY_API_KEY') || textbeeKey;

    if (customUrl) {
      return {
        url: customUrl,
        apiKey: genericKey,
        isTextBee: /textbee\.dev/i.test(customUrl),
      };
    }
    if (textbeeDeviceId && textbeeKey) {
      return {
        url: `https://api.textbee.dev/api/v1/gateway/devices/${encodeURIComponent(textbeeDeviceId)}/send-sms`,
        apiKey: textbeeKey,
        isTextBee: true,
      };
    }
    return null;
  }

  isConfigured(envSource: NodeJS.ProcessEnv = process.env): boolean {
    return this.resolveEndpoint(envSource) !== null;
  }

  async send(input: SmsOtpSendInput, envSource: NodeJS.ProcessEnv = process.env): Promise<SmsOtpSendResult> {
    const cfg = this.resolveEndpoint(envSource);
    if (!cfg) {
      throw new HttpError(
        503,
        'Chưa cấu hình Android SMS Gateway (cần TEXTBEE_DEVICE_ID + TEXTBEE_API_KEY hoặc SMS_GATEWAY_URL).',
        'sms_provider_not_configured',
      );
    }

    const message = buildSmsText(input.otp, input.ttlMinutes);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (cfg.apiKey) {
      headers['x-api-key'] = cfg.apiKey;
      if (!cfg.isTextBee) {
        headers.Authorization = `Bearer ${cfg.apiKey}`;
      }
    }

    const bodyPayload = cfg.isTextBee
      ? {
          recipients: [input.phoneE164],
          message,
        }
      : {
          recipients: [input.phoneE164],
          phone: input.phoneE164,
          phoneLocal: input.phoneLocal,
          message,
          otp: input.otp,
        };

    const res = await fetchWithTimeout(this.fetchImpl, cfg.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyPayload),
    });

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 180);
      throw new HttpError(
        502,
        `Android SMS Gateway gửi tin thất bại (HTTP ${res.status}). ${detail}`.trim(),
        'sms_delivery_failed',
      );
    }

    let messageId: string | undefined;
    const raw = await res.text().catch(() => '');
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { data?: { _id?: string; id?: string }; id?: string; success?: boolean; error?: string };
        if (parsed.success === false) {
          throw new HttpError(502, `Android SMS Gateway từ chối gửi: ${parsed.error ?? 'unknown'}`, 'sms_delivery_failed');
        }
        messageId = parsed.data?._id ?? parsed.data?.id ?? parsed.id;
      } catch (err) {
        if (err instanceof HttpError) throw err;
      }
    }

    return {
      provider: 'android_gateway',
      delivered: true,
      messageId,
    };
  }
}

/**
 * 3A. Strategy `esms` (eSMS.vn REST API V4 — timeout 8 giây).
 */
export class EsmsSmsOtpProvider implements SmsOtpProvider {
  readonly name = 'esms' as const;

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  isConfigured(envSource: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(readEnv(envSource, 'ESMS_API_KEY') && readEnv(envSource, 'ESMS_SECRET_KEY'));
  }

  async send(input: SmsOtpSendInput, envSource: NodeJS.ProcessEnv = process.env): Promise<SmsOtpSendResult> {
    const apiKey = readEnv(envSource, 'ESMS_API_KEY');
    const secretKey = readEnv(envSource, 'ESMS_SECRET_KEY');
    const brandname = readEnv(envSource, 'ESMS_BRANDNAME');
    const sandbox = isTruthyEnv(envSource, 'ESMS_SANDBOX') ? '1' : '0';

    if (!apiKey || !secretKey) {
      throw new HttpError(503, 'Chưa cấu hình ESMS_API_KEY và ESMS_SECRET_KEY.', 'sms_provider_not_configured');
    }

    const res = await fetchWithTimeout(
      this.fetchImpl,
      'https://rest.esms.vn/MainService.svc/json/SendMultipleMessage_V4_post_json/',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ApiKey: apiKey,
          SecretKey: secretKey,
          Phone: input.phoneLocal,
          Content: buildSmsText(input.otp, input.ttlMinutes),
          Brandname: brandname || undefined,
          SmsType: brandname ? '2' : '8',
          Sandbox: sandbox,
        }),
      },
    );

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 160);
      throw new HttpError(502, `Gửi SMS OTP qua eSMS.vn thất bại (HTTP ${res.status}). ${detail}`.trim(), 'sms_delivery_failed');
    }

    const data = (await res.json().catch(() => ({}))) as {
      CodeResult?: string | number;
      SMSID?: string;
      ErrorMessage?: string;
    };
    const codeResult = data.CodeResult !== undefined ? String(data.CodeResult) : '100';
    if (codeResult !== '100') {
      throw new HttpError(
        502,
        `eSMS.vn từ chối gửi tin (mã ${codeResult}): ${data.ErrorMessage ?? 'Không rõ nguyên nhân'}`,
        'sms_delivery_failed',
      );
    }

    return {
      provider: 'esms',
      delivered: true,
      messageId: data.SMSID,
    };
  }
}

/**
 * 3B. Strategy `speedsms` (SpeedSMS.vn REST API — timeout 8 giây).
 */
export class SpeedSmsOtpProvider implements SmsOtpProvider {
  readonly name = 'speedsms' as const;

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  isConfigured(envSource: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(readEnv(envSource, 'SPEEDSMS_ACCESS_TOKEN'));
  }

  async send(input: SmsOtpSendInput, envSource: NodeJS.ProcessEnv = process.env): Promise<SmsOtpSendResult> {
    const accessToken = readEnv(envSource, 'SPEEDSMS_ACCESS_TOKEN');
    const sender = readEnv(envSource, 'SPEEDSMS_SENDER');
    const smsType = Number(readEnv(envSource, 'SPEEDSMS_TYPE') || '2') || 2;

    if (!accessToken) {
      throw new HttpError(503, 'Chưa cấu hình SPEEDSMS_ACCESS_TOKEN.', 'sms_provider_not_configured');
    }

    const basicAuth = Buffer.from(`${accessToken}:x`).toString('base64');
    const res = await fetchWithTimeout(this.fetchImpl, 'https://api.speedsms.vn/index.php/sms/send', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: [input.phoneLocal],
        content: buildSmsText(input.otp, input.ttlMinutes),
        sms_type: smsType,
        ...(sender ? { sender } : {}),
      }),
    });

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 160);
      throw new HttpError(502, `Gửi SMS OTP qua SpeedSMS thất bại (HTTP ${res.status}). ${detail}`.trim(), 'sms_delivery_failed');
    }

    const data = (await res.json().catch(() => ({}))) as {
      status?: string;
      code?: string;
      message?: string;
      data?: { tranId?: number | string };
    };
    if (data.status && data.status !== 'success') {
      throw new HttpError(
        502,
        `SpeedSMS từ chối gửi tin (${data.code ?? data.status}): ${data.message ?? 'Lỗi cổng nhà mạng'}`,
        'sms_delivery_failed',
      );
    }

    return {
      provider: 'speedsms',
      delivered: true,
      messageId: data.data?.tranId !== undefined ? String(data.data.tranId) : undefined,
    };
  }
}

/**
 * 3C. Strategy `twilio` (Twilio Programmable SMS REST API — timeout 8 giây).
 */
export class TwilioSmsOtpProvider implements SmsOtpProvider {
  readonly name = 'twilio' as const;

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  isConfigured(envSource: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(
      readEnv(envSource, 'TWILIO_ACCOUNT_SID') &&
        readEnv(envSource, 'TWILIO_AUTH_TOKEN') &&
        readEnv(envSource, 'TWILIO_FROM_NUMBER'),
    );
  }

  async send(input: SmsOtpSendInput, envSource: NodeJS.ProcessEnv = process.env): Promise<SmsOtpSendResult> {
    const sid = readEnv(envSource, 'TWILIO_ACCOUNT_SID');
    const token = readEnv(envSource, 'TWILIO_AUTH_TOKEN');
    const fromNumber = readEnv(envSource, 'TWILIO_FROM_NUMBER');

    if (!sid || !token || !fromNumber) {
      throw new HttpError(
        503,
        'Chưa cấu hình đầy đủ TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN và TWILIO_FROM_NUMBER.',
        'sms_provider_not_configured',
      );
    }

    const creds = Buffer.from(`${sid}:${token}`).toString('base64');
    const body = new URLSearchParams({
      To: input.phoneE164,
      From: fromNumber,
      Body: buildSmsText(input.otp, input.ttlMinutes),
    });

    const res = await fetchWithTimeout(
      this.fetchImpl,
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${creds}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      },
    );

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 160);
      throw new HttpError(502, `Gửi SMS OTP qua Twilio thất bại (HTTP ${res.status}). ${detail}`.trim(), 'sms_delivery_failed');
    }

    const data = (await res.json().catch(() => ({}))) as { sid?: string };
    return {
      provider: 'twilio',
      delivered: true,
      messageId: data.sid,
    };
  }
}

/**
 * 4. Strategy `demo` (Fallback an toàn khi test offline / chưa cấu hình cổng SMS thật):
 * - In rõ mã OTP ra terminal server để kỹ sư / giám khảo quan sát khi chạy offline.
 * - Đồng thời đẩy qua Telegram Bot nếu có `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`.
 * - CHỈ trả `devOtpPreview` trong response khi biến `ALLOW_DEMO_OTP=true`.
 */
export class DemoSmsOtpProvider implements SmsOtpProvider {
  readonly name = 'demo' as const;

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  isConfigured(_envSource: NodeJS.ProcessEnv = process.env): boolean {
    return true;
  }

  async send(input: SmsOtpSendInput, envSource: NodeJS.ProcessEnv = process.env): Promise<SmsOtpSendResult> {
    const allowPreview = isTruthyEnv(envSource, 'ALLOW_DEMO_OTP');
    const telegramToken = readEnv(envSource, 'TELEGRAM_BOT_TOKEN');
    const telegramChatId = readEnv(envSource, 'TELEGRAM_CHAT_ID');

    console.info(
      `[SMS_OTP_DEMO] SĐT=${input.phoneE164} | OTP=${input.otp} | Hiệu lực=${input.ttlMinutes} phút | Mục đích=${input.purpose}`,
    );

    if (telegramToken && telegramChatId) {
      try {
        await fetchWithTimeout(
          this.fetchImpl,
          `https://api.telegram.org/bot${encodeURIComponent(telegramToken)}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: telegramChatId,
              text: `🔐 [SmartCitizen Đồng Nai - SMS OTP]\nSĐT: ${input.phoneE164}\nMã OTP: ${input.otp}\nHiệu lực: ${input.ttlMinutes} phút`,
            }),
          },
          5_000,
        );
      } catch (err) {
        console.warn('[SMS_OTP_DEMO] Không gửi được bản sao OTP qua Telegram Bot:', err instanceof Error ? err.message : err);
      }
    }

    return {
      provider: 'demo',
      delivered: true,
      ...(allowPreview ? { devOtpPreview: input.otp } : {}),
    };
  }
}

/**
 * Bộ điều phối Multi-Provider SMS OTP theo Strategy Pattern.
 */
export class MultiSmsOtpDispatcher {
  private readonly providers: Record<ConcreteSmsProviderName, SmsOtpProvider>;
  private overrideProvider: SmsOtpProvider | null = null;

  constructor(fetchImpl: FetchLike = fetch) {
    this.providers = {
      firebase: new FirebaseSmsOtpProvider(),
      android_gateway: new AndroidGatewaySmsOtpProvider(fetchImpl),
      esms: new EsmsSmsOtpProvider(fetchImpl),
      speedsms: new SpeedSmsOtpProvider(fetchImpl),
      twilio: new TwilioSmsOtpProvider(fetchImpl),
      demo: new DemoSmsOtpProvider(fetchImpl),
    };
  }

  /** Phục vụ mock/override trong kiểm thử tự động (`NODE_ENV=test`). */
  setOverrideProvider(provider: SmsOtpProvider | null): void {
    this.overrideProvider = provider;
  }

  getConfiguredMode(envSource: NodeJS.ProcessEnv = process.env): SmsProviderMode {
    const raw = readEnv(envSource, 'SMS_PROVIDER').toLowerCase();
    if ((SMS_PROVIDER_MODES as readonly string[]).includes(raw) && raw !== '') {
      return raw as SmsProviderMode;
    }
    const legacy = readEnv(envSource, 'OTP_PROVIDER').toLowerCase();
    if (legacy === 'twilio' || legacy === 'esms') {
      return legacy;
    }
    return 'auto';
  }

  resolveActiveProvider(envSource: NodeJS.ProcessEnv = process.env): SmsOtpProvider {
    if (this.overrideProvider) return this.overrideProvider;

    const mode = this.getConfiguredMode(envSource);
    if (mode !== 'auto') {
      return this.providers[mode];
    }

    // Thứ tự ưu tiên khi SMS_PROVIDER=auto: cổng SMS trực tiếp -> Firebase -> Demo an toàn
    const priority: ConcreteSmsProviderName[] = [
      'android_gateway',
      'esms',
      'speedsms',
      'twilio',
      'firebase',
    ];
    for (const name of priority) {
      if (this.providers[name].isConfigured(envSource)) {
        return this.providers[name];
      }
    }
    return this.providers.demo;
  }

  getStatus(envSource: NodeJS.ProcessEnv = process.env): {
    smsProviderMode: SmsProviderMode;
    activeSmsProvider: ConcreteSmsProviderName;
    realSmsConfigured: boolean;
    firebaseClientReady: boolean;
    firebaseClientConfig: RuntimeFirebaseClientConfig | null;
    telegramFallbackReady: boolean;
    allowDemoOtp: boolean;
  } {
    const mode = this.getConfiguredMode(envSource);
    const active = this.resolveActiveProvider(envSource);
    const fbProvider = this.providers.firebase as FirebaseSmsOtpProvider;
    const realSmsConfigured =
      active.name !== 'demo' ? active.isConfigured(envSource) : false;
    return {
      smsProviderMode: mode,
      activeSmsProvider: active.name,
      realSmsConfigured,
      firebaseClientReady: fbProvider.isConfigured(envSource),
      firebaseClientConfig: fbProvider.getClientConfig(envSource),
      telegramFallbackReady: hasTelegramOtpFallback(envSource),
      allowDemoOtp: isTruthyEnv(envSource, 'ALLOW_DEMO_OTP'),
    };
  }

  async sendOtp(input: SmsOtpSendInput, envSource: NodeJS.ProcessEnv = process.env): Promise<SmsOtpSendResult> {
    if (this.overrideProvider) {
      return this.overrideProvider.send(input, envSource);
    }

    const mode = this.getConfiguredMode(envSource);
    const active = this.resolveActiveProvider(envSource);
    const allowDemo = isTruthyEnv(envSource, 'ALLOW_DEMO_OTP');
    const hasTelegram = hasTelegramOtpFallback(envSource);

    if (active.name === 'demo' && mode === 'auto') {
      if (!allowDemo && !hasTelegram) {
        throw new HttpError(
          503,
          'Hệ thống chưa kết nối cổng gửi tin nhắn SMS nhà mạng. Vui lòng chuyển sang nhận mã xác thực qua Email hoặc đăng nhập bằng mật khẩu.',
          'sms_provider_not_configured',
        );
      }
      const demoRes = await this.providers.demo.send(input, envSource);
      return {
        ...demoRes,
        ...(hasTelegram ? { fallbackChannel: 'telegram' as const } : {}),
      };
    }

    try {
      return await active.send(input, envSource);
    } catch (err) {
      if (mode === 'auto' && (allowDemo || hasTelegram)) {
        console.warn(
          `[SMS_DISPATCH] Kênh ${active.name} gặp lỗi (${err instanceof Error ? err.message : err}), tự động chuyển sang kênh dự phòng.`,
        );
        const demoRes = await this.providers.demo.send(input, envSource);
        return {
          ...demoRes,
          ...(hasTelegram ? { fallbackChannel: 'telegram' as const } : {}),
        };
      }
      throw err;
    }
  }
}
