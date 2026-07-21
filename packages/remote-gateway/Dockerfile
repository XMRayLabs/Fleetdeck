FROM node:24-bookworm-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/remote-gateway/package.json ./packages/remote-gateway/
RUN npm ci
COPY packages/remote-gateway/src ./packages/remote-gateway/src
COPY packages/remote-gateway/tsconfig.json packages/remote-gateway/guacamole-lite.d.ts ./packages/remote-gateway/
RUN npm run build --workspace=@fleetdeck/remote-gateway

FROM node:24-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/remote-gateway/package.json ./packages/remote-gateway/
RUN npm ci --omit=dev --workspace=@fleetdeck/remote-gateway --include-workspace-root=false && npm cache clean --force

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages/remote-gateway/dist ./dist
USER node
EXPOSE 9090 8080
CMD ["node", "dist/server.js"]
