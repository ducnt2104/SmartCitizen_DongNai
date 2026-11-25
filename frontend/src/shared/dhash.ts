/** Tiện ích dHash 64-bit dạng hex (16 ký tự). Tính hash thực tế nằm ở Web Worker; đây chỉ là so sánh. */

export const HASH_HEX_REGEX = /^[0-9a-f]{16}$/;

export function isValidHash(h: unknown): h is string {
  return typeof h === 'string' && HASH_HEX_REGEX.test(h);
}

const POPCOUNT4 = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/** Khoảng cách Hamming giữa 2 hash hex 64-bit. */
export function hammingDistance(a: string, b: string): number {
  if (!isValidHash(a) || !isValidHash(b)) return 64;
  let d = 0;
  for (let i = 0; i < 16; i++) {
    d += POPCOUNT4[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  }
  return d;
}
