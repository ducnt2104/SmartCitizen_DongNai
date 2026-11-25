import type { Request, Response } from 'express';
import type { z } from 'zod';
import type { AiMode } from '../shared/types';
import type { Services } from '../services/container';
import { assertScope, parsePhotoDataUrl } from '../services/access';
import { sanitizeUserText } from '../services/gemini.service';
import { badRequest, notFound } from '../utils/errors';
import type { schemas } from '../validation/schemas';

export function aiController(s: Services) {
  return {
    analyzeImage: async (req: Request, res: Response) => {
      const b = req.body as z.infer<typeof schemas.analyzeImage>;
      const { mime, base64 } = parsePhotoDataUrl(b.image.dataUrl);
      const result = await s.gemini.analyzeImage({
        imageBase64: base64,
        mimeType: mime,
        dHash: b.image.dHash,
        hintCategory: b.category,
        hintText: b.hintText,
        edge: b.edge,
      });
      res.json(result);
    },

    verifyResolution: async (req: Request, res: Response) => {
      const b = req.body as z.infer<typeof schemas.verifyResolution>;
      const r = await s.repos.reports.get(b.reportId);
      if (!r) throw notFound('Không tìm thấy hồ sơ.');
      assertScope(req.user!, r);
      const before = r.photos[0];
      const after = parsePhotoDataUrl(b.afterPhoto.dataUrl);
      const svgBefore = before.url.startsWith('data:image/svg');
      const out = svgBefore
        ? s.gemini.fallbackVerify({
            reportId: r.id,
            beforeBase64: '',
            beforeMime: after.mime,
            beforeHash: before.dHash,
            afterBase64: after.base64,
            afterMime: after.mime,
            afterHash: b.afterPhoto.dHash,
            category: r.category,
            title: r.title,
          })
        : await s.gemini.verifyResolution({
            reportId: r.id,
            ...(() => {
              const p = parsePhotoDataUrl(before.url);
              return { beforeBase64: p.base64, beforeMime: p.mime };
            })(),
            beforeHash: before.dHash,
            afterBase64: after.base64,
            afterMime: after.mime,
            afterHash: b.afterPhoto.dHash,
            category: r.category,
            title: r.title,
            beforeLat: r.lat,
            beforeLng: r.lng,
            afterLat: r.lat,
            afterLng: r.lng,
          });
      res.json(out);
    },

    /** SSE Streaming tốc độ cao (Ollama / llama.cpp + Local BM25 RAG + LRU Cache). */
    chat: async (req: Request, res: Response) => {
      const b = req.body as z.infer<typeof schemas.chat>;
      const last = b.messages[b.messages.length - 1];
      if (last.role !== 'user') throw badRequest('Tin nhắn cuối phải là của người dùng.');
      const history = b.messages.map((m) => ({ role: m.role, text: sanitizeUserText(m.text) }));
      const ctx = await s.chat.buildContext(req.user ?? null, b.wardCode, last.text);

      res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      let closed = false;
      res.on('close', () => {
        closed = true;
      });
      const send = (obj: unknown): void => {
        if (!closed) res.write(`data: ${JSON.stringify(obj)}\n\n`);
      };
      let mode: AiMode = 'fallback';
      try {
        for await (const chunk of s.gemini.chatStream(
          history,
          ctx.text,
          () => s.chat.localAnswer(ctx, last.text, b.locale),
          b.wardCode,
        )) {
          if (closed) break;
          mode = chunk.mode;
          send({ delta: chunk.delta, mode: chunk.mode });
        }
        send({ done: true, mode });
      } catch (err) {
        console.error('[chat] stream lỗi:', err);
        send({ error: 'Trợ lý đang bận, vui lòng thử lại.', done: true, mode: 'fallback' });
      }
      res.end();
    },
  };
}
