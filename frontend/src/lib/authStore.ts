import { normalizeRole, toRoleCode } from '@shared/constants';
import type { AuthSession, UserProfile } from '@shared/types';
import { useSyncExternalStore } from 'react';

const KEY = 'sc.session.v1';

function normalizeUserProfile(u: UserProfile): UserProfile {
  const role = normalizeRole(u.role);
  return {
    ...u,
    role,
    roleCode: toRoleCode(role),
  };
}

function normalizeSession(raw: AuthSession | null): AuthSession | null {
  if (!raw || !raw.user) return null;
  return {
    ...raw,
    user: normalizeUserProfile(raw.user),
  };
}

function storage(): Storage | null {
  try {
    if (typeof globalThis.localStorage !== 'undefined' && typeof globalThis.localStorage.getItem === 'function') {
      return globalThis.localStorage;
    }
  } catch (err) {
    console.warn('localStorage không khả dụng:', err);
  }
  return null;
}

let session: AuthSession | null = null;
const store = storage();
if (store) {
  try {
    const raw = store.getItem(KEY);
    if (raw) session = normalizeSession(JSON.parse(raw) as AuthSession);
  } catch (err) {
    console.warn('Phiên đăng nhập lưu cục bộ bị hỏng, bỏ qua:', err);
    try { store.removeItem(KEY); } catch { /* bỏ qua nếu storage khóa ghi */ }
  }
}

const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    try {
      session = e.newValue ? normalizeSession(JSON.parse(e.newValue) as AuthSession) : null;
    } catch {
      session = null;
    }
    emit();
  });
}

export const authStore = {
  get: (): AuthSession | null => session,
  token: (): string | null => session?.token ?? null,
  set(next: AuthSession): void {
    const normalized = normalizeSession(next)!;
    session = normalized;
    try { storage()?.setItem(KEY, JSON.stringify(normalized)); } catch (err) { console.warn('Không lưu được phiên:', err); }
    emit();
  },
  updateUser(user: UserProfile): void {
    if (!session) return;
    session = { ...session, user: normalizeUserProfile(user) };
    try { storage()?.setItem(KEY, JSON.stringify(session)); } catch (err) { console.warn('Không cập nhật được phiên:', err); }
    emit();
  },
  clear(): void {
    session = null;
    try { storage()?.removeItem(KEY); } catch (err) { console.warn('Không xóa được phiên:', err); }
    emit();
  },
  /** Đăng xuất khỏi máy chủ (xóa HTTP-only cookies + thu hồi Refresh Token) rồi xóa phiên cục bộ. */
  async signOut(): Promise<void> {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      /* vẫn tiếp tục xóa phiên cục bộ khi ngoại tuyến */
    }
    this.clear();
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useSession(): AuthSession | null {
  return useSyncExternalStore(authStore.subscribe, authStore.get, authStore.get);
}
