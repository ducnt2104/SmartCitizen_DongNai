import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env';
import { HttpError } from '../utils/errors';

export type OtpChannel = 'email' | 'sms';

export interface OtpSendPayload {
  to: string;
  code: string;
  channel: OtpChannel;
  ttlMinutes: number;
  purpose: 'login' | 'reset_password';
}

export interface OtpTransport {
  readonly provider: string;
  readonly channel: OtpChannel;
  send(payload: OtpSendPayload): Promise<void>;
}

function buildEmailHtml(code: string, ttlMinutes: number, purpose: OtpSendPayload['purpose']): string {
  const title = purpose === 'reset_password' ? 'Khôi phục mật khẩu tài khoản' : 'Mã xác thực đăng nhập';
  return `<!doctype html>
<html lang="vi">
<body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
    <div style="background:#0B57D0;color:#ffffff;padding:20px 24px;">
      <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;opacity:0.9;">Thành phố Đồng Nai · 95 Phường/Xã</div>
      <h1 style="margin:6px 0 0;font-size:20px;font-weight:700;">SmartCitizen Đồng Nai</h1>
    </div>
    <div style="padding:24px;">
      <p style="margin:0 0 12px;font-size:15px;font-weight:600;">${title}</p>
      <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#475569;">
        Sử dụng mã OTP 6 chữ số dưới đây để hoàn tất xác thực trên cổng phản ánh hiện trường SmartCitizen Thành phố Đồng Nai:
      </p>
      <div style="background:#eff6ff;border:2px dashed #0B57D0;border-radius:12px;padding:16px;text-align:center;margin:16px 0;">
        <span style="font-family:'JetBrains Mono',Consolas,monospace;font-size:32px;font-weight:800;letter-spacing:8px;color:#0B57D0;">${code}</span>
      </div>
      <p style="margin:0 0 8px;font-size:13px;color:#475569;">
        • Mã có hiệu lực trong <strong>${ttlMinutes} phút</strong> và chỉ sử dụng <strong>01 lần duy nhất</strong>.<br/>
        • Tuyệt đối <strong>không chia sẻ</strong> mã này với bất kỳ ai, kể cả người tự xưng là cán bộ hỗ trợ.
      </p>
      <p style="margin:16px 0 0;font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:12px;">
        Nếu bạn không yêu cầu mã này, vui lòng bỏ qua email. — Đội ngũ SmartCitizen Thành phố Đồng Nai (Team Victer).
      </p>
    </div>
  </div>
</body>
</html>`;
}

function parseSenderAddress(raw: string, fallbackEmail: string): { name: string; email: string } {
  const m = raw.match(/^(.+?)\s*<([^>]+)>$/);
  if (m) {
    const email = m[2].trim();
    if (email && !email.endsWith('@resend.dev')) {
      return { name: m[1].trim().replace(/^"|"$/g, ''), email };
    }
  }
  const trimmed = raw.trim();
  if (trimmed.includes('@') && !trimmed.includes('<') && !trimmed.endsWith('@resend.dev')) {
    return { name: 'SmartCitizen Đồng Nai', email: trimmed };
  }
  return { name: 'SmartCitizen Đồng Nai', email: fallbackEmail };
}

/** Adapter 1: Gửi Email OTP thật qua Resend REST API (HTTPS Port 443 — không bị chặn trên Render Free Tier). */
class ResendEmailTransport implements OtpTransport {
  readonly provider = 'resend';
  readonly channel: OtpChannel = 'email';

  async send(p: OtpSendPayload): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.otpFromEmail,
        to: [p.to],
        subject: `[SmartCitizen Đồng Nai] Mã xác thực OTP của bạn: ${p.code}`,
        html: buildEmailHtml(p.code, p.ttlMinutes, p.purpose),
        text: `Ma OTP SmartCitizen Thanh pho Dong Nai cua ban la: ${p.code}. Hieu luc ${p.ttlMinutes} phut. Khong chia se ma nay.`,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new HttpError(502, `Gửi email OTP qua Resend thất bại (${res.status}). ${detail.slice(0, 160)}`, 'otp_delivery_failed');
    }
  }
}

/** Adapter 1B: Gửi Email OTP thật qua Brevo REST API v3 (HTTPS Port 443 — gửi được tới mọi Gmail người nhận trên Render Free Tier). */
class BrevoEmailTransport implements OtpTransport {
  readonly provider = 'brevo';
  readonly channel: OtpChannel = 'email';

  async send(p: OtpSendPayload): Promise<void> {
    const sender = parseSenderAddress(env.otpFromEmail, env.smtpUser || 'no-reply@smartcitizen.vn');
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': env.brevoApiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender,
        to: [{ email: p.to }],
        subject: `[SmartCitizen Đồng Nai] Mã xác thực OTP: ${p.code}`,
        htmlContent: buildEmailHtml(p.code, p.ttlMinutes, p.purpose),
        textContent: `Ma OTP SmartCitizen Thanh pho Dong Nai cua ban la: ${p.code}. Hieu luc ${p.ttlMinutes} phut. Khong chia se ma nay.`,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new HttpError(502, `Gửi email OTP qua Brevo API thất bại (${res.status}). ${detail.slice(0, 160)}`, 'otp_delivery_failed');
    }
  }
}

/** Adapter 1C: Gửi Email OTP qua HTTPS Webhook / Google Apps Script Gmail Relay (HTTPS Port 443 — 100% Gmail chính chủ, 0% chặn cổng). */
class WebhookEmailTransport implements OtpTransport {
  readonly provider = 'webhook';
  readonly channel: OtpChannel = 'email';

  async send(p: OtpSendPayload): Promise<void> {
    const res = await fetch(env.otpWebhookUrl, {
      method: 'POST',
      redirect: 'follow',
      headers: {
        'Content-Type': 'application/json',
        ...(env.otpWebhookSecret ? { 'X-Otp-Secret': env.otpWebhookSecret } : {}),
      },
      body: JSON.stringify({
        secret: env.otpWebhookSecret || undefined,
        to: p.to,
        subject: `[SmartCitizen Đồng Nai] Mã xác thực OTP: ${p.code}`,
        code: p.code,
        ttlMinutes: p.ttlMinutes,
        purpose: p.purpose,
        text: `Ma OTP SmartCitizen Thanh pho Dong Nai cua ban la: ${p.code}. Hieu luc ${p.ttlMinutes} phut. Khong chia se ma nay.`,
        html: buildEmailHtml(p.code, p.ttlMinutes, p.purpose),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new HttpError(502, `Gửi email OTP qua HTTPS Webhook thất bại (${res.status}). ${detail.slice(0, 160)}`, 'otp_delivery_failed');
    }
    const rawText = await res.text().catch(() => '');
    if (rawText) {
      try {
        const parsed = JSON.parse(rawText) as { ok?: boolean; error?: string };
        if (parsed.ok === false) {
          throw new HttpError(502, `HTTPS Webhook báo lỗi gửi mail: ${parsed.error ?? 'unknown'}`, 'otp_delivery_failed');
        }
      } catch (e) {
        if (e instanceof HttpError) throw e;
      }
    }
  }
}

/** Adapter 2: Gửi Email OTP thật qua Nodemailer SMTP (Lưu ý: Render Free Tier chặn outbound cổng 25/465/587). */
class SmtpEmailTransport implements OtpTransport {
  readonly provider = 'smtp';
  readonly channel: OtpChannel = 'email';
  private transporter: Transporter | null = null;

  private getTransporter(): Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: env.smtpHost,
        port: env.smtpPort,
        secure: env.smtpSecure,
        auth: { user: env.smtpUser, pass: env.smtpPass },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      });
    }
    return this.transporter;
  }

  async send(p: OtpSendPayload): Promise<void> {
    try {
      const customFrom = env.otpFromEmail && !env.otpFromEmail.includes('@resend.dev') ? env.otpFromEmail : env.smtpUser;
      await this.getTransporter().sendMail({
        from: customFrom,
        to: p.to,
        subject: `[SmartCitizen Đồng Nai] Mã xác thực OTP: ${p.code}`,
        text: `Ma OTP SmartCitizen Thanh pho Dong Nai cua ban la: ${p.code}. Hieu luc ${p.ttlMinutes} phut. Khong chia se ma nay.`,
        html: buildEmailHtml(p.code, p.ttlMinutes, p.purpose),
      });
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const isTimeout = /timeout|ETIMEDOUT|ECONNREFUSED/i.test(rawMsg);
      const hint = isTimeout
        ? `${rawMsg} — Lưu ý: Render Free Tier chặn cổng SMTP 25/465/587; hãy dùng OTP_WEBHOOK_URL, BREVO_API_KEY hoặc RESEND_API_KEY qua cổng HTTPS 443`
        : rawMsg;
      throw new HttpError(502, `Không gửi được email OTP qua SMTP (${hint}).`, 'otp_delivery_failed');
    }
  }
}

/** Adapter 3: Gửi SMS OTP thật qua Twilio REST API. */
class TwilioSmsTransport implements OtpTransport {
  readonly provider = 'twilio';
  readonly channel: OtpChannel = 'sms';

  async send(p: OtpSendPayload): Promise<void> {
    const toE164 = p.to.startsWith('0') ? `+84${p.to.slice(1)}` : p.to;
    const creds = Buffer.from(`${env.twilioAccountSid}:${env.twilioAuthToken}`).toString('base64');
    const body = new URLSearchParams({
      To: toE164,
      From: env.twilioFromNumber,
      Body: `[SmartCitizen Dong Nai] Ma OTP cua ban la ${p.code}. Hieu luc ${p.ttlMinutes} phut. Khong chia se ma nay.`,
    });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.twilioAccountSid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new HttpError(502, `Gửi SMS OTP qua Twilio thất bại (${res.status}). ${detail.slice(0, 160)}`, 'otp_delivery_failed');
    }
  }
}

/** Adapter 4: Gửi SMS OTP thật qua eSMS Việt Nam. */
class EsmsVnTransport implements OtpTransport {
  readonly provider = 'esms';
  readonly channel: OtpChannel = 'sms';

  async send(p: OtpSendPayload): Promise<void> {
    const res = await fetch('https://rest.esms.vn/MainService.svc/json/SendMultipleMessage_V4_post_json/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ApiKey: env.esmsApiKey,
        SecretKey: env.esmsSecretKey,
        Phone: p.to,
        Content: `SmartCitizen Dong Nai: Ma xac thuc OTP cua ban la ${p.code} (hieu luc ${p.ttlMinutes} phut).`,
        Brandname: env.esmsBrandname || undefined,
        SmsType: env.esmsBrandname ? '2' : '8',
      }),
    });
    if (!res.ok) {
      throw new HttpError(502, `Gửi SMS OTP qua eSMS thất bại (${res.status}).`, 'otp_delivery_failed');
    }
    const json = (await res.json()) as { CodeResult?: string; ErrorMessage?: string };
    if (json.CodeResult && json.CodeResult !== '100') {
      throw new HttpError(502, `eSMS từ chối gửi tin: ${json.ErrorMessage ?? json.CodeResult}`, 'otp_delivery_failed');
    }
  }
}

/**
 * Tầng trừu tượng gửi OTP thật (Zero Fake OTP):
 * - KHÔNG bao giờ in/trả mã OTP trong HTTP response hay client UI.
 * - Thiếu cấu hình nhà cung cấp OTP → báo lỗi 503 tường minh hướng dẫn cấu hình `.env`.
 */
export class OtpDeliveryService {
  private testTransport: OtpTransport | null = null;
  private readonly resend = new ResendEmailTransport();
  private readonly brevo = new BrevoEmailTransport();
  private readonly webhook = new WebhookEmailTransport();
  private readonly smtp = new SmtpEmailTransport();
  private readonly twilio = new TwilioSmsTransport();
  private readonly esms = new EsmsVnTransport();

  /** CHỈ dùng trong bộ test tự động (`NODE_ENV=test`) để bắt mã gửi đi trong bộ nhớ mà không lộ qua HTTP. */
  setTestTransport(transport: OtpTransport | null): void {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('TestOtpTransport chỉ được phép sử dụng khi NODE_ENV=test.');
    }
    this.testTransport = transport;
  }

  get status(): {
    emailConfigured: boolean;
    smsConfigured: boolean;
    activeEmailProvider: string | null;
    activeSmsProvider: string | null;
    configuredProviderMode: string;
  } {
    const emailT = this.resolveTransport('email');
    const smsT = this.resolveTransport('sms');
    return {
      emailConfigured: emailT !== null,
      smsConfigured: smsT !== null,
      activeEmailProvider: emailT?.provider ?? null,
      activeSmsProvider: smsT?.provider ?? null,
      configuredProviderMode: env.otpProvider,
    };
  }

  private resolveHttpsEmailFallback(): OtpTransport | null {
    if (env.otpWebhookUrl) return this.webhook;
    if (env.brevoApiKey) return this.brevo;
    if (env.resendApiKey) return this.resend;
    return null;
  }

  private resolveTransport(channel: OtpChannel): OtpTransport | null {
    if (this.testTransport && process.env.NODE_ENV === 'test') {
      return this.testTransport;
    }
    if (channel === 'email') {
      if (env.otpProvider === 'webhook') return env.otpWebhookUrl ? this.webhook : null;
      if (env.otpProvider === 'brevo') return env.brevoApiKey ? this.brevo : null;
      if (env.otpProvider === 'resend') return env.resendApiKey ? this.resend : null;
      if (env.otpProvider === 'smtp') {
        // Nếu người dùng đặt OTP_PROVIDER=smtp trên Render nhưng đồng thời đã thêm HTTPS provider (Webhook/Brevo/Resend),
        // ưu tiên HTTPS hoặc giữ SMTP làm chính và tự fallback khi SMTP bị chặn cổng.
        if (env.smtpHost && env.smtpUser && env.smtpPass) return this.smtp;
        return this.resolveHttpsEmailFallback();
      }
      // Chế độ auto: luôn ưu tiên giao thức HTTPS (Port 443) trước SMTP để chạy mượt trên Render Free Tier
      const httpsTransport = this.resolveHttpsEmailFallback();
      if (httpsTransport) return httpsTransport;
      if (env.smtpHost && env.smtpUser && env.smtpPass) return this.smtp;
      return null;
    }
    if (env.otpProvider === 'twilio') {
      return env.twilioAccountSid && env.twilioAuthToken && env.twilioFromNumber ? this.twilio : null;
    }
    if (env.otpProvider === 'esms') {
      return env.esmsApiKey && env.esmsSecretKey ? this.esms : null;
    }
    if (env.twilioAccountSid && env.twilioAuthToken && env.twilioFromNumber) return this.twilio;
    if (env.esmsApiKey && env.esmsSecretKey) return this.esms;
    return null;
  }

  async sendOtp(payload: OtpSendPayload): Promise<{ provider: string }> {
    const transport = this.resolveTransport(payload.channel);
    if (!transport) {
      const hint =
        payload.channel === 'email'
          ? 'Kênh gửi mã xác thực qua Email hiện đang tạm bảo trì. Vui lòng chuyển sang nhận mã qua Số điện thoại hoặc đăng nhập bằng mật khẩu.'
          : 'Kênh gửi tin nhắn SMS hiện đang tạm bảo trì. Vui lòng chuyển sang nhận mã xác thực qua Email hoặc đăng nhập bằng mật khẩu.';
      throw new HttpError(503, hint, 'otp_provider_not_configured');
    }
    try {
      await transport.send(payload);
      return { provider: transport.provider };
    } catch (err) {
      // Tự động cứu hộ nếu đang để OTP_PROVIDER=smtp bị chặn cổng trên Render nhưng đã điền thêm khóa HTTPS (Webhook/Brevo/Resend)
      if (payload.channel === 'email' && transport.provider === 'smtp') {
        const httpsFallback = this.resolveHttpsEmailFallback();
        if (httpsFallback) {
          console.warn(`[otp] SMTP thất bại, tự động chuyển sang kênh HTTPS (${httpsFallback.provider}):`, err);
          await httpsFallback.send(payload);
          return { provider: httpsFallback.provider };
        }
      }
      throw err;
    }
  }
}
