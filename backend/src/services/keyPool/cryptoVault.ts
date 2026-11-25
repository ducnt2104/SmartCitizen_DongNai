import crypto from 'node:crypto';
import type { ApiKeyProvider, GeminiEndpointKind } from './types';

const ENVELOPE_VERSION = 'v1';
const IV_BYTES = 12; // Chuẩn NIST SP 800-38D cho AES-GCM (96-bit nonce)
const AUTH_TAG_BYTES = 16; // 128-bit GCM authentication tag
const HKDF_SALT = Buffer.from('smartcitizen-dongnai:keypool:salt:v1', 'utf8');
const HKDF_INFO = Buffer.from('smartcitizen-dongnai:apikey-aes-256-gcm:v1', 'utf8');

export interface EncryptedApiKeyEnvelope {
  /** Chuỗi đóng gói tự mô tả: v1:<ivBase64>:<authTagBase64>:<cipherBase64> */
  encryptedKey: string;
  iv: string;
  authTag: string;
  keyFingerprint: string;
  maskedKey: string;
}

/** Dẫn xuất khóa đối xứng 256-bit (32 bytes) chuẩn HKDF-SHA256 từ KEY_ENCRYPTION_SECRET. */
export function deriveAes256Key(secret: string): Buffer {
  const normalized = secret.trim();
  if (!normalized) {
    throw new Error('Thiếu KEY_ENCRYPTION_SECRET để mã hóa/giải mã API Key.');
  }
  const derived = crypto.hkdfSync(
    'sha256',
    Buffer.from(normalized, 'utf8'),
    HKDF_SALT,
    HKDF_INFO,
    32,
  );
  return Buffer.from(derived);
}

/** Băm SHA-256 một chiều để chống trùng lặp API key trong DB mà không lưu bản rõ. */
export function fingerprintApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey.trim(), 'utf8').digest('hex');
}

/**
 * Che API key an toàn dạng `AIzaSy...8xKp`.
 * Tuyệt đối không bao giờ trả nguyên vẹn chuỗi gốc ngay cả với key ngắn.
 */
export function maskApiKey(rawKey: string): string {
  const clean = rawKey.trim();
  if (clean.length === 0) return '***';
  if (clean.length <= 6) {
    return `${clean.slice(0, 1)}...${clean.slice(-1)}`;
  }
  if (clean.length <= 12) {
    return `${clean.slice(0, 3)}...${clean.slice(-3)}`;
  }
  return `${clean.slice(0, 6)}...${clean.slice(-4)}`;
}

/** Hậu tố ngắn phục vụ log xoay vòng: `..8xKp`. */
export function shortMaskApiKey(rawKey: string): string {
  const clean = rawKey.trim();
  if (clean.length <= 4) return `..${clean}`;
  return `..${clean.slice(-4)}`;
}

/** Tự động nhận diện provider theo tiền tố API key nếu không truyền tường minh. */
export function detectKeyProvider(rawKey: string, explicit?: ApiKeyProvider): ApiKeyProvider {
  if (explicit) return explicit;
  const clean = rawKey.trim();
  if (/^vertex:/i.test(clean)) return 'gemini';
  if (clean.startsWith('sk-or-')) return 'openrouter';
  if (clean.startsWith('gsk_')) return 'groq';
  return 'gemini';
}

/** Mã hóa đối xứng API key bằng AES-256-GCM kèm AAD gắn chặt vào keyFingerprint. */
export function encryptApiKey(rawKey: string, secret: string): EncryptedApiKeyEnvelope {
  const clean = rawKey.trim();
  if (clean.length < 8) {
    throw new Error('API Key quá ngắn hoặc không hợp lệ.');
  }
  const key32 = deriveAes256Key(secret);
  const keyFingerprint = fingerprintApiKey(clean);
  const ivBuf = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key32, ivBuf, {
    authTagLength: AUTH_TAG_BYTES,
  });
  cipher.setAAD(Buffer.from(keyFingerprint, 'utf8'));

  const encryptedBuf = Buffer.concat([cipher.update(clean, 'utf8'), cipher.final()]);
  const authTagBuf = cipher.getAuthTag();

  const iv = ivBuf.toString('base64');
  const authTag = authTagBuf.toString('base64');
  const cipherB64 = encryptedBuf.toString('base64');

  return {
    encryptedKey: `${ENVELOPE_VERSION}:${iv}:${authTag}:${cipherB64}`,
    iv,
    authTag,
    keyFingerprint,
    maskedKey: maskApiKey(clean),
  };
}

/** Giải mã API key từ bản mã AES-256-GCM và kiểm tra toàn vẹn GCM AuthTag + AAD. */
export function decryptApiKey(
  input: string | { encryptedKey: string; keyFingerprint?: string },
  secret: string,
): string {
  const envelope = typeof input === 'string' ? input : input.encryptedKey;
  const expectedFingerprint = typeof input === 'string' ? undefined : input.keyFingerprint;

  const parts = envelope.split(':');
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error('Định dạng bản mã API Key không hợp lệ hoặc phiên bản không được hỗ trợ.');
  }

  const [, ivB64, authTagB64, cipherB64] = parts;
  const ivBuf = Buffer.from(ivB64, 'base64');
  const authTagBuf = Buffer.from(authTagB64, 'base64');
  const cipherBuf = Buffer.from(cipherB64, 'base64');

  if (ivBuf.length !== IV_BYTES || authTagBuf.length !== AUTH_TAG_BYTES || cipherBuf.length === 0) {
    throw new Error('Dữ liệu IV/AuthTag của bản mã AES-256-GCM bị hỏng.');
  }

  const key32 = deriveAes256Key(secret);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key32, ivBuf, {
    authTagLength: AUTH_TAG_BYTES,
  });
  decipher.setAuthTag(authTagBuf);

  if (expectedFingerprint) {
    decipher.setAAD(Buffer.from(expectedFingerprint, 'utf8'));
  }

  let plain: string;
  try {
    plain = Buffer.concat([decipher.update(cipherBuf), decipher.final()]).toString('utf8');
  } catch {
    // Trường hợp gọi decryptApiKey(envelopeString, secret) không truyền sẵn expectedFingerprint:
    // nếu bản mã có AAD theo fingerprint thì bắt buộc truyền object có keyFingerprint.
    throw new Error('Giải mã AES-256-GCM thất bại: sai KEY_ENCRYPTION_SECRET hoặc dữ liệu bị can thiệp.');
  }

  if (expectedFingerprint && fingerprintApiKey(plain) !== expectedFingerprint) {
    throw new Error('Đối chiếu fingerprint API Key sau giải mã thất bại.');
  }

  return plain;
}

/**
 * Tách tiền tố `vertex:` tường minh (nếu có) và xác định loại endpoint Google Gemini.
 * Mặc định mọi key trong pool AI Studio (bao gồm cả `AQ.*` lẫn `AIzaSy*`) đều định tuyến tới
 * Google AI Studio (`ai_studio`), chỉ định tuyến Vertex AI khi được cấu hình tường minh (`VERTEX_API_KEYS` hoặc `vertex:`).
 */
export function parseGeminiKeyRouting(
  rawKey: string,
  defaultEndpoint: GeminiEndpointKind = 'ai_studio',
): { cleanKey: string; geminiEndpoint: GeminiEndpointKind } {
  const trimmed = rawKey.trim();
  if (/^vertex:/i.test(trimmed)) {
    return {
      cleanKey: trimmed.replace(/^vertex:\s*/i, '').trim(),
      geminiEndpoint: 'vertex',
    };
  }
  return {
    cleanKey: trimmed,
    geminiEndpoint: defaultEndpoint,
  };
}

/** Nhận diện loại endpoint Google cho Gemini key (`vertex:` hoặc tag tường minh -> Vertex AI, mặc định -> Google AI Studio). */
export function detectGeminiKeyKind(
  rawKey: string,
  explicitEndpoint?: GeminiEndpointKind,
): GeminiEndpointKind {
  return parseGeminiKeyRouting(rawKey, explicitEndpoint ?? 'ai_studio').geminiEndpoint;
}

function stripOuterQuotesAndBrackets(value: string): string {
  return value.trim().replace(/^[\s"'“”‘’`[\]]+|[\s"'“”‘’`[\]]+$/g, '').trim();
}

/**
 * Tách danh sách key đa định dạng (phân tách bằng dấu phẩy, xuống dòng, khoảng trắng, chấm phẩy `/[\s,;\r\n]+/`),
 * tự động xử lý chuỗi `\n` thoát ký tự trên Render Dashboard, loại bỏ dấu ngoặc kép thừa và khử trùng lặp giữ nguyên thứ tự.
 */
export function parseBulkApiKeys(raw: string | readonly string[]): string[] {
  const chunks = Array.isArray(raw) ? raw : [raw as string];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const chunk of chunks) {
    if (typeof chunk !== 'string') continue;
    // Hỗ trợ chuỗi chứa `\n` / `\r\n` dạng literal khi nhập trên giao diện biến môi trường 1 dòng
    const normalizedLines = chunk
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .split(/[\r\n]+/)
      .map((line) => {
        const trimmed = stripOuterQuotesAndBrackets(line);
        // Hỗ trợ dòng kiểu `export GEMINI_API_KEY_1 = "AIza..."` hoặc `GEMINI_API_KEYS=k1,k2`
        return trimmed.replace(/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*/, '');
      })
      .join('\n');

    const tokens = normalizedLines
      .split(/[\s,;\r\n]+/)
      .map(stripOuterQuotesAndBrackets)
      .filter(Boolean);

    for (const token of tokens) {
      const eqIdx = token.indexOf('=');
      const clean =
        eqIdx > 0 && /^[A-Z0-9_]+$/i.test(token.slice(0, eqIdx).trim())
          ? stripOuterQuotesAndBrackets(token.slice(eqIdx + 1))
          : token;
      // Bỏ qua token rỗng, tên biến mồ côi hoặc chuỗi quá ngắn không phải API key
      if (!clean || clean.length < 8 || /^[A-Z0-9_]+=$/i.test(token)) continue;
      const fp = fingerprintApiKey(clean);
      if (!seen.has(fp)) {
        seen.add(fp);
        out.push(clean);
      }
    }
  }
  return out;
}
