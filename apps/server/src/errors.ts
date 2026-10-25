export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string = 'error',
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg = 'Bad request', details?: unknown) => new HttpError(400, msg, 'bad_request', details);
export const unauthorized = (msg = 'Not logged in') => new HttpError(401, msg, 'unauthorized');
export const forbidden = (msg = "You don't have permission to do that") => new HttpError(403, msg, 'forbidden');
export const notFound = (what = 'Not found') => new HttpError(404, what, 'not_found');
export const conflict = (msg: string) => new HttpError(409, msg, 'conflict');
export const tooLarge = (msg = 'Too large') => new HttpError(413, msg, 'too_large');
export const tooMany = (retryAfter: number, msg = 'Slow down') =>
  new HttpError(429, msg, 'rate_limited', { retryAfter });
export const unavailable = (msg: string) => new HttpError(503, msg, 'unavailable');
