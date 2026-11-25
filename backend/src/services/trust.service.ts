import type { Notification, UserProfile } from '../shared/types';
import { maskPhone } from '../shared/geo';
import {
  normalizeRole,
  toRoleCode,
  TRUST_AUTO_APPROVE_BONUS,
  TRUST_SPAM_PENALTY,
  TRUST_START,
  TRUST_SUPERVISED_BELOW,
  TRUST_VERIFIED_BONUS,
} from '../shared/constants';
import type { UserRecord, UserRepository } from '../repositories/types';
import { newId } from '../utils/crypto';

export const CIVIC_BADGE = 'Công dân Văn minh Đồng Nai';

export function toProfile(u: UserRecord): UserProfile {
  const revoked = Boolean(u.revoked);
  const role = normalizeRole(u.role);
  return {
    id: u.id,
    role,
    roleCode: toRoleCode(role),
    name: u.name,
    phoneMasked: u.phone ? maskPhone(u.phone) : null,
    email: u.email,
    staffCode: u.staffCode,
    wardCode: u.wardCode,
    unitCode: u.unitCode,
    defaultWardCode: u.defaultWardCode ?? u.wardCode ?? null,
    followedWardCodes: Array.isArray(u.followedWardCodes) ? u.followedWardCodes : [],
    notificationsEnabled: u.notificationsEnabled ?? true,
    revoked,
    isActive: !revoked,
    trustScore: u.trustScore,
    trustLevel: u.trustLevel ?? (u.trustScore < TRUST_SUPERVISED_BELOW ? 'watchlist' : 'normal'),
    violationCount: u.violationCount ?? 0,
    tokenVersion: u.tokenVersion ?? 0,
    activeSessionId: u.activeSessionId ?? null,
    hasPassword: Boolean(u.passwordHash),
    lastLoginAt: u.lastLoginAt ?? null,
    lastLoginIp: u.lastLoginIp ?? null,
    badges: u.badges,
    volunteerHours: u.volunteerHours,
    points: u.points,
    supervised: u.trustScore < TRUST_SUPERVISED_BELOW,
    notifications: [...u.notifications].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30),
    createdAt: u.createdAt,
  };
}

/** Lớp 6 — Điểm tín nhiệm công dân. */
export class TrustService {
  constructor(private readonly users: UserRepository) {}

  newUserDefaults(): Pick<
    UserRecord,
    | 'trustScore'
    | 'badges'
    | 'volunteerHours'
    | 'points'
    | 'notifications'
    | 'defaultWardCode'
    | 'followedWardCodes'
    | 'notificationsEnabled'
    | 'revoked'
    | 'tokenVersion'
    | 'activeSessionId'
    | 'trustLevel'
    | 'violationCount'
  > {
    return {
      trustScore: TRUST_START,
      badges: [],
      volunteerHours: 0,
      points: 0,
      notifications: [],
      defaultWardCode: null,
      followedWardCodes: [],
      notificationsEnabled: true,
      revoked: false,
      tokenVersion: 0,
      activeSessionId: null,
      trustLevel: 'normal',
      violationCount: 0,
    };
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

  async rewardAutoApproved(userId: string, bonus = TRUST_AUTO_APPROVE_BONUS): Promise<UserRecord | null> {
    const u = await this.users.get(userId);
    if (!u) return null;
    u.trustScore = Math.min(100, u.trustScore + Math.max(1, bonus));
    await this.users.save(u);
    return u;
  }

  async penalizeSpam(userId: string, penalty = TRUST_SPAM_PENALTY): Promise<UserRecord | null> {
    const u = await this.users.get(userId);
    if (!u) return null;
    u.trustScore = Math.max(0, u.trustScore - Math.max(1, penalty));
    u.violationCount = (u.violationCount ?? 0) + 1;
    if (u.violationCount >= 3 || u.trustScore < 40) {
      u.trustLevel = 'flagged';
    } else if (u.trustScore < TRUST_SUPERVISED_BELOW) {
      u.trustLevel = 'watchlist';
    }
    await this.users.save(u);
    return u;
  }

  async notify(userId: string, text: string, reportCode: string): Promise<void> {
    const u = await this.users.get(userId);
    if (!u || u.notificationsEnabled === false) return;
    const n: Notification = { id: newId('nt'), text, reportCode, at: new Date().toISOString(), read: false };
    u.notifications = [n, ...u.notifications].slice(0, 50);
    await this.users.save(u);
  }
}
