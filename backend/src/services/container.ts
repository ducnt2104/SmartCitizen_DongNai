import path from 'node:path';
import { env } from '../config/env';
import type { Repositories } from '../repositories/types';
import { Stage2PostProcessorService } from './ai';
import { AlertsAndWardsService } from './alertsAndWards.service';
import { AuditService } from './audit.service';
import { AuthService } from './auth.service';
import { CacheService, cacheService } from './cache.service';
import { ChatService } from './chat.service';
import { CvEngineService } from './cvEngine.service';
import { DataAggregatorService } from './dataAggregator.service';
import { GeminiService } from './gemini.service';
import { GeoService } from './geo.service';
import { KeyPoolManager } from './keyPool';
import { LocalRagService } from './localRag.service';
import { MediaService, mediaService } from './media.service';
import { OtpDeliveryService } from './otpDelivery.service';
import { FirebasePhoneVerifier, PhoneOtpService } from './otp';
import { ReportService } from './report.service';
import { SecurityAuditService } from './securityAudit.service';
import { StaffService } from './staff.service';
import { TrustService } from './trust.service';

export interface Services {
  repos: Repositories;
  audit: AuditService;
  securityAudit: SecurityAuditService;
  trust: TrustService;
  cache: CacheService;
  media: MediaService;
  stage2: Stage2PostProcessorService;
  otpDelivery: OtpDeliveryService;
  phoneOtp: PhoneOtpService;
  firebaseVerifier: FirebasePhoneVerifier;
  geo: GeoService;
  keyPool: KeyPoolManager;
  cvEngine: CvEngineService;
  rag: LocalRagService;
  auth: AuthService;
  gemini: GeminiService;
  reports: ReportService;
  alerts: AlertsAndWardsService;
  aggregator: DataAggregatorService;
  staff: StaffService;
  chat: ChatService;
}

export function createServices(repos: Repositories): Services {
  const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : env.dataDir;
  const audit = new AuditService(repos.audit);
  const securityAudit = new SecurityAuditService(dataDir);
  const trust = new TrustService(repos.users);
  const cache = cacheService;
  cache.invalidateReports();
  const stage2 = new Stage2PostProcessorService(trust, repos.evaluations, cache);
  const keyPool = new KeyPoolManager({
    dataDir,
    encryptionSecret: process.env.KEY_ENCRYPTION_SECRET?.trim() || env.jwtSecret,
    quotaResetTimeZone: process.env.KEY_QUOTA_RESET_TZ?.trim() || 'Asia/Ho_Chi_Minh',
    defaultGeminiModel: env.geminiModel,
  });
  const cvEngine = new CvEngineService(repos);
  const rag = new LocalRagService();
  const gemini = new GeminiService(keyPool);
  gemini.attachLocalEngines(cvEngine, rag);
  const otpDelivery = new OtpDeliveryService();
  const phoneOtp = new PhoneOtpService({ otpRepo: repos.otps });
  const firebaseVerifier = new FirebasePhoneVerifier();
  const geo = new GeoService();
  const auth = new AuthService(repos.users, repos.otps, repos.sessions, otpDelivery, trust, audit, phoneOtp);
  const alerts = new AlertsAndWardsService(repos, dataDir);
  const aggregator = new DataAggregatorService(repos, gemini, alerts, dataDir);
  const staff = new StaffService(
    repos,
    gemini,
    trust,
    audit,
    cache,
    mediaService,
    (userId, sessionId) => auth.invalidateSessionCache(userId, sessionId),
  );
  return {
    repos,
    audit,
    securityAudit,
    trust,
    cache,
    media: mediaService,
    stage2,
    otpDelivery,
    phoneOtp,
    firebaseVerifier,
    geo,
    keyPool,
    cvEngine,
    rag,
    gemini,
    auth,
    alerts,
    aggregator,
    reports: new ReportService(repos, gemini, trust, audit, cvEngine, cache, mediaService, stage2, alerts),
    staff,
    chat: new ChatService(repos, rag),
  };
}
