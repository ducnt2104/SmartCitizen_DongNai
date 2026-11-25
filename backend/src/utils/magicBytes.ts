export type SupportedImageMagicFormat = 'jpeg' | 'png' | 'webp';

/**
 * Kiểm tra Magic Bytes thực tế của tệp ảnh upload (tuyệt đối không tin MIME header hay đuôi file):
 * - JPEG: FF D8 FF
 * - PNG:  89 50 4E 47 0D 0A 1A 0A
 * - WebP: RIFF....WEBP
 */
export function detectImageMagicBytes(buf: Buffer): SupportedImageMagicFormat | null {
  if (!Buffer.isBuffer(buf) || buf.byteLength < 12) return null;

  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'jpeg';
  }

  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'png';
  }

  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'webp';
  }

  return null;
}

export function isAllowedImageMagicBytes(buf: Buffer): boolean {
  return detectImageMagicBytes(buf) !== null;
}
