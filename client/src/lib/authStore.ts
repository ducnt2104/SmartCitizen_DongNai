import type { AuthSession, UserProfile } from '@shared/types';
import { useSyncExternalStore } from 'react';

const KEY = 'sc.session.v1';

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
    if (raw) session = JSON.parse(raw) as AuthSession;
  } catch (err) {
    console.warn('Phiên đăng nhập lưu cục bộ bị hỏng, bỏ qua:', err);
    try { store.removeItem(KEY); } catch { /* bỏ qua nếu storage khóa ghi */ }
  }
}

const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

export const authStore = {
  get: (): AuthSession | null => session,
  token: (): string | null => session?.token ?? null,
  set(next: AuthSession): void {
    session = next;
    try { storage()?.setItem(KEY, JSON.stringify(next)); } catch (err) { console.warn('Không lưu được phiên:', err); }
    emit();
  },
  updateUser(user: UserProfile): void {
    if (!session) return;
    session = { ...session, user };
    try { storage()?.setItem(KEY, JSON.stringify(session)); } catch (err) { console.warn('Không cập nhật được phiên:', err); }
    emit();
  },
  clear(): void {
    session = null;
    try { storage()?.removeItem(KEY); } catch (err) { console.warn('Không xóa được phiên:', err); }
    emit();
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useSession(): AuthSession | null {
  return useSyncExternalStore(authStore.subscribe, authStore.get, authStore.get);
}
