import type { FastifyInstance } from 'fastify';
import authRoutes from './auth.js';
import meRoutes from './me.js';
import profileRoutes from './profiles.js';
import relationshipRoutes from './relationships.js';
import guildRoutes from './guilds.js';
import memberRoutes from './members.js';
import roleRoutes from './roles.js';
import channelRoutes from './channels.js';
import messageRoutes from './messages.js';
import searchRoutes from './search.js';
import personalRoutes from './personal.js';
import communityRoutes from './community.js';
import activityRoutes from './activities.js';
import lookupRoutes from './lookup.js';
import adminRoutes from './admin.js';

export async function routes(app: FastifyInstance) {
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(profileRoutes);
  await app.register(relationshipRoutes);
  await app.register(guildRoutes);
  await app.register(memberRoutes);
  await app.register(roleRoutes);
  await app.register(channelRoutes);
  await app.register(messageRoutes);
  await app.register(searchRoutes);
  await app.register(personalRoutes);
  await app.register(communityRoutes);
  await app.register(activityRoutes);
  await app.register(lookupRoutes);
  await app.register(adminRoutes);
  app.get('/health', async () => ({ ok: true }));
}
