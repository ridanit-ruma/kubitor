# syntax=docker/dockerfile:1

FROM node:26-alpine AS build
WORKDIR /repo

RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
COPY agent/package.json agent/
RUN pnpm install --frozen-lockfile --filter @kubitor/client... --filter @kubitor/shared

COPY shared/ shared/
COPY client/ client/
RUN pnpm --filter @kubitor/shared build && pnpm --filter @kubitor/client build

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production

# Next's standalone output traces from the workspace root, so the tree keeps the
# repository's shape.
COPY --from=build /repo/client/.next/standalone ./
COPY --from=build /repo/client/.next/static ./client/.next/static

USER node
EXPOSE 3000
CMD ["node", "client/server.js"]
