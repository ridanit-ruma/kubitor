# syntax=docker/dockerfile:1

# kubitor ships no native dependency: SQLite is Node's own `node:sqlite`, so
# there is no compiler in this image and no install script to allow.
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
RUN pnpm install --frozen-lockfile --filter @kubitor/server... --filter @kubitor/shared

COPY shared/ shared/
COPY server/ server/
RUN pnpm --filter @kubitor/shared build && pnpm --filter @kubitor/server build

# `--legacy` keeps the deployed tree self-contained rather than symlinked back
# into the workspace store, which does not exist in the runtime image.
RUN pnpm deploy --filter @kubitor/server --prod --legacy /out

FROM node:26-alpine
WORKDIR /app

# What this build is, so the dashboard can name its own version rather than
# borrowing the cluster's. Supplied by CI as the commit it was built from.
ARG KUBITOR_VERSION=dev
ENV KUBITOR_VERSION=$KUBITOR_VERSION
ENV NODE_ENV=production

COPY --from=build /out /app

# The database lives on a volume; the process itself needs nothing writable.
RUN mkdir -p /var/lib/kubitor && chown -R node:node /var/lib/kubitor
USER node

EXPOSE 3001
CMD ["node", "dist/main.js"]
