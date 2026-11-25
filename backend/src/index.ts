import { createApp } from './app';
import { env } from './config/env';
import { seedIfEmpty } from './data/seedStore';
import { createNonBlockingServerRepositories } from './repositories';
import { createServices } from './services/container';

async function main(): Promise<void> {
  // 1. Khởi tạo Non-Blocking Repository Proxy để mở cổng HTTP ngay lập tức (tránh crash-loop & port-scan timeout trên Render)
  const bootCtrl = createNonBlockingServerRepositories();
  const { boot } = bootCtrl;
  const services = createServices(boot.repos);

  // 2. Bind cổng HTTP ngay lập tức để phục vụ SPA tĩnh và Liveness Probe `/healthz`
  const app = createApp(services, boot);
  const server = app.listen(env.port, () => {
    const otp = services.otpDelivery.status;
    console.log(`[server] SmartCitizen_DongNai (Team Victer) đã mở cổng lắng nghe ${env.port} (non-blocking startup)`);
    console.log(`[server] Trạng thái DB khởi điểm: mode=${boot.repos.mode}, state=${boot.dbState ?? 'connecting'}`);
    console.log(
      `[server] OTP: Email=${otp.activeEmailProvider ?? 'CHƯA CẤU HÌNH'} | SMS=${otp.activeSmsProvider ?? 'CHƯA CẤU HÌNH'}`,
    );
    if (!otp.emailConfigured && !otp.smsConfigured) {
      console.warn(
        '[server] CẢNH BÁO: Chưa cấu hình nhà cung cấp gửi OTP thật (RESEND_API_KEY, BREVO_API_KEY hoặc OTP_WEBHOOK_URL). Endpoint gửi OTP sẽ trả lỗi 503 hướng dẫn cấu hình.',
      );
    }
    if (env.jwtSecretEphemeral) {
      console.warn('[server] JWT_SECRET chưa đặt — dùng khóa tạm thời cho phiên dev.');
    }
  });

  // 3. Khởi chạy song song KeyPool, Rust CV Engine (nếu có binary) và Kết nối + Seed MongoDB Atlas ở hậu cảnh
  void Promise.allSettled([
    services.keyPool.init().then(() => {
      const pool = services.keyPool.getSummarySync();
      console.log(
        `[server] AI: ${
          services.gemini.status.configured
            ? `Multi-Key Pool (${pool.healthyKeys}/${pool.totalKeys} key HEALTHY), model ${env.geminiModel}`
            : 'Chế độ Local-First AI (Rust CV / Ollama / Local BM25 RAG)'
        }`,
      );
    }),
    services.cvEngine.ensureEngineRunning(),
    bootCtrl.startBackgroundConnect(async (readyRepos) => {
      const seeded = await seedIfEmpty(readyRepos, services.audit);
      console.log(
        `[server] DB sẵn sàng: mode=${readyRepos.mode}${boot.fallbackReason ? ` (${boot.fallbackReason})` : ''}; ` +
          `seed mới: ${seeded.reports} hồ sơ, ${seeded.users} tài khoản`,
      );
    }),
  ]);

  const shutdown = (signal: string): void => {
    console.log(`[server] nhận ${signal}, đang tắt an toàn...`);
    server.close(() => {
      Promise.allSettled([services.cvEngine.stop(), bootCtrl.stop()]).finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[server] khởi động thất bại nghiêm trọng:', err);
  process.exit(1);
});
