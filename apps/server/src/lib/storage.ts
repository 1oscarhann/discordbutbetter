import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, copyFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Config } from '../config.js';

export interface Range {
  start: number;
  end: number; // inclusive
}

export interface Storage {
  /** Moves/uploads a local temp file into storage under `key`. The temp file is consumed. */
  putFile(key: string, localPath: string, contentType: string): Promise<void>;
  get(key: string, range?: Range): Promise<Readable>;
  size(key: string): Promise<number | null>;
  delete(key: string): Promise<void>;
}

function safeKey(key: string): string {
  if (!/^[a-z0-9/_.-]+$/i.test(key) || key.includes('..')) throw new Error('bad storage key');
  return key;
}

export class LocalStorage implements Storage {
  constructor(private root: string) {}

  private p(key: string) {
    return path.join(this.root, safeKey(key));
  }

  async putFile(key: string, localPath: string): Promise<void> {
    const dest = this.p(key);
    await mkdir(path.dirname(dest), { recursive: true });
    try {
      await rename(localPath, dest);
    } catch (e) {
      // different filesystem (tmp on another mount): copy then delete
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      await copyFile(localPath, dest);
      await rm(localPath, { force: true });
    }
  }

  async get(key: string, range?: Range): Promise<Readable> {
    return createReadStream(this.p(key), range ? { start: range.start, end: range.end } : undefined);
  }

  async size(key: string): Promise<number | null> {
    try {
      return (await stat(this.p(key))).size;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.p(key), { force: true });
  }
}

export class S3Storage implements Storage {
  private client: S3Client;
  constructor(private cfg: Config['storage']['s3']) {
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint || undefined,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    });
  }

  async putFile(key: string, localPath: string, contentType: string): Promise<void> {
    const body = createReadStream(localPath);
    try {
      await new Upload({
        client: this.client,
        params: { Bucket: this.cfg.bucket, Key: safeKey(key), Body: body, ContentType: contentType },
        queueSize: 2,
        partSize: 8 * 1024 * 1024,
      }).done();
    } finally {
      await rm(localPath, { force: true });
    }
  }

  async get(key: string, range?: Range): Promise<Readable> {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.cfg.bucket,
        Key: safeKey(key),
        Range: range ? `bytes=${range.start}-${range.end}` : undefined,
      }),
    );
    return res.Body as Readable;
  }

  async size(key: string): Promise<number | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: safeKey(key) }));
      return res.ContentLength ?? null;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: safeKey(key) }));
  }
}

export function createStorage(config: Config): Storage {
  if (config.storage.driver === 's3') return new S3Storage(config.storage.s3);
  return new LocalStorage(path.resolve(config.storage.path));
}

/** Writes a stream to a temp file, enforcing a byte limit. Returns bytes written, or throws 'too_large'. */
export async function streamToTemp(stream: Readable, tmpPath: string, maxBytes: number): Promise<number> {
  await mkdir(path.dirname(tmpPath), { recursive: true });
  let total = 0;
  const counter = async function* (src: AsyncIterable<Buffer>) {
    for await (const chunk of src) {
      total += chunk.length;
      if (total > maxBytes) throw Object.assign(new Error('too_large'), { code: 'too_large' });
      yield chunk;
    }
  };
  try {
    await pipeline(stream, counter, createWriteStream(tmpPath));
  } catch (e) {
    await rm(tmpPath, { force: true });
    throw e;
  }
  return total;
}
