# syntax=docker/dockerfile:1
# One image: the API/gateway server, which also serves the built web client.

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /src
RUN npm install -g pnpm@10.28.0

# dependency layer (cached until a package.json or the lockfile changes)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web apps/web
RUN pnpm --filter @dbb/web build \
 && pnpm --filter @dbb/server build \
 && pnpm --filter @dbb/server deploy --prod --legacy /out

# ---------- runtime ----------
FROM node:22-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    WEB_DIR=/app/web \
    STORAGE_PATH=/data/files
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /src/apps/server/dist ./dist
COPY --from=build /src/apps/server/migrations ./migrations
COPY --from=build /src/apps/web/build ./web
RUN mkdir -p /data/files && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/instance').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.js"]
