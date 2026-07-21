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
COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/remote-gateway/package.json ./packages/remote-gateway/
RUN npm ci --omit=dev --workspace=@fleetdeck/backend --include-workspace-root=false && npm cache clean --force

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages/backend/dist ./dist
COPY --from=builder --chown=node:node /app/packages/backend/html-presets ./html-presets
USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]
