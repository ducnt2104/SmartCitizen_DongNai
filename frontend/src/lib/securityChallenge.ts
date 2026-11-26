export interface PowChallengePayload {
  challengeId: string;
  nonce: string;
  expiresAt: number;
  difficultyBits: number;
  signature: string;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const SHA256_W = new Uint32Array(64);
const textEncoder = new TextEncoder();

/**
 * Thuật toán SHA-256 thuần JS chạy đồng bộ, tương thích cả HTTP nội bộ (khi `crypto.subtle` không khả dụng)
 * và không tốn chi phí IPC/async mỗi vòng lặp trên điện thoại yếu.
 */
export function sha256Bytes(input: string): Uint8Array {
  const src = textEncoder.encode(input);
  const bitLen = src.length * 8;
  const paddedLen = Math.ceil((src.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(src);
  padded[src.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x1_0000_0000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      SHA256_W[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0w = SHA256_W[i - 15];
      const s1w = SHA256_W[i - 2];
      const s0 = ((s0w >>> 7) | (s0w << 25)) ^ ((s0w >>> 18) | (s0w << 14)) ^ (s0w >>> 3);
      const s1 = ((s1w >>> 17) | (s1w << 15)) ^ ((s1w >>> 19) | (s1w << 13)) ^ (s1w >>> 10);
      SHA256_W[i] = (SHA256_W[i - 16] + s0 + SHA256_W[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + SHA256_W[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return out;
}

export function hasLeadingZeroBits(bytes: Uint8Array, bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  const remBits = bits % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (bytes[i] !== 0) return false;
  }
  if (remBits > 0) {
    const mask = (0xff << (8 - remBits)) & 0xff;
    if ((bytes[fullBytes] & mask) !== 0) return false;
  }
  return true;
}

/** Giải trực tiếp payload PoW (~1–5ms cho 8-bit PoW trên mọi thiết bị). */
export async function solveChallengePayload(challenge: PowChallengePayload): Promise<string> {
  const maxIterations = 1_000_000;
  for (let counter = 0; counter < maxIterations; counter++) {
    const digest = sha256Bytes(`${challenge.nonce}:${counter}`);
    if (hasLeadingZeroBits(digest, challenge.difficultyBits)) {
      return `${challenge.challengeId}.${challenge.nonce}.${challenge.expiresAt}.${challenge.difficultyBits}.${challenge.signature}.${counter}`;
    }
    if (counter > 0 && counter % 2048 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  throw new Error('Không giải được thử thách bảo mật trong giới hạn vòng lặp.');
}

async function fetchPowChallengeOnce(baseUrl: string, headers: Record<string, string>): Promise<PowChallengePayload> {
  const res = await fetch(`${baseUrl}/api/security/challenge`, {
    method: 'GET',
    credentials: 'include',
    headers,
  });
  if (!res.ok) {
    throw new Error(`Không lấy được phiên xác thực (${res.status})`);
  }
  return (await res.json()) as PowChallengePayload;
}

/**
 * Tự động xin thử thách SHA-256 PoW cực nhẹ từ `/api/security/challenge` và giải ngầm (~1–10ms).
 * Tự thử xin lại 1 lần nếu kết nối chập chờn tạm thời trước khi báo lỗi.
 */
export async function solvePowHeader(baseUrl: string, headers: Record<string, string>): Promise<string> {
  let challenge: PowChallengePayload;
  try {
    challenge = await fetchPowChallengeOnce(baseUrl, headers);
  } catch {
    challenge = await fetchPowChallengeOnce(baseUrl, headers);
  }
  return solveChallengePayload(challenge);
}

const SENSITIVE_POW_PATHS = [
  /^\/api\/reports$/,
  /^\/api\/auth\/otp\/(request|send|verify)$/,
  /^\/api\/alerts\/community$/,
  /^\/api\/alerts\/[^/]+\/confirm$/,
];

export function requiresPowSolution(path: string, method: string): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  return SENSITIVE_POW_PATHS.some((re) => re.test(path.split('?')[0]));
}
