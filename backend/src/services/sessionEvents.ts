import type { Response } from 'express';

export type SessionTerminationCode = 'SESSION_REPLACED' | 'SESSION_REVOKED' | 'SESSION_COMPROMISED';

interface ActiveSseClient {
  sessionId: string;
  res: Response;
  heartbeat: NodeJS.Timeout;
}

const streamsByUser = new Map<string, Set<ActiveSseClient>>();

/** Đăng ký kênh SSE theo dõi trạng thái phiên đăng nhập theo thời gian thực. */
export function registerSessionStream(userId: string, sessionId: string, res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(': session-stream-connected\n\n');

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': ping\n\n');
    }
  }, 25_000);
  heartbeat.unref?.();

  const client: ActiveSseClient = { sessionId, res, heartbeat };
  let bucket = streamsByUser.get(userId);
  if (!bucket) {
    bucket = new Set();
    streamsByUser.set(userId, bucket);
  }
  bucket.add(client);

  res.on('close', () => {
    clearInterval(heartbeat);
    const set = streamsByUser.get(userId);
    if (set) {
      set.delete(client);
      if (set.size === 0) streamsByUser.delete(userId);
    }
  });
}

/** Đẩy thông báo thu hồi / thay thế phiên ngay lập tức xuống các tab/thiết bị đang mở SSE. */
export function notifySessionTerminated(
  userId: string,
  opts: { excludeSessionId?: string | null; targetSessionId?: string | null; code: SessionTerminationCode; message: string },
): void {
  const bucket = streamsByUser.get(userId);
  if (!bucket || bucket.size === 0) return;

  const payload = JSON.stringify({ code: opts.code, message: opts.message, at: Date.now() });
  for (const client of [...bucket]) {
    if (opts.excludeSessionId && client.sessionId === opts.excludeSessionId) continue;
    if (opts.targetSessionId && client.sessionId !== opts.targetSessionId) continue;
    clearInterval(client.heartbeat);
    bucket.delete(client);
    try {
      if (!client.res.writableEnded) {
        client.res.write(`event: session_terminated\ndata: ${payload}\n\n`);
        client.res.end();
      }
    } catch {
      // Ignore closed client sockets
    }
  }
  if (bucket.size === 0) streamsByUser.delete(userId);
}

/** Thu hồi toàn bộ luồng SSE toàn hệ thống (ngoại trừ phiên đang thao tác nếu có). */
export function notifyAllSessionsTerminated(
  excludeSessionId: string | null,
  code: SessionTerminationCode,
  message: string,
): void {
  for (const userId of [...streamsByUser.keys()]) {
    notifySessionTerminated(userId, { excludeSessionId, code, message });
  }
}
