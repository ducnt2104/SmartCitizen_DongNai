import { env } from '../config/env';
import type { Repositories } from '../repositories/types';
import { AuditService } from './audit.service';
import { AuthService } from './auth.service';
import { ChatService } from './chat.service';
import { CvEngineService } from './cvEngine.service';
import { GeminiService } from './gemini.service';
import { GeoService } from './geo.service';
import { KeyPoolManager } from './keyPool';
import { LocalRagService } from './localRag.service';
import { OtpDeliveryService } from './otpDelivery.service';
import { FirebasePhoneVerifier, PhoneOtpService } from './otp';
import { ReportService } from './report.service';
import { StaffService } from './staff.service';
import { TrustService } from './trust.service';

export interface Services {
  repos: Repositories;
  audit: AuditService;
  trust: TrustService;
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
  staff: StaffService;
  chat: ChatService;
}

export function createServices(repos: Repositories): Services {
  const audit = new AuditService(repos.audit);
  const trust = new TrustService(repos.users);
  const keyPool = new KeyPoolManager({
    dataDir: process.env.DATA_DIR ? process.env.DATA_DIR : env.dataDir,
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
  return {
    repos,
    audit,
    trust,
    otpDelivery,
    phoneOtp,
    firebaseVerifier,
    geo,
    keyPool,
    cvEngine,
    rag,
    gemini,
    auth: new AuthService(repos.users, repos.otps, repos.sessions, otpDelivery, trust, audit, phoneOtp),
    reports: new ReportService(repos, gemini, trust, audit, cvEngine),
    staff: new StaffService(repos, gemini, trust, audit),
    chat: new ChatService(repos, rag),
  };
}
