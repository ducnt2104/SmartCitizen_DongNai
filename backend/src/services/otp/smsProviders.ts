import { HttpError } from '../../utils/errors';

export const SMS_PROVIDER_MODES = [
  'auto',
  'firebase',
  'speedsms',
  'esms',
  'twilio',
  'vonage',
  'android_gateway',
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
 * Google Firebase Phone Auth gửi SMS trực tiếp từ hạ tầng Google tới điện thoại người dân
 * thông qua `RecaptchaVerifier` ẩn + `signInWithPhoneNumber`, sau đó server xác thực `idToken` qua Firebase Admin SDK.
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

  isAutoFlowReady(envSource: NodeJS.ProcessEnv = process.env): boolean {
    return this.getClientConfig(envSource) !== null;
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
        'Kênh xác thực Firebase Phone Auth chưa được cấu hình đầy đủ (cần FIREBASE_PROJECT_ID và FIREBASE_API_KEY).',
        'SMS_PROVIDER_NOT_CONFIGURED',
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
 * 2A. Strategy `speedsms` (SpeedSMS.vn REST API — timeout 8 giây).
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
      throw new HttpError(503, 'Chưa cấu hình SPEEDSMS_ACCESS_TOKEN.', 'SMS_PROVIDER_NOT_CONFIGURED');
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
 * 2B. Strategy `esms` (eSMS.vn REST API V4 — timeout 8 giây).
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
      throw new HttpError(503, 'Chưa cấu hình ESMS_API_KEY và ESMS_SECRET_KEY.', 'SMS_PROVIDER_NOT_CONFIGURED');
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
 * 2C. Strategy `twilio` (Twilio Programmable SMS REST API — timeout 8 giây).
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
        'SMS_PROVIDER_NOT_CONFIGURED',
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
 * 2D. Strategy `vonage` (Vonage / Nexmo REST SMS API — timeout 8 giây).
 */
export class VonageSmsOtpProvider implements SmsOtpProvider {
  readonly name = 'vonage' as const;

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  isConfigured(envSource: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(readEnv(envSource, 'VONAGE_API_KEY') && readEnv(envSource, 'VONAGE_API_SECRET'));
  }

  async send(input: SmsOtpSendInput, envSource: NodeJS.ProcessEnv = process.env): Promise<SmsOtpSendResult> {
    const apiKey = readEnv(envSource, 'VONAGE_API_KEY');
    const apiSecret = readEnv(envSource, 'VONAGE_API_SECRET');
    const from = readEnv(envSource, 'VONAGE_FROM') || 'SmartCitizen';

    if (!apiKey || !apiSecret) {
      throw new HttpError(
        503,
        'Chưa cấu hình VONAGE_API_KEY và VONAGE_API_SECRET.',
        'SMS_PROVIDER_NOT_CONFIGURED',
      );
    }

    const res = await fetchWithTimeout(this.fetchImpl, 'https://rest.nexmo.com/sms/json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        api_secret: apiSecret,
        to: input.phoneE164.replace(/^\+/, ''),
        from,
        text: buildSmsText(input.otp, input.ttlMinutes),
      }),
    });

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 160);
      throw new HttpError(502, `Gửi SMS OTP qua Vonage thất bại (HTTP ${res.status}). ${detail}`.trim(), 'sms_delivery_failed');
    }

    const data = (await res.json().catch(() => ({}))) as {
      messages?: Array<{ status?: string; 'message-id'?: string; 'error-text'?: string }>;
    };
    const msg = data.messages?.[0];
    if (msg && msg.status && msg.status !== '0') {
      throw new HttpError(
        502,
        `Vonage từ chối gửi tin (mã ${msg.status}): ${msg['error-text'] ?? 'Lỗi cổng SMS'}`,
        'sms_delivery_failed',
      );
    }

    return {
      provider: 'vonage',
      delivered: true,
      messageId: msg?.['message-id'],
    };
  }
}

/**
 * 3. Strategy `android_gateway`:
 * Webhook SMS Gateway (TextBee.dev hoặc Android SMS Gateway tự host qua `SMS_GATEWAY_URL`)
 * gửi POST `{ phone, message }` trực tiếp tới thiết bị phát SMS.
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
        'Chưa cấu hình SMS Gateway (cần SMS_GATEWAY_URL hoặc TEXTBEE_DEVICE_ID + TEXTBEE_API_KEY).',
        'SMS_PROVIDER_NOT_CONFIGURED',
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
          phone: input.phoneE164,
          message,
          phoneLocal: input.phoneLocal,
          recipients: [input.phoneE164],
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
        `SMS Gateway gửi tin thất bại (HTTP ${res.status}). ${detail}`.trim(),
        'sms_delivery_failed',
      );
    }

    let messageId: string | undefined;
    const raw = await res.text().catch(() => '');
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { data?: { _id?: string; id?: string }; id?: string; success?: boolean; error?: string };
        if (parsed.success === false) {
          throw new HttpError(502, `SMS Gateway từ chối gửi: ${parsed.error ?? 'unknown'}`, 'sms_delivery_failed');
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

const NOT_CONFIGURED_MESSAGE =
  'Máy chủ chưa cấu hình nhà cung cấp gửi SMS (FIREBASE_PROJECT_ID + FIREBASE_API_KEY, SPEEDSMS_ACCESS_TOKEN, ESMS_API_KEY, TWILIO_ACCOUNT_SID, VONAGE_API_KEY hoặc SMS_GATEWAY_URL). Quản trị viên cần thêm biến môi trường SMS trên Render.';

/**
 * Bộ điều phối Multi-Provider SMS OTP (Zero Mock OTP):
 * Ưu tiên tự động khi `SMS_PROVIDER=auto`:
 *  1) Firebase Phone Auth (khi đủ cả client config + server verifier)
 *  2) SpeedSMS / eSMS (VN) hoặc Twilio / Vonage
 *  3) Webhook SMS Gateway (TextBee / Android SMS Gateway `SMS_GATEWAY_URL`)
 */
export class MultiSmsOtpDispatcher {
  private readonly providers: Record<ConcreteSmsProviderName, SmsOtpProvider>;
  private overrideProvider: SmsOtpProvider | null = null;

  constructor(fetchImpl: FetchLike = fetch) {
    this.providers = {
      firebase: new FirebaseSmsOtpProvider(),
      speedsms: new SpeedSmsOtpProvider(fetchImpl),
      esms: new EsmsSmsOtpProvider(fetchImpl),
      twilio: new TwilioSmsOtpProvider(fetchImpl),
      vonage: new VonageSmsOtpProvider(fetchImpl),
      android_gateway: new AndroidGatewaySmsOtpProvider(fetchImpl),
    };
  }

  /** Cho phép override transport trong kiểm thử tự động (`NODE_ENV=test`). */
  setOverrideProvider(provider: SmsOtpProvider | null): void {
    this.overrideProvider = provider;
  }

  getConfiguredMode(envSource: NodeJS.ProcessEnv = process.env): SmsProviderMode {
    const raw = readEnv(envSource, 'SMS_PROVIDER').toLowerCase();
    if ((SMS_PROVIDER_MODES as readonly string[]).includes(raw) && raw !== '') {
      return raw as SmsProviderMode;
    }
    const legacy = readEnv(envSource, 'OTP_PROVIDER').toLowerCase();
    if (legacy === 'twilio' || legacy === 'esms' || legacy === 'speedsms' || legacy === 'vonage') {
      return legacy;
    }
    return 'auto';
  }

  resolveActiveProvider(envSource: NodeJS.ProcessEnv = process.env): SmsOtpProvider | null {
    if (this.overrideProvider) return this.overrideProvider;

    const mode = this.getConfiguredMode(envSource);
    if (mode !== 'auto') {
      const explicit = this.providers[mode];
      return explicit.isConfigured(envSource) ? explicit : null;
    }

    // 1. Firebase Phone Auth (nếu cấu hình đủ client API key + Project ID)
    const fb = this.providers.firebase as FirebaseSmsOtpProvider;
    if (fb.isAutoFlowReady(envSource)) {
      return fb;
    }

    // 2. SpeedSMS / eSMS (VN) -> Twilio / Vonage
    const directServerProviders: ConcreteSmsProviderName[] = [
      'speedsms',
      'esms',
      'twilio',
      'vonage',
      // 3. Webhook SMS Gateway (TextBee / SMS_GATEWAY_URL)
      'android_gateway',
    ];
    for (const name of directServerProviders) {
      if (this.providers[name].isConfigured(envSource)) {
        return this.providers[name];
      }
    }

    // Nếu chỉ có FIREBASE_PROJECT_ID mà chưa có SMS trực tiếp nào khác
    if (fb.isConfigured(envSource)) {
      return fb;
    }

    return null;
  }

  getStatus(envSource: NodeJS.ProcessEnv = process.env): {
    smsProviderMode: SmsProviderMode;
    activeSmsProvider: ConcreteSmsProviderName | null;
    realSmsConfigured: boolean;
    firebaseClientReady: boolean;
    firebaseClientConfig: RuntimeFirebaseClientConfig | null;
  } {
    const mode = this.getConfiguredMode(envSource);
    const active = this.resolveActiveProvider(envSource);
    const fbProvider = this.providers.firebase as FirebaseSmsOtpProvider;
    const realSmsConfigured = active !== null && active.isConfigured(envSource);
    return {
      smsProviderMode: mode,
      activeSmsProvider: active?.name ?? null,
      realSmsConfigured,
      firebaseClientReady: fbProvider.isConfigured(envSource),
      firebaseClientConfig: fbProvider.getClientConfig(envSource),
    };
  }

  async sendOtp(input: SmsOtpSendInput, envSource: NodeJS.ProcessEnv = process.env): Promise<SmsOtpSendResult> {
    if (this.overrideProvider) {
      return this.overrideProvider.send(input, envSource);
    }

    const active = this.resolveActiveProvider(envSource);
    if (!active) {
      throw new HttpError(503, NOT_CONFIGURED_MESSAGE, 'SMS_PROVIDER_NOT_CONFIGURED');
    }

    return active.send(input, envSource);
  }
}
