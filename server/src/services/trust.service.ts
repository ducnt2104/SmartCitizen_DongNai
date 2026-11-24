import type { Notification, UserProfile } from '../../../shared/types';
import { maskPhone } from '../../../shared/geo';
import {
  TRUST_SPAM_PENALTY, TRUST_START, TRUST_SUPERVISED_BELOW, TRUST_VERIFIED_BONUS,
} from '../../../shared/constants';
import type { UserRecord, UserRepository } from '../repositories/types';
import { newId } from '../utils/crypto';

export const CIVIC_BADGE = 'Công dân Văn minh Đồng Nai';

export function toProfile(u: UserRecord): UserProfile {
  return {
    id: u.id,
    role: u.role,
    name: u.name,
    phoneMasked: u.phone ? maskPhone(u.phone) : null,
    email: u.email,
    staffCode: u.staffCode,
    wardCode: u.wardCode,
    unitCode: u.unitCode,
    trustScore: u.trustScore,
    badges: u.badges,
    volunteerHours: u.volunteerHours,
    points: u.points,
    supervised: u.trustScore < TRUST_SUPERVISED_BELOW,
    notifications: [...u.notifications].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30),
  };
}

/** Lớp 6 — Điểm tín nhiệm công dân. */
export class TrustService {
  constructor(private readonly users: UserRepository) {}

  newUserDefaults(): Pick<UserRecord, 'trustScore' | 'badges' | 'volunteerHours' | 'points' | 'notifications'> {
    return { trustScore: TRUST_START, badges: [], volunteerHours: 0, points: 0, notifications: [] };
  }

  isSupervised(u: Pick<UserRecord, 'trustScore'>): boolean {
    return u.trustScore < TRUST_SUPERVISED_BELOW;
  }

  async rewardVerified(userId: string): Promise<UserRecord | null> {
    const u = await this.users.get(userId);
    if (!u) return null;
    u.trustScore = Math.min(100, u.trustScore + TRUST_VERIFIED_BONUS);
    if (!u.badges.includes(CIVIC_BADGE)) u.badges.push(CIVIC_BADGE);
    await this.users.save(u);
    return u;
  }

  async penalizeSpam(userId: string): Promise<UserRecord | null> {
    const u = await this.users.get(userId);
    if (!u) return null;
    u.trustScore = Math.max(0, u.trustScore - TRUST_SPAM_PENALTY);
    await this.users.save(u);
    return u;
  }

  async notify(userId: string, text: string, reportCode: string): Promise<void> {
    const u = await this.users.get(userId);
    if (!u) return; // người dùng seed không có tài khoản thật
    const n: Notification = { id: newId('nt'), text, reportCode, at: new Date().toISOString(), read: false };
    u.notifications = [n, ...u.notifications].slice(0, 50);
    await this.users.save(u);
  }
}
