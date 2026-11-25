export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string = 'error',
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (msg: string, code = 'bad_request', details?: unknown): HttpError => new HttpError(400, msg, code, details);
export const unauthorized = (msg = 'Cần đăng nhập để thực hiện thao tác này.'): HttpError => new HttpError(401, msg, 'unauthorized');
export const forbidden = (msg = 'Bạn không có quyền thực hiện thao tác này.'): HttpError => new HttpError(403, msg, 'forbidden');
export const notFound = (msg = 'Không tìm thấy dữ liệu.'): HttpError => new HttpError(404, msg, 'not_found');
export const conflict = (msg: string, code = 'conflict', details?: unknown): HttpError => new HttpError(409, msg, code, details);
export const tooMany = (msg: string, code = 'rate_limited'): HttpError => new HttpError(429, msg, code);
