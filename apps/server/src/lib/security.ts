import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { forbidden } from '../errors.js';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF: the session cookie is SameSite=Lax, and on top of that every state-changing request must
 * come from our own origin. Browsers always send Origin on cross-site POST/PUT/PATCH/DELETE.
 */
export function checkOrigin(req: FastifyRequest, publicUrl: string): void {
  if (!UNSAFE.has(req.method)) return;
  if (req.url.startsWith('/api/livekit/webhook')) return; // server-to-server, signed
  const origin = req.headers.origin;
  if (origin) {
    if (origin !== publicUrl) throw forbidden('Cross-origin request blocked');
    return;
  }
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw forbidden('Cross-site request blocked');
}

/** Content Security Policy for the web app. */
export function appCsp(livekitUrl: string | null): string {
  const connect = ["'self'"];
  if (livekitUrl) {
    try {
      const u = new URL(livekitUrl);
      connect.push(`${u.protocol}//${u.host}`);
    } catch {
      /* relative LiveKit url → covered by 'self' */
    }
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    `connect-src ${connect.join(' ')} ws: wss:`,
    'frame-src https://www.youtube-nocookie.com',
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function registerSecurityHeaders(app: FastifyInstance, livekitUrl: string | null, https: boolean): void {
  const csp = appCsp(livekitUrl);
  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'geolocation=(), payment=(), usb=(), camera=(self), microphone=(self), display-capture=(self)');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    if (https) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (!reply.hasHeader('Content-Security-Policy')) {
      if (req.url.startsWith('/api/')) reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      else reply.header('Content-Security-Policy', csp);
    }
    if (req.url.startsWith('/api/') && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
  });
}
