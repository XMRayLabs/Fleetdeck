FROM node:24-bookworm-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/remote-gateway/package.json ./packages/remote-gateway/
RUN npm ci

COPY packages/backend/src ./packages/backend/src
COPY packages/backend/tsconfig.json ./packages/backend/
COPY packages/backend/html-presets ./packages/backend/html-presets
COPY scripts/copy-backend-locales.mjs ./scripts/copy-backend-locales.mjs
RUN npm run build --workspace=@fleetdeck/backend

FROM node:24-bookworm-slim AS production-dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/remote-gateway/package.json ./packages/remote-gateway/
RUN npm ci --omit=dev --workspace=@fleetdeck/backend --include-workspace-root=false && npm cache clean --force
# Build against the same libc as the final image, not the prebuilt binary's libc.
RUN npm rebuild sqlite3 --build-from-source --workspace=@fleetdeck/backend

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/packages/backend
# npm workspaces may install production dependencies in either the repository
# root or the workspace directory. Preserve both locations so Node's normal
# module resolution can find every runtime package.
COPY --from=production-dependencies --chown=node:node /app /app
COPY --from=builder --chown=node:node /app/packages/backend/dist ./dist
COPY --from=builder --chown=node:node /app/packages/backend/html-presets ./html-presets
RUN node -e "for (const name of Object.keys(require('./package.json').dependencies || {}).filter((name) => !name.startsWith('@types/'))) require.resolve(name)"
USER node
COPY --chown=node:node scripts/smoke-backend.mjs /app/smoke-backend.mjs
RUN --mount=type=tmpfs,target=/tmp node /app/smoke-backend.mjs
RUN node -e "const db = new (require('sqlite3').Database)(':memory:'); db.serialize(() => { db.run('CREATE TABLE smoke (value INTEGER)'); db.run('INSERT INTO smoke VALUES (42)'); db.get('SELECT value FROM smoke', (err, row) => { if (err || row.value !== 42) process.exit(1); db.close(); }); });"
EXPOSE 3001
CMD ["node", "dist/index.js"]
