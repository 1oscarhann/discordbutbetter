import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { FilePurpose, type FilePurposeValue } from '@dbb/shared';
import type { Ctx } from '../context.js';
import type { FileRow } from '../rows.js';
import { badRequest, notFound, tooLarge } from '../errors.js';
import { randomToken, snowflake } from '../ids.js';
import { inlineSafe, maxBytesFor, processUpload, sanitiseFilename } from '../lib/media.js';
import { streamToTemp } from '../lib/storage.js';
import { limitPreset } from '../lib/ratelimit.js';
import { requireAuth } from '../lib/validate.js';

export interface UploadedFile {
  id: string;
  url: string;
  filename: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  animated: boolean;
  purpose: FilePurposeValue;
}

export function fileUrl(f: Pick<FileRow, 'id' | 'secret' | 'filename'>): string {
  return `/files/${f.id}/${f.secret}/${encodeURIComponent(f.filename)}`;
}

export function fileIdFromUrl(url: string | null | undefined): string | null {
  const m = url?.match(/^\/files\/(\d+)\//);
  return m?.[1] ?? null;
}

/** Marks a file as used. It must belong to `ownerId`, be unclaimed and have the right purpose. */
export async function claimFile(
  ctx: Pick<Ctx, 'sql'>,
  fileId: string,
  ownerId: string,
  purposes: FilePurposeValue[],
): Promise<FileRow> {
  const [f] = await ctx.sql<FileRow[]>`
    UPDATE files SET claimed = true
    WHERE id = ${fileId} AND owner_id = ${ownerId} AND NOT claimed AND purpose = ANY(${purposes})
    RETURNING *`;
  if (!f) throw badRequest('That upload is missing, already used, or the wrong kind of file. Upload it again.');
  return f;
}

/** Deletes a stored file (row + bytes). Safe to call with a url of an asset that isn't ours. */
export async function deleteFile(ctx: Ctx, fileIdOrUrl: string | null | undefined): Promise<void> {
  if (!fileIdOrUrl) return;
  const id = /^\d+$/.test(fileIdOrUrl) ? fileIdOrUrl : fileIdFromUrl(fileIdOrUrl);
  if (!id) return;
  const [f] = await ctx.sql<FileRow[]>`DELETE FROM files WHERE id = ${id} RETURNING *`;
  if (f) await ctx.storage.delete(f.storage_key).catch((e: Error) => ctx.log.warn({ err: e }, 'storage delete failed'));
}

export async function handleUpload(ctx: Ctx, req: FastifyRequest): Promise<UploadedFile> {
  const auth = requireAuth(req);
  await limitPreset(req, 'upload');
  const purpose = (req.query as { purpose?: string }).purpose as FilePurposeValue;
  if (!FilePurpose.includes(purpose)) throw badRequest('Unknown upload purpose');
  if (!req.isMultipart()) throw badRequest('Expected multipart/form-data');

  const part = await req.file();
  if (!part) throw badRequest('No file');
  const max = maxBytesFor(purpose, ctx.config.limits);
  const tmp = path.join(tmpdir(), 'dbb-upload', `${snowflake()}.part`);
  let size: number;
  try {
    size = await streamToTemp(part.file, tmp, max);
  } catch (e) {
    if ((e as { code?: string }).code === 'too_large' || part.file.truncated) {
      throw tooLarge(`Max size for this is ${Math.round(max / 1024 / 1024)} MB`);
    }
    throw e;
  }
  if (part.file.truncated) {
    await rm(tmp, { force: true });
    throw tooLarge(`Max size for this is ${Math.round(max / 1024 / 1024)} MB`);
  }
  if (size === 0) {
    await rm(tmp, { force: true });
    throw badRequest('Empty file');
  }

  let processed;
  try {
    processed = await processUpload(tmp, purpose);
  } catch (e) {
    await rm(tmp, { force: true });
    await rm(tmp + '.out', { force: true });
    throw e;
  }

  const id = snowflake();
  const secret = randomToken(16);
  const filename = sanitiseFilename(part.filename || 'file', processed.ext || null);
  const storageKey = `${purpose}/${id.slice(-2)}/${id}`;
  try {
    await ctx.storage.putFile(storageKey, processed.path, processed.contentType);
  } catch (e) {
    await rm(processed.path, { force: true });
    throw e;
  }
  await ctx.sql`
    INSERT INTO files (id, secret, owner_id, purpose, filename, content_type, size, width, height, duration_ms, animated, storage_key)
    VALUES (${id}, ${secret}, ${auth.userId}, ${purpose}, ${filename}, ${processed.contentType}, ${processed.size},
            ${processed.width}, ${processed.height}, ${processed.durationMs}, ${processed.animated}, ${storageKey})`;
  return {
    id,
    url: fileUrl({ id, secret, filename }),
    filename,
    contentType: processed.contentType,
    size: processed.size,
    width: processed.width,
    height: processed.height,
    durationMs: processed.durationMs,
    animated: processed.animated,
    purpose,
  };
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '' && m[2] !== '') {
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) return 'invalid';
  return { start, end };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function registerFileServing(app: FastifyInstance) {
  const ctx = app.ctx;
  const handler = async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
    const { id, secret } = req.params as { id: string; secret: string };
    if (!/^\d{1,20}$/.test(id) || !/^[A-Za-z0-9_-]{10,64}$/.test(secret)) throw notFound();
    const [f] = await ctx.sql<FileRow[]>`SELECT * FROM files WHERE id = ${id}`;
    if (!f || !safeEqual(f.secret, secret)) throw notFound();

    const size = Number(f.size);
    const inline = inlineSafe(f.content_type);
    reply.header('Content-Type', inline ? f.content_type : 'application/octet-stream');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    reply.header('Accept-Ranges', 'bytes');
    const dispName = f.filename.replace(/["\\\r\n]/g, '_');
    reply.header(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${dispName.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
    );

    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') {
      reply.header('Content-Range', `bytes */${size}`);
      return reply.code(416).send();
    }
    if (req.method === 'HEAD') {
      reply.header('Content-Length', String(size));
      return reply.send();
    }
    if (range) {
      reply.code(206);
      reply.header('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      reply.header('Content-Length', String(range.end - range.start + 1));
      return reply.send(await ctx.storage.get(f.storage_key, range));
    }
    reply.header('Content-Length', String(size));
    return reply.send(await ctx.storage.get(f.storage_key));
  };
  app.get('/files/:id/:secret', handler);
  app.get('/files/:id/:secret/*', handler);
}

