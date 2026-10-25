import type { FilePurposeValue, GameRef, GameRefInput, SongRef, SongRefInput } from '@dbb/shared';
import { fileIdFromUrl } from '@dbb/shared';
import type { Ctx } from '../context.js';
import { claimFile, deleteFile, fileUrl } from '../routes/files.js';

/**
 * Tracks file references while saving something that can hold uploads (profile widgets, activities).
 * Files already referenced by the old version are kept; new file ids are claimed; files the new
 * version no longer references are deleted at the end.
 */
export class AssetDiff {
  private before: Set<string>;
  private after = new Set<string>();

  constructor(
    private ctx: Ctx,
    private ownerId: string,
    oldUrls: (string | null | undefined)[],
  ) {
    this.before = new Set(oldUrls.map(fileIdFromUrl).filter((x): x is string => !!x));
  }

  /** Returns the url for a file id, claiming it if it's a new upload. */
  async use(fileId: string, purposes: FilePurposeValue[]): Promise<string> {
    if (this.before.has(fileId)) {
      this.after.add(fileId);
      const [f] = await this.ctx.sql<{ id: string; secret: string; filename: string }[]>`
        SELECT id, secret, filename FROM files WHERE id = ${fileId}`;
      if (f) return fileUrl(f);
    }
    const f = await claimFile(this.ctx, fileId, this.ownerId, purposes);
    this.after.add(fileId);
    return fileUrl(f);
  }

  keepUrl(url: string | null | undefined) {
    const id = fileIdFromUrl(url);
    if (id) this.after.add(id);
  }

  async gameRef(g: GameRefInput): Promise<GameRef> {
    let cover: string | null = null;
    if (g.coverFileId) cover = await this.use(g.coverFileId, ['game_cover']);
    else if (g.coverUrl) cover = g.coverUrl;
    return { name: g.name, source: g.source, sourceId: g.sourceId ?? null, cover };
  }

  async songRef(s: SongRefInput): Promise<SongRef> {
    let cover: string | null = null;
    if (s.coverFileId) cover = await this.use(s.coverFileId, ['music_cover']);
    else if (s.coverUrl) cover = s.coverUrl;
    return { title: s.title, artist: s.artist, cover };
  }

  /** Delete files that were referenced before and aren't anymore. */
  async commit() {
    for (const id of this.before) if (!this.after.has(id)) await deleteFile(this.ctx, id);
  }
}

/** Collects all /files/ urls inside a JSON value. */
export function urlsIn(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('/files/')) out.push(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return out;
}
