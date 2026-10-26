import { createHash } from 'node:crypto';
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

/**
 * Trust exactly `hops` reverse proxies. proxy-addr walks X-Forwarded-For from the right, so the
 * client IP is the entry our own proxy appended; anything the client put in the header itself is
 * ignored (otherwise anyone could fake their IP and dodge rate limits).
 */
export function trustProxyHops(hops: number | false): false | ((addr: string, hop: number) => boolean) {
  return hops ? (_addr: string, hop: number) => hop < hops : false;
}

/**
 * SvelteKit's static index.html boots from one small inline script. Instead of allowing
 * 'unsafe-inline' we allow exactly those scripts by hash.
 */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (/\ssrc=/i.test(m[0].slice(0, m[0].indexOf('>')))) continue;
    out.push(`'sha256-${createHash('sha256').update(m[1]!, 'utf8').digest('base64')}'`);
  }
  return out;
}

/** Content Security Policy for the web app. */
export function appCsp(livekitUrl: string | null, scriptHashes: string[] = []): string {
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
    ["script-src 'self'", ...scriptHashes].join(' '),
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

export function registerSecurityHeaders(app: FastifyInstance, livekitUrl: string | null, https: boolean, scriptHashes: string[] = []): void {
  const csp = appCsp(livekitUrl, scriptHashes);
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
