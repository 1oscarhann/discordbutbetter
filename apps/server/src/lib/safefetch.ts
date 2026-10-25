import dns from 'node:dns';
import ipaddr from 'ipaddr.js';
import { Agent, request } from 'undici';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * Server-side fetching for link previews and the image proxy, hardened against SSRF:
 * - http/https only, standard ports only
 * - every DNS answer (and literal IPs) must be public unicast — no private, loopback, link-local,
 *   CGNAT, metadata (169.254.169.254), multicast, IPv4-mapped tricks...
 * - redirects followed manually (max 4) and re-validated each hop
 * - hard caps on time and bytes
 */

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

export function isPublicAddress(addr: string): boolean {
  if (!ipaddr.isValid(addr)) return false;
  let ip = ipaddr.parse(addr);
  if (ip.kind() === 'ipv6' && (ip as ipaddr.IPv6).isIPv4MappedAddress()) ip = (ip as ipaddr.IPv6).toIPv4Address();
  return ip.range() === 'unicast';
}

let allowPrivate = false;
export function setAllowPrivateFetch(v: boolean) {
  allowPrivate = v;
}

function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  cb: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err, '');
    const list = addrs as dns.LookupAddress[];
    const ok = allowPrivate ? list : list.filter((a) => isPublicAddress(a.address));
    if (!ok.length) {
      const e = Object.assign(new Error(`Blocked address for ${hostname}`), { code: 'EBLOCKED' });
      return cb(e, '');
    }
    if (options.all) return cb(null, ok);
    cb(null, ok[0]!.address, ok[0]!.family);
  });
}

const agent = new Agent({
  connect: { lookup: guardedLookup as never, timeout: 5000 },
  headersTimeout: 6000,
  bodyTimeout: 8000,
  maxRedirections: 0,
} as ConstructorParameters<typeof Agent>[0]);

export class FetchBlocked extends Error {}

function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchBlocked('bad url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchBlocked('scheme');
  if (u.username || u.password) throw new FetchBlocked('credentials');
  if (!ALLOWED_PORTS.has(u.port)) throw new FetchBlocked('port');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host) && !allowPrivate && !isPublicAddress(host)) throw new FetchBlocked('private ip');
  if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local'))) {
    throw new FetchBlocked('local host');
  }
  return u;
}

export interface FetchResult {
  status: number;
  url: string;
  contentType: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
}

export async function safeFetch(
  rawUrl: string,
  opts: { maxBytes: number; accept: string; timeoutMs?: number; userAgent: string; stopAtLimit?: boolean },
): Promise<FetchResult> {
  let url = checkUrl(rawUrl);
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 8000);
  for (let hop = 0; hop < 5; hop++) {
    const res = await request(url, {
      method: 'GET',
      dispatcher: agent,
      signal,
      headers: {
        'user-agent': opts.userAgent,
        accept: opts.accept,
        'accept-language': 'en;q=0.9,*;q=0.5',
      },
    });
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.body.destroy();
      if (hop === 4) throw new FetchBlocked('too many redirects');
      url = checkUrl(new URL(String(res.headers.location), url).toString());
      continue;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    for await (const chunk of res.body) {
      const b = chunk as Buffer;
      total += b.length;
      if (total > opts.maxBytes) {
        truncated = true;
        if (!opts.stopAtLimit) {
          res.body.destroy();
          throw new FetchBlocked('too large');
        }
        chunks.push(b.subarray(0, b.length - (total - opts.maxBytes)));
        res.body.destroy();
        break;
      }
      chunks.push(b);
    }
    const ct = String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    return { status: res.statusCode, url: url.toString(), contentType: ct, headers: res.headers, body: Buffer.concat(chunks), truncated };
  }
  throw new FetchBlocked('too many redirects');
}
