import { createApp } from './app';
import { env } from './config/env';
import { seedIfEmpty } from './data/seedStore';
import { createNonBlockingServerRepositories } from './repositories';
import { createServices } from './services/container';

async function main(): Promise<void> {
  // 1. Khởi tạo Resilient Dual-Layer Repositories (SQLite WAL cục bộ + tự động đồng bộ 2 chiều MongoDB Atlas)
  const bootCtrl = createNonBlockingServerRepositories();
  const { boot, localRepos } = bootCtrl;
  const services = createServices(boot.repos);

  // 2. Đảm bảo danh mục 95 Phường/Xã + 1 tài khoản ADMIN khởi tạo trên bộ đệm cục bộ TRƯỚC khi mở cổng HTTP (<5ms)
  const localSeeded = await seedIfEmpty(localRepos, services.audit);

  // 3. Bind cổng HTTP ngay lập tức để phục vụ SPA tĩnh và Liveness Probe `/healthz`
  const app = createApp(services, boot);
  const server = app.listen(env.port, () => {
    const otp = services.otpDelivery.status;
    const sms = services.phoneOtp.smsDispatcher.getStatus();
    console.log(
      `[server] SmartCitizen_DongNai (Team Victer) đã mở cổng lắng nghe ${env.port} (localPersistence=${localRepos.engine}, localSeed=${localSeeded.users} users/${localSeeded.reports} reports)`,
    );
    console.log(`[server] Trạng thái DB khởi điểm: mode=${boot.repos.mode}, state=${boot.dbState ?? 'connecting'}`);
    console.log(
      `[server] OTP: Email=${otp.activeEmailProvider ?? 'CHƯA CẤU HÌNH'} | SMS=${sms.realSmsConfigured ? sms.activeSmsProvider : 'CHƯA CẤU HÌNH'}`,
    );
    if (env.jwtSecretEphemeral) {
      console.warn('[server] JWT_SECRET chưa đặt — dùng khóa tạm thời cho phiên dev.');
    }
  });
  // Giữ kết nối HTTP Keep-Alive lâu hơn timeout mặc định proxy (60s) để tránh lỗi 502 và giảm chi phí TLS handshake
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  // 4. Khởi chạy song song KeyPool, CV Engine và Kết nối + Đồng bộ 2 chiều MongoDB Atlas ở hậu cảnh
  void Promise.allSettled([
    services.keyPool.init().then(() => {
      const pool = services.keyPool.getSummarySync();
      console.log(
        `[server] AI: ${
          services.gemini.status.configured
            ? `Multi-Key Pool (${pool.healthyKeys}/${pool.totalKeys} key HEALTHY), model ${env.geminiModel}`
            : 'Chế độ Local-First AI (Sharp/Rust CV + Local Knowledge/Intent Engine)'
        }`,
      );
    }),
    services.cvEngine.ensureEngineRunning(),
    bootCtrl.startBackgroundConnect(async (readyMongoRepos) => {
      const seeded = await seedIfEmpty(readyMongoRepos, services.audit);
      console.log(
        `[server] DB Cloud sẵn sàng: mode=${readyMongoRepos.mode}; seed bổ sung: ${seeded.reports} hồ sơ, ${seeded.users} tài khoản`,
      );
    }),
  ]);
  services.aggregator.startScheduler();

  const shutdown = (signal: string): void => {
    console.log(`[server] nhận ${signal}, đang tắt an toàn...`);
    services.aggregator.stopScheduler();
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
