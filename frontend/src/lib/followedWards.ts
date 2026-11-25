import { useCallback, useEffect, useState } from 'react';
import { WARD_BY_CODE } from '../data/dongNaiWards';
import { api } from './api';
import { authStore, useSession } from './authStore';

const STORAGE_KEY = 'sc.followed_wards.v1';
const followedBus = new EventTarget();

function readLocalWards(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return Array.from(
      new Set(
        parsed
          .map((x) => String(x).trim().toUpperCase())
          .filter((code) => Boolean(WARD_BY_CODE[code])),
      ),
    ).slice(0, 30);
  } catch {
    return [];
  }
}

function writeLocalWards(codes: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(codes));
  } catch {
    // Bỏ qua nếu trình duyệt chặn storage
  }
  followedBus.dispatchEvent(new CustomEvent('change', { detail: codes }));
}

export function useFollowedWards() {
  const session = useSession();
  const [followedCodes, setFollowedCodes] = useState<string[]>(() => readLocalWards());
  const [syncing, setSyncing] = useState(false);

  // Khi người dùng đăng nhập, hợp nhất danh sách từ server & localStorage
  useEffect(() => {
    const serverCodes = session?.user?.followedWardCodes;
    if (!serverCodes || !Array.isArray(serverCodes)) return;
    const localCodes = readLocalWards();
    const merged = Array.from(
      new Set([...serverCodes, ...localCodes].filter((c) => Boolean(WARD_BY_CODE[c]))),
    ).slice(0, 30);

    if (merged.join(',') !== localCodes.join(',')) {
      writeLocalWards(merged);
      setFollowedCodes(merged);
    }
    if (merged.join(',') !== serverCodes.join(',') && merged.length > serverCodes.length) {
      void api<{ followedWardCodes: string[] }>('/api/me/followed-wards', {
        method: 'PATCH',
        body: { wardCodes: merged },
      })
        .then((res) => {
          const cur = authStore.get();
          if (cur) authStore.updateUser({ ...cur.user, followedWardCodes: res.followedWardCodes });
        })
        .catch(() => undefined);
    }
  }, [session?.user?.id]);

  useEffect(() => {
    const onChange = (ev: Event): void => {
      const next = (ev as CustomEvent<string[]>).detail;
      if (Array.isArray(next)) setFollowedCodes(next);
    };
    followedBus.addEventListener('change', onChange);
    return () => followedBus.removeEventListener('change', onChange);
  }, []);

  const toggleFollowWard = useCallback(
    async (wardCode: string): Promise<boolean> => {
      const clean = wardCode.trim().toUpperCase();
      if (!WARD_BY_CODE[clean]) return false;
      const cur = readLocalWards();
      const exists = cur.includes(clean);
      const next = exists ? cur.filter((c) => c !== clean) : [clean, ...cur].slice(0, 30);
      writeLocalWards(next);
      setFollowedCodes(next);

      if (authStore.token()) {
        setSyncing(true);
        try {
          const res = await api<{ followedWardCodes: string[] }>('/api/me/followed-wards', {
            method: 'PATCH',
            body: { wardCodes: next },
          });
          const s = authStore.get();
          if (s) authStore.updateUser({ ...s.user, followedWardCodes: res.followedWardCodes });
        } catch {
          // Giữ bản localStorage nếu offline
        } finally {
          setSyncing(false);
        }
      }
      return !exists;
    },
    [],
  );

  return {
    followedCodes,
    isFollowing: (wardCode: string) => followedCodes.includes(wardCode.trim().toUpperCase()),
    toggleFollowWard,
    syncing,
  };
}
