import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { Ctx } from './context.js';
import { HttpError } from './errors.js';
import { checkOrigin, inlineScriptHashes, registerSecurityHeaders, trustProxyHops } from './lib/security.js';
import { escapeHtml } from '@dbb/shared';
import { resolveSession, sessionToken } from './auth/sessions.js';
import { registerGateway } from './gateway/gateway.js';
import { routes } from './routes/index.js';
import { registerFileServing } from './routes/files.js';

export interface BuiltApp {
  app: FastifyInstance;
  shutdownGateway: () => void;
}

export async function buildApp(ctx: Omit<Ctx, 'log'>, opts: { logger?: boolean } = {}): Promise<BuiltApp> {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: ctx.config.logLevel,
            // privacy: request logs never contain IP addresses or query strings
            serializers: {
              req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url.split('?')[0] }),
              res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
            },
          },
    trustProxy: trustProxyHops(ctx.config.trustProxy),
    bodyLimit: 1024 * 1024,
    routerOptions: { maxParamLength: 300 },
  });

  const fullCtx = ctx as Ctx;
  fullCtx.log = app.log;
  app.decorate('ctx', fullCtx);
  app.decorateRequest('auth', null);

  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: ctx.config.limits.uploadBytes, files: 1, fields: 10, fieldSize: 1024, parts: 12 },
  });
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });

  // the built web client (if any): its shell page is served from memory with the instance name filled in
  const webDir = ctx.config.webDir ? path.resolve(ctx.config.webDir) : null;
  const indexHtml =
    webDir && existsSync(path.join(webDir, 'index.html'))
      ? readFileSync(path.join(webDir, 'index.html'), 'utf8').replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(ctx.config.appName)}</title>`)
      : null;
  registerSecurityHeaders(app, ctx.config.livekit?.url ?? null, ctx.config.secureCookies, indexHtml ? inlineScriptHashes(indexHtml) : []);

  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/')) checkOrigin(req, ctx.config.publicUrl);
    if (req.url.startsWith('/api/') || req.url.startsWith('/gateway')) {
      req.auth = await resolveSession(fullCtx, sessionToken(req));
    }
  });

  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) {
      if (err.status === 429 && (err.details as { retryAfter?: number })?.retryAfter) {
        reply.header('Retry-After', String((err.details as { retryAfter: number }).retryAfter));
      }
      return reply.code(err.status).send({ error: err.message, code: err.code, details: err.details });
    }
    const fe = err as FastifyError;
    if (fe.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'File too large', code: 'too_large' });
    if (fe.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ error: 'Request too large', code: 'too_large' });
    if (fe.statusCode && fe.statusCode < 500) {
      return reply.code(fe.statusCode).send({ error: fe.message, code: fe.code ?? 'bad_request' });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'Something went wrong on our end', code: 'internal' });
  });

  await app.register(routes, { prefix: '/api' });
  registerFileServing(app);
  const gw = registerGateway(app);

  if (webDir && indexHtml) {
    await app.register(fastifyStatic, {
      root: webDir,
      wildcard: false,
      index: false,
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}_app${path.sep}immutable${path.sep}`)) {
          res.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.header('Cache-Control', 'no-cache');
        }
      },
    });
    app.get('/*', async (req, reply) => {
      const p = (req.params as { '*': string })['*'];
      if (p && p !== 'index.html' && !p.includes('..') && existsSync(path.join(webDir, p)) && path.extname(p)) return reply.sendFile(p);
      return reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').send(indexHtml);
    });
  }

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: 'Not found', code: 'not_found' });
  });

  return { app, shutdownGateway: gw.shutdown };
}
