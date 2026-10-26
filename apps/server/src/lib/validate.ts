import type { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { badRequest, unauthorized } from '../errors.js';
import type { Auth } from '../context.js';
import { zId } from '@haunt/shared';

/** Parse with a zod schema or throw a 400 listing what's wrong. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    const first = issues[0];
    throw badRequest(first ? (first.path ? `${first.path}: ${first.message}` : first.message) : 'Invalid input', issues);
  }
  return r.data;
}

export function requireAuth(req: FastifyRequest): Auth {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/** Validates a snowflake path param. */
export function idParam(req: FastifyRequest, name: string): string {
  const v = (req.params as Record<string, unknown>)[name];
  const r = zId.safeParse(v);
  if (!r.success) throw badRequest(`Invalid ${name}`);
  return r.data;
}

export function strParam(req: FastifyRequest, name: string, max = 200): string {
  const v = (req.params as Record<string, unknown>)[name];
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw badRequest(`Invalid ${name}`);
  return v;
}
