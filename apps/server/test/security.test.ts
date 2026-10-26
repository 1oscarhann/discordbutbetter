import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appCsp, inlineScriptHashes, trustProxyHops } from '../src/lib/security.js';

describe('CSP for the web shell', () => {
  const inline = `\n  { window.x = 1; }\n`;
  const html = `<html><head><script type="module" src="/a.js"></script></head><body><script>${inline}</script></body></html>`;

  it('hashes inline scripts only', () => {
    const hashes = inlineScriptHashes(html);
    const expected = `'sha256-${createHash('sha256').update(inline).digest('base64')}'`;
    expect(hashes).toEqual([expected]);
  });

  it('allows exactly those hashes and never unsafe-inline for scripts', () => {
    const csp = appCsp(null, inlineScriptHashes(html));
    const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src'))!;
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain("'sha256-");
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
  });
});

describe('client IP behind a proxy', () => {
  async function ipFor(hops: number | false, headers: Record<string, string>) {
    const { default: Fastify } = await import('fastify');
    const app = Fastify({ trustProxy: trustProxyHops(hops) });
    app.get('/ip', async (req) => ({ ip: req.ip }));
    const res = await app.inject({ method: 'GET', url: '/ip', remoteAddress: '172.18.0.5', headers });
    await app.close();
    return (res.json() as { ip: string }).ip;
  }

  it('uses the address our proxy appended, not one the client made up', async () => {
    // client sent "X-Forwarded-For: 6.6.6.6", Caddy appended the real address
    expect(await ipFor(1, { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' })).toBe('203.0.113.9');
  });

  it('ignores the header entirely when there is no proxy', async () => {
    expect(await ipFor(false, { 'x-forwarded-for': '6.6.6.6' })).toBe('172.18.0.5');
  });

  it('parses TRUST_PROXY', async () => {
    const { loadConfig } = await import('../src/config.js');
    const base = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;
    expect(loadConfig({ ...base, TRUST_PROXY: 'true' }).trustProxy).toBe(1);
    expect(loadConfig({ ...base, TRUST_PROXY: '2' }).trustProxy).toBe(2);
    expect(loadConfig({ ...base, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig(base).trustProxy).toBe(false);
  });
});
