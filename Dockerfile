# syntax=docker/dockerfile:1.7
# Один образ для API и воркера (роль задаётся переменной ROLE).

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY webapp/package.json webapp/
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY server server
COPY webapp webapp
RUN npm run build -w webapp && npm run build -w server

FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY webapp/package.json webapp/
RUN npm ci --omit=dev --workspace server --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    WEBAPP_DIST=/app/webapp/dist
WORKDIR /app
# Шрифт с кириллицей нужен только mock-генератору (подписи на заглушках).
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/webapp/dist ./webapp/dist
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/main.js"]
