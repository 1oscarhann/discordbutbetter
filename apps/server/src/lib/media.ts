import { open, rm, stat } from 'node:fs/promises';
import sharp, { type Metadata } from 'sharp';
import { fileTypeFromFile } from 'file-type';
import { parseFile } from 'music-metadata';
import type { FilePurposeValue } from '@haunt/shared';
import { Limits } from '@haunt/shared';
import { badRequest } from '../errors.js';

sharp.cache(false);
sharp.concurrency(2);

export interface Processed {
  path: string;
  contentType: string;
  ext: string;
  size: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  animated: boolean;
  kind: 'image' | 'video' | 'audio' | 'other';
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/apng']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const AUDIO_TYPES = new Set([
  'audio/mpeg',
  'audio/ogg',
  'audio/opus',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/flac',
  'audio/x-flac',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
]);

const IMAGE_ONLY: FilePurposeValue[] = [
  'avatar',
  'member_avatar',
  'group_icon',
  'guild_icon',
  'guild_banner',
  'emoji',
  'sticker',
  'widget_photo',
  'game_cover',
  'music_cover',
];

const RESIZE: Partial<Record<FilePurposeValue, { w: number; h: number; fit: 'cover' | 'inside' }>> = {
  avatar: { w: 512, h: 512, fit: 'cover' },
  member_avatar: { w: 512, h: 512, fit: 'cover' },
  group_icon: { w: 512, h: 512, fit: 'cover' },
  guild_icon: { w: 512, h: 512, fit: 'cover' },
  banner: { w: 1920, h: 1080, fit: 'inside' },
  guild_banner: { w: 1920, h: 1080, fit: 'inside' },
  emoji: { w: 128, h: 128, fit: 'inside' },
  sticker: { w: 320, h: 320, fit: 'inside' },
  widget_photo: { w: 1280, h: 1280, fit: 'inside' },
  game_cover: { w: 600, h: 900, fit: 'inside' },
  music_cover: { w: 600, h: 600, fit: 'inside' },
};

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/apng': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

export function sanitiseFilename(name: string, ext: string | null): string {
  let base = name
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '')
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 100);
  if (!base) base = 'file';
  if (ext) {
    const dot = base.lastIndexOf('.');
    const cur = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
    if (cur !== ext && !(ext === 'jpg' && cur === 'jpeg')) base = (dot > 0 ? base.slice(0, dot) : base) + '.' + ext;
  }
  return base;
}

async function durationOf(p: string): Promise<number | null> {
  try {
    const md = await parseFile(p, { duration: true, skipCovers: true });
    return md.format.duration ? Math.round(md.format.duration * 1000) : null;
  } catch {
    return null;
  }
}

/**
 * Phones put GPS coordinates into MP4/MOV files (moov/udta ©xyz, moov/meta). We can't remux without
 * ffmpeg, but we can turn those boxes into `free` boxes and zero them in place — same size, so all
 * chunk offsets stay valid and the video still plays.
 */
export async function scrubMp4Metadata(p: string): Promise<number> {
  const fh = await open(p, 'r+');
  let scrubbed = 0;
  try {
    const { size } = await fh.stat();
    const hdr = Buffer.alloc(16);

    const readBox = async (pos: number): Promise<{ type: string; size: number; header: number } | null> => {
      if (pos + 8 > size) return null;
      await fh.read(hdr, 0, 16, pos);
      let boxSize = hdr.readUInt32BE(0);
      const type = hdr.toString('latin1', 4, 8);
      let header = 8;
      if (boxSize === 1) {
        boxSize = Number(hdr.readBigUInt64BE(8));
        header = 16;
      } else if (boxSize === 0) boxSize = size - pos;
      if (boxSize < header || pos + boxSize > size) return null;
      return { type, size: boxSize, header };
    };

    const kill = async (pos: number, box: { size: number; header: number }) => {
      await fh.write(Buffer.from('free', 'latin1'), 0, 4, pos + 4);
      const zeros = Buffer.alloc(Math.min(65536, box.size - box.header));
      for (let off = box.header; off < box.size; off += zeros.length) {
        await fh.write(zeros, 0, Math.min(zeros.length, box.size - off), pos + off);
      }
      scrubbed++;
    };

    const walk = async (start: number, end: number, depth: number) => {
      let pos = start;
      while (pos < end) {
        const box = await readBox(pos);
        if (!box) return;
        if (box.type === 'udta' || box.type === 'meta' || box.type === 'uuid') {
          await kill(pos, box);
        } else if (depth < 3 && (box.type === 'moov' || box.type === 'trak')) {
          await walk(pos + box.header, pos + box.size, depth + 1);
        }
        pos += box.size;
      }
    };
    await walk(0, size, 0);
  } finally {
    await fh.close();
  }
  return scrubbed;
}

async function processImage(input: string, mime: string, purpose: FilePurposeValue): Promise<Processed> {
  let meta: Metadata;
  try {
    meta = await sharp(input, { animated: true, limitInputPixels: 100_000_000 }).metadata();
  } catch {
    throw badRequest('That image is broken or too big');
  }
  const animated = (meta.pages ?? 1) > 1;
  const resize = RESIZE[purpose];
  const out = input + '.out';

  // APNG: sharp only reads the first frame, so keep the file as-is (PNG has no EXIF/GPS in practice)
  // GIF attachments: re-encoding big GIFs is slow and GIF has no EXIF block, so pass them through
  const passThrough = (mime === 'image/apng' && !resize) || (mime === 'image/gif' && !resize) || (mime === 'image/apng' && purpose === 'sticker');
  if (passThrough) {
    const s = await stat(input);
    return {
      path: input,
      contentType: mime === 'image/apng' ? 'image/png' : mime,
      ext: EXT[mime]!,
      size: s.size,
      width: meta.width ?? null,
      height: animated && meta.pageHeight ? meta.pageHeight : (meta.height ?? null),
      durationMs: null,
      animated: animated || mime === 'image/apng',
      kind: 'image',
    };
  }

  let img = sharp(input, { animated, limitInputPixels: 100_000_000 });
  if (!animated) img = img.rotate(); // apply EXIF orientation before metadata is dropped
  if (resize) img = img.resize(resize.w, resize.h, { fit: resize.fit, withoutEnlargement: resize.fit === 'inside' });

  let outMime = mime;
  if (mime === 'image/jpeg') img = img.jpeg({ quality: 88, mozjpeg: true });
  else if (mime === 'image/png' || mime === 'image/apng') {
    img = img.png({ compressionLevel: 7 });
    outMime = 'image/png';
  } else if (mime === 'image/webp') img = img.webp({ quality: 88, effort: 3 });
  else if (mime === 'image/gif') img = img.gif();
  else if (mime === 'image/avif') {
    // AVIF encoding is very slow on small ARM boards; WebP is close enough
    img = img.webp({ quality: 85, effort: 3 });
    outMime = 'image/webp';
  }
  // sharp drops EXIF/XMP/IPTC unless .withMetadata() is called — which we never do.
  const info = await img.toFile(out);
  await rm(input, { force: true });
  return {
    path: out,
    contentType: outMime,
    ext: EXT[outMime]!,
    size: info.size,
    width: info.width ?? null,
    height: animated && info.pageHeight ? info.pageHeight : (info.height ?? null),
    durationMs: null,
    animated,
    kind: 'image',
  };
}

/** Sniffs the real type and processes an uploaded temp file according to its purpose. */
export async function processUpload(input: string, purpose: FilePurposeValue): Promise<Processed> {
  const ft = await fileTypeFromFile(input);
  let mime = ft?.mime ?? 'application/octet-stream';
  if (mime === 'audio/x-m4a') mime = 'audio/mp4';
  if (mime === 'image/png' && ft?.ext === 'apng') mime = 'image/apng';

  const isImage = IMAGE_TYPES.has(mime);
  const isVideo = VIDEO_TYPES.has(mime);
  const isAudio = AUDIO_TYPES.has(mime);

  if (IMAGE_ONLY.includes(purpose) && !isImage) throw badRequest('That has to be an image (PNG, JPEG, WebP, GIF or AVIF)');
  if (purpose === 'sticker' && !['image/png', 'image/apng', 'image/gif', 'image/webp'].includes(mime)) {
    throw badRequest('Stickers must be PNG, APNG, GIF or WebP');
  }
  if (purpose === 'banner' && !isImage && !(mime === 'video/mp4' || mime === 'video/webm')) {
    throw badRequest('Banners can be an image, a GIF, or a short MP4/WebM video');
  }
  if (purpose === 'profile_song' && !isAudio) throw badRequest('Profile songs must be an audio file (MP3, OGG, M4A, FLAC, WAV)');

  if (isImage) {
    try {
      return await processImage(input, mime, purpose);
    } catch (e) {
      if (purpose !== 'attachment') throw e;
      // an attachment that sharp can't handle still uploads, just as a plain download
      mime = 'application/octet-stream';
    }
  }

  const s = await stat(input);
  if (isVideo || isAudio) {
    if (isVideo && (mime === 'video/mp4' || mime === 'video/quicktime')) await scrubMp4Metadata(input).catch(() => 0);
    const durationMs = await durationOf(input);
    if (purpose === 'banner' && isVideo) {
      if (durationMs === null) throw badRequest("Couldn't read that video's length");
      if (durationMs > Limits.BANNER_VIDEO_SECONDS * 1000 + 500) throw badRequest(`Banner videos can be at most ${Limits.BANNER_VIDEO_SECONDS} seconds`);
    }
    if (purpose === 'profile_song') {
      if (durationMs === null) throw badRequest("Couldn't read that audio file's length");
      if (durationMs > Limits.PROFILE_SONG_SECONDS * 1000 + 500) throw badRequest(`Profile songs can be at most ${Limits.PROFILE_SONG_SECONDS} seconds`);
    }
    return {
      path: input,
      contentType: mime,
      ext: EXT[mime] ?? ft?.ext ?? 'bin',
      size: s.size,
      width: null,
      height: null,
      durationMs,
      animated: false,
      kind: isVideo ? 'video' : 'audio',
    };
  }

  // Everything else: stored as-is and always served as a download.
  return {
    path: input,
    contentType: ft?.mime && !ft.mime.startsWith('image/svg') ? ft.mime : 'application/octet-stream',
    ext: ft?.ext ?? '',
    size: s.size,
    width: null,
    height: null,
    durationMs: null,
    animated: false,
    kind: 'other',
  };
}

/** Types we serve inline (rendered in the browser). Everything else is Content-Disposition: attachment. */
export function inlineSafe(contentType: string): boolean {
  return IMAGE_TYPES.has(contentType) || VIDEO_TYPES.has(contentType) || AUDIO_TYPES.has(contentType);
}

export function maxBytesFor(purpose: FilePurposeValue, limits: { uploadBytes: number; avatarBytes: number; emojiBytes: number }): number {
  switch (purpose) {
    case 'attachment':
      return limits.uploadBytes;
    case 'emoji':
    case 'sticker':
      return limits.emojiBytes;
    case 'profile_song':
      return Math.min(limits.uploadBytes, 15 * 1024 * 1024);
    case 'banner':
      return Math.max(limits.avatarBytes, 30 * 1024 * 1024);
    default:
      return limits.avatarBytes;
  }
}
