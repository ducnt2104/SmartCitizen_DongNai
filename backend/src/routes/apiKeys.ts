import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler, authMiddleware } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import type { Services } from '../services/container';
import type { Role } from '../shared/types';
import { badRequest } from '../utils/errors';

const providerEnum = z.enum(['gemini', 'openrouter', 'groq']);
const geminiEndpointEnum = z.enum(['ai_studio', 'vertex']);

const addKeyItemSchema = z.object({
  apiKey: z.string().trim().min(8).max(512),
  label: z.string().trim().max(120).optional(),
  provider: providerEnum.optional(),
  geminiEndpoint: geminiEndpointEnum.optional(),
  weight: z.coerce.number().int().min(1).max(20).optional(),
});

export const addApiKeysSchema = z
  .object({
    apiKey: z.string().trim().min(8).max(512).optional(),
    apiKeys: z.array(z.string().trim().min(1).max(512)).max(200).optional(),
    keysText: z.string().max(32_000).optional(),
    items: z.array(addKeyItemSchema).max(200).optional(),
    provider: providerEnum.optional(),
    geminiEndpoint: geminiEndpointEnum.optional(),
    labelPrefix: z.string().trim().max(80).optional(),
    weight: z.coerce.number().int().min(1).max(20).optional(),
  })
  .refine(
    (v) =>
      Boolean(
        (v.apiKey && v.apiKey.length > 0) ||
          (v.apiKeys && v.apiKeys.length > 0) ||
          (v.keysText && v.keysText.trim().length > 0) ||
          (v.items && v.items.length > 0),
      ),
    {
      message: 'Cần truyền ít nhất một trong các trường: apiKey, apiKeys, keysText hoặc items.',
    },
  );

export const patchApiKeySchema = z
  .object({
    isEnabled: z.boolean().optional(),
    resetCooldown: z.boolean().optional(),
    label: z.string().trim().min(1).max(120).optional(),
    weight: z.coerce.number().int().min(1).max(20).optional(),
  })
  .refine(
    (v) =>
      v.isEnabled !== undefined ||
      v.resetCooldown !== undefined ||
      v.label !== undefined ||
      v.weight !== undefined,
    {
      message: 'Cần truyền ít nhất một thuộc tính cập nhật (isEnabled, resetCooldown, label, weight).',
    },
  );

/**
 * Router quản trị Multi-API Key Pool dành riêng cho Admin cấp Thành phố (`/api/admin/api-keys`).
 * Cam kết bảo mật: TUYỆT ĐỐI không bao giờ trả raw API key hoặc bản mã AES ra HTTP response.
 */
export function buildApiKeysRouter(s: Services): Router {
  const router = Router();
  const auth = authMiddleware(s);
  const adminRoles: Role[] = ['admin'];
  const cityAdmin = auth.requireRole(...adminRoles);
  const h = asyncHandler;

  router.use(...cityAdmin);

  // GET /api/admin/api-keys — Danh sách key đã che (AIzaSy...8xKp) + chỉ số sức khỏe real-time
  router.get(
    '/',
    h(async (_req: Request, res: Response) => {
      const snapshot = await s.keyPool.listMaskedKeys();
      res.set('Cache-Control', 'no-store');
      res.json(snapshot);
    }),
  );

  // POST /api/admin/api-keys — Thêm 1 hoặc dán hàng loạt (10+ key), mã hóa AES-256-GCM trước khi lưu
  router.post(
    '/',
    validateBody(addApiKeysSchema),
    h(async (req: Request, res: Response) => {
      const body = req.body as z.infer<typeof addApiKeysSchema>;
      const actor = req.user!;
      const result = await s.keyPool.addKeys({
        ...body,
        addedBy: actor.id,
      });

      if (result.addedCount === 0 && result.invalidFormatCount > 0 && result.skippedDuplicateCount === 0) {
        throw badRequest('Không có API key nào đúng định dạng hợp lệ.', 'invalid_api_keys');
      }

      await s.audit.log(
        { id: actor.id, name: actor.name, role: actor.role },
        'apikey.bulk_add',
        'key_pool',
        null,
        {
          addedCount: result.addedCount,
          skippedDuplicateCount: result.skippedDuplicateCount,
          maskedKeys: result.added.map((k) => k.maskedKey),
        },
      );

      res.status(result.addedCount > 0 ? 201 : 200).json(result);
    }),
  );

  // POST /api/admin/api-keys/:id/test — Bắn 1 request nhẹ kiểm tra key còn sống hay không
  router.post(
    '/:id/test',
    h(async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const actor = req.user!;
      const testResult = await s.keyPool.testKey(id);

      await s.audit.log(
        { id: actor.id, name: actor.name, role: actor.role },
        'apikey.test',
        id,
        null,
        {
          maskedKey: testResult.maskedKey,
          ok: testResult.ok,
          status: testResult.status,
          latencyMs: testResult.latencyMs,
        },
      );

      res.json(testResult);
    }),
  );

  // PATCH /api/admin/api-keys/:id — Bật/tắt (isEnabled) hoặc reset Cooldown thủ công
  router.patch(
    '/:id',
    validateBody(patchApiKeySchema),
    h(async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const patch = req.body as z.infer<typeof patchApiKeySchema>;
      const actor = req.user!;
      const updated = await s.keyPool.updateKey(id, patch);

      await s.audit.log(
        { id: actor.id, name: actor.name, role: actor.role },
        'apikey.update',
        id,
        null,
        {
          maskedKey: updated.maskedKey,
          isEnabled: updated.isEnabled,
          resetCooldown: Boolean(patch.resetCooldown),
          status: updated.status,
        },
      );

      res.json(updated);
    }),
  );

  // DELETE /api/admin/api-keys/:id — Xóa key khỏi MongoDB & KeyPool
  router.delete(
    '/:id',
    h(async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const actor = req.user!;
      const out = await s.keyPool.deleteKey(id);

      await s.audit.log(
        { id: actor.id, name: actor.name, role: actor.role },
        'apikey.delete',
        id,
        { maskedKey: out.maskedKey },
        null,
      );

      res.json(out);
    }),
  );

  return router;
}
