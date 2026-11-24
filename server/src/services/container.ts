import type { Repositories } from '../repositories/types';
import { AuditService } from './audit.service';
import { AuthService } from './auth.service';
import { ChatService } from './chat.service';
import { GeminiService } from './gemini.service';
import { ReportService } from './report.service';
import { StaffService } from './staff.service';
import { TrustService } from './trust.service';

export interface Services {
  repos: Repositories;
  audit: AuditService;
  trust: TrustService;
  auth: AuthService;
  gemini: GeminiService;
  reports: ReportService;
  staff: StaffService;
  chat: ChatService;
}

export function createServices(repos: Repositories): Services {
  const audit = new AuditService(repos.audit);
  const trust = new TrustService(repos.users);
  const gemini = new GeminiService();
  return {
    repos,
    audit,
    trust,
    gemini,
    auth: new AuthService(repos.users, repos.otps, trust, audit),
    reports: new ReportService(repos, gemini, trust, audit),
    staff: new StaffService(repos, gemini, trust, audit),
    chat: new ChatService(repos),
  };
}
