interface PowChallengePayload {
  challengeId: string;
  nonce: string;
  expiresAt: number;
  difficultyBits: number;
  signature: string;
}

function hasLeadingZeroBits(bytes: Uint8Array, bits: number): boolean {
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

/**
 * Tự động xin thử thách SHA-256 PoW từ `/api/security/challenge` và giải trên trình duyệt (~80-250ms)
 * trước khi gửi dữ liệu nhạy cảm (`POST /api/reports`, OTP, xác nhận cảnh báo cộng đồng).
 */
export async function solvePowHeader(baseUrl: string, headers: Record<string, string>): Promise<string> {
  const res = await fetch(`${baseUrl}/api/security/challenge`, {
    method: 'GET',
    credentials: 'include',
    headers,
  });
  if (!res.ok) {
    throw new Error(`Không lấy được thử thách bảo mật PoW (${res.status})`);
  }
  const challenge = (await res.json()) as PowChallengePayload;
  const encoder = new TextEncoder();

  for (let counter = 0; counter < 1_000_000; counter++) {
    const data = encoder.encode(`${challenge.nonce}:${counter}`);
    const digestBuf = await crypto.subtle.digest('SHA-256', data);
    if (hasLeadingZeroBits(new Uint8Array(digestBuf), challenge.difficultyBits)) {
      return `${challenge.challengeId}.${challenge.nonce}.${challenge.expiresAt}.${challenge.difficultyBits}.${challenge.signature}.${counter}`;
    }
    // Nhường main thread mỗi 512 vòng để UI mượt 60FPS
    if (counter > 0 && counter % 512 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  throw new Error('Không giải được thử thách bảo mật trong giới hạn.');
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
