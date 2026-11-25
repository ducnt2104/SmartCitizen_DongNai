import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { MAX_IMAGE_BYTES } from '../services/media.service';
import { HttpError, badRequest } from '../utils/errors';
import { isAllowedImageMagicBytes } from '../utils/magicBytes';
import { hasMongoOperators, stripMongoOperators } from '../utils/sanitize';

export interface UploadedImageBuffers {
  aiBuffer?: Buffer;
  aiMimeType?: string;
  displayBuffer?: Buffer;
  displayMimeType?: string;
}

declare global {
  namespace Express {
    interface Request {
      uploadedImages?: UploadedImageBuffers;
    }
  }
}

const storage = multer.memoryStorage();

const uploader = multer({
  storage,
  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: 3,
    fields: 32,
  },
});

const fieldsMiddleware = uploader.fields([
  { name: 'aiImage', maxCount: 1 },
  { name: 'displayImage', maxCount: 1 },
  { name: 'image', maxCount: 1 },
  { name: 'photo', maxCount: 1 },
  { name: 'afterPhoto', maxCount: 1 },
]);

function pickFile(
  files: Record<string, Express.Multer.File[]> | undefined,
  names: string[],
): Express.Multer.File | undefined {
  if (!files) return undefined;
  for (const name of names) {
    const f = files[name]?.[0];
    if (f && f.buffer?.byteLength > 0) return f;
  }
  return undefined;
}

/**
 * Middleware xử lý `multipart/form-data` (giữ tương thích ngược 100% với `application/json` từ offline outbox/test):
 * - Tách file binary `aiImage` (<=640px) & `displayImage` (<=1280px) vào `req.uploadedImages`.
 * - Giải mã trường `metadata` JSON (hoặc các trường form phẳng) vào `req.body` trước khi qua Zod validation.
 */
export const parseMultipartOrJson: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  if (!req.is('multipart/form-data')) {
    next();
    return;
  }

  fieldsMiddleware(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          next(new HttpError(413, 'Ảnh tải lên vượt quá giới hạn tối đa 5MB.', 'file_too_large'));
          return;
        }
        next(badRequest(`Lỗi tải tệp: ${err.message}`, 'upload_error'));
        return;
      }
      next(err);
      return;
    }

    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const aiFile = pickFile(files, ['aiImage']);
    const displayFile = pickFile(files, ['displayImage', 'image', 'photo', 'afterPhoto']);

    for (const candidate of [aiFile, displayFile]) {
      if (candidate && !isAllowedImageMagicBytes(candidate.buffer)) {
        next(
          badRequest(
            'Tệp tải lên không khớp chữ ký Magic Bytes của ảnh hợp lệ (chỉ chấp nhận JPEG, PNG hoặc WebP thật).',
            'invalid_image_magic_bytes',
          ),
        );
        return;
      }
    }

    req.uploadedImages = {
      aiBuffer: aiFile?.buffer ?? displayFile?.buffer,
      aiMimeType: aiFile?.mimetype ?? displayFile?.mimetype,
      displayBuffer: displayFile?.buffer ?? aiFile?.buffer,
      displayMimeType: displayFile?.mimetype ?? aiFile?.mimetype,
    };

    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    if (typeof rawBody.metadata === 'string' && rawBody.metadata.trim()) {
      try {
        const parsedMeta = JSON.parse(rawBody.metadata) as Record<string, unknown>;
        if (parsedMeta && typeof parsedMeta === 'object' && !Array.isArray(parsedMeta)) {
          const { metadata: _m, ...restFields } = rawBody;
          void _m;
          req.body = { ...restFields, ...parsedMeta };
        }
      } catch {
        next(badRequest('Trường metadata trong multipart/form-data không phải JSON hợp lệ.', 'invalid_metadata'));
        return;
      }
    }

    if (hasMongoOperators(req.body)) {
      next(badRequest('Dữ liệu chứa ký tự không được phép ($ hoặc .) trong tên trường.', 'forbidden_characters'));
      return;
    }
    req.body = stripMongoOperators(req.body);

    next();
  });
};
