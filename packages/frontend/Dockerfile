FROM node:24-bookworm-slim AS builder

WORKDIR /app
ARG VITE_PROJECT_REPOSITORY_URL="https://github.com/XMRayLabs/Fleetdeck"
ENV VITE_PROJECT_REPOSITORY_URL=${VITE_PROJECT_REPOSITORY_URL}
COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/remote-gateway/package.json ./packages/remote-gateway/
RUN npm ci

COPY packages/frontend/src ./packages/frontend/src
COPY packages/frontend/index.html packages/frontend/tsconfig.json packages/frontend/vite.config.ts packages/frontend/icon-plugin.mjs ./packages/frontend/
COPY packages/frontend/public ./packages/frontend/public/
RUN npm run build --workspace=@fleetdeck/frontend

FROM nginxinc/nginx-unprivileged:stable-alpine
COPY --from=builder /app/packages/frontend/dist /usr/share/nginx/html
COPY packages/frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
