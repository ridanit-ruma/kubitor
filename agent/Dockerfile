# syntax=docker/dockerfile:1

FROM node:26-alpine AS build
WORKDIR /repo

# Node 26 images no longer bundle corepack; pin pnpm to the version in
# package.json's packageManager field.
RUN npm install -g pnpm@11.3.0
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
COPY agent/package.json agent/
RUN pnpm install --frozen-lockfile --filter @kubitor/agent...

COPY agent/ agent/
RUN pnpm --filter @kubitor/agent build
RUN pnpm deploy --filter @kubitor/agent --prod --legacy /out

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /out /app

USER node
CMD ["node", "dist/main.js"]
