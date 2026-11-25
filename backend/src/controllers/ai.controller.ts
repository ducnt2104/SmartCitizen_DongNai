import type { Request, Response } from 'express';
import type { z } from 'zod';
import type { AiMode } from '../shared/types';
import type { Services } from '../services/container';
import {
  assertScope,
  loadStoredPhotoForVerification,
  parsePhotoDataUrl,
  resolvePhotoInputFromRequest,
} from '../services/access';
import { sanitizeUserText } from '../services/gemini.service';
import { badRequest, notFound } from '../utils/errors';
import type { schemas } from '../validation/schemas';

export function aiController(s: Services) {
  return {
    analyzeImage: async (req: Request, res: Response) => {
      const b = req.body as z.infer<typeof schemas.analyzeImage>;
      const photo = await resolvePhotoInputFromRequest(req, b.image, b.dHash);
      const aiBuf = photo.aiBuffer ?? photo.buffer;
      const base64 = aiBuf ? aiBuf.toString('base64') : '';
      const legacyMime = photo.dataUrl ? parsePhotoDataUrl(photo.dataUrl).mime : 'image/webp';
      const mimeType = photo.aiBuffer ? 'image/webp' : legacyMime;
      const deviceFp = typeof req.headers['x-device-fp'] === 'string' ? req.headers['x-device-fp'] : '';
      const rateLimitKey = `vision:${req.ip ?? 'ip'}:${req.user?.id ?? 'anon'}:${deviceFp}`;

      const result = await s.gemini.analyzeImage({
        imageBuffer: aiBuf,
        imageBase64: base64,
        mimeType,
        dHash: photo.dHash,
        hintCategory: b.category,
        hintText: b.hintText,
        edge: b.edge,
        exif: b.exif,
        lat: b.lat,
        lng: b.lng,
        wardCode: b.wardCode,
        rateLimitKey,
        trustScore: req.user?.trustScore,
        reportsRepo: s.repos.reports,
        allowTinyTestStub: process.env.NODE_ENV === 'test' && Boolean(b.image?.dataUrl),
      });
      res.json(result);
    },

    verifyResolution: async (req: Request, res: Response) => {
      const b = req.body as z.infer<typeof schemas.verifyResolution>;
      const r = await s.repos.reports.get(b.reportId);
      if (!r) throw notFound('Không tìm thấy hồ sơ.');
      assertScope(req.user!, r);
      const before = r.photos[0];
      const afterPhoto = await resolvePhotoInputFromRequest(req, b.afterPhoto, b.dHash);
      const afterBuf = afterPhoto.aiBuffer ?? afterPhoto.buffer;
      const afterBase64 = afterBuf ? afterBuf.toString('base64') : '';
      const afterMime = afterPhoto.dataUrl ? parsePhotoDataUrl(afterPhoto.dataUrl).mime : 'image/webp';
      const loadedBefore = await loadStoredPhotoForVerification(before);

      const out = loadedBefore.isSvg
        ? s.gemini.fallbackVerify({
            reportId: r.id,
            beforeBase64: '',
            beforeMime: afterMime,
            beforeHash: before.dHash,
            afterBase64,
            afterMime,
            afterHash: afterPhoto.dHash,
            category: r.category,
            title: r.title,
            afterEdge: b.edge,
          })
        : await s.gemini.verifyResolution({
            reportId: r.id,
            beforeBase64: loadedBefore.base64,
            beforeMime: loadedBefore.mime,
            beforeHash: before.dHash,
            afterBase64,
            afterMime,
            afterHash: afterPhoto.dHash,
            category: r.category,
            title: r.title,
            beforeLat: r.lat,
            beforeLng: r.lng,
            afterLat: r.lat,
            afterLng: r.lng,
            afterEdge: b.edge,
          });
      res.json(out);
    },

    /** Sinh thẻ "Gợi ý tác chiến 3 dòng" cho Đội Cứu Hộ & Cán bộ IOC (lưu lại vào hồ sơ nếu có reportId). */
    tacticalBriefing: async (req: Request, res: Response) => {
      const b = req.body as z.infer<typeof schemas.tacticalBriefing>;
      if (b.reportId) {
        const r = await s.repos.reports.get(b.reportId);
        if (!r) throw notFound('Không tìm thấy hồ sơ.');
        assertScope(req.user!, r);
        if (!b.forceRefresh && r.ai?.tacticalBriefing) {
          res.json(r.ai.tacticalBriefing);
          return;
        }
        const briefing = await s.gemini.generateTacticalBriefing({
          reportId: r.id,
          category: r.category,
          title: r.title,
          description: r.description,
          severity: r.severity,
          isEmergency: r.isEmergency || r.emergencyLevel === 1,
          wardCode: r.wardCode,
          address: r.address,
          roadName: r.roadName,
          onArterial: r.onArterial,
          safetyHazards: r.ai.safetyHazards,
          forceRefresh: b.forceRefresh,
        });
        r.ai = { ...r.ai, tacticalBriefing: briefing };
        r.updatedAt = new Date().toISOString();
        await s.repos.reports.update(r).catch(() => undefined);
        res.json(briefing);
        return;
      }

      if (!b.category || !b.title) {
        throw badRequest('Cần truyền reportId hoặc cặp { category, title }.');
      }
      const briefing = await s.gemini.generateTacticalBriefing({
        category: b.category,
        title: b.title,
        description: b.description,
        severity: b.severity,
        isEmergency: b.isEmergency,
        wardCode: b.wardCode,
        address: b.address,
        forceRefresh: b.forceRefresh,
      });
      res.json(briefing);
    },

    /** SSE Streaming tốc độ cao (Ollama / llama.cpp + Local BM25 RAG + LRU Cache + Gemini Multi-Key). */
    chat: async (req: Request, res: Response) => {
      const b = req.body as z.infer<typeof schemas.chat>;
      const last = b.messages[b.messages.length - 1];
      if (last.role !== 'user') throw badRequest('Tin nhắn cuối phải là của người dùng.');
      const history = b.messages.map((m) => ({ role: m.role, text: sanitizeUserText(m.text) }));
      const ctx = await s.chat.buildContext(req.user ?? null, b.wardCode, last.text);
      const instantAnswer = s.chat.resolveInstantAnswer(ctx, last.text, b.locale);

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
          instantAnswer,
        )) {
          if (closed) break;
          mode = chunk.mode;
          send({ delta: chunk.delta, mode: chunk.mode });
        }
        send({ done: true, mode });
      } catch (err) {
        console.error('[chat] stream lỗi:', err);
        const safeFallback = s.chat.localAnswer(ctx, last.text, b.locale);
        send({ delta: safeFallback, mode: 'fallback' });
        send({ done: true, mode: 'fallback' });
      }
      res.end();
    },
  };
}
