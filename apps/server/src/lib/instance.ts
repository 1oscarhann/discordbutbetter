import type { InstanceInfo } from '@haunt/shared';
import type { Ctx } from '../context.js';

export function instanceInfo(ctx: Ctx): InstanceInfo {
  const c = ctx.config;
  return {
    name: c.appName,
    registration: c.registration,
    emailEnabled: ctx.mailer.enabled,
    voiceEnabled: !!c.livekit,
    gameSearch: !!(c.igdb || c.rawgKey),
    musicSearch: c.musicSearch,
    limits: {
      uploadBytes: c.limits.uploadBytes,
      avatarBytes: c.limits.avatarBytes,
      emojiBytes: c.limits.emojiBytes,
      emojisPerGuild: c.limits.emojisPerGuild,
      stickersPerGuild: c.limits.stickersPerGuild,
    },
  };
}
