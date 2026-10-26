import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appCsp, inlineScriptHashes } from '../src/lib/security.js';

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
