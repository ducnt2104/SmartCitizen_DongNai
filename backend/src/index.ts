import { createApp } from './app';
import { env } from './config/env';
import { seedIfEmpty } from './data/seedStore';
import { createRepositories } from './repositories';
import { createServices } from './services/container';

async function main(): Promise<void> {
  const boot = await createRepositories();
  const services = createServices(boot.repos);
  const seeded = await seedIfEmpty(boot.repos, services.audit);
  const app = createApp(services, boot);

  const server = app.listen(env.port, () => {
    const otp = services.otpDelivery.status;
    console.log(`[server] SmartCitizen_DongNai (Team Victer) lắng nghe cổng ${env.port}`);
    console.log(`[server] DB: ${boot.repos.mode}${boot.fallbackReason ? ` (${boot.fallbackReason})` : ''}; seed mới: ${seeded.reports} hồ sơ, ${seeded.users} tài khoản`);
    console.log(`[server] AI: ${services.gemini.status.configured ? `Google AI Studio, model ${env.geminiModel}` : 'GEMINI_API_KEY chưa cấu hình — dùng Chế độ AI Dự phòng Cục bộ'}`);
    console.log(
      `[server] OTP: Email=${otp.activeEmailProvider ?? 'CHƯA CẤU HÌNH'} | SMS=${otp.activeSmsProvider ?? 'CHƯA CẤU HÌNH'}`,
    );
    if (!otp.emailConfigured && !otp.smsConfigured) {
      console.warn('[server] CẢNH BÁO: Chưa cấu hình nhà cung cấp gửi OTP thật (RESEND_API_KEY hoặc SMTP_*). Endpoint gửi OTP sẽ trả lỗi 503 hướng dẫn cấu hình.');
    }
    if (env.jwtSecretEphemeral) console.warn('[server] JWT_SECRET chưa đặt — dùng khóa tạm thời cho phiên dev.');
  });

  const shutdown = (signal: string): void => {
    console.log(`[server] nhận ${signal}, đang tắt...`);
    server.close(() => {
      boot.repos.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[server] khởi động thất bại:', err);
  process.exit(1);
});
