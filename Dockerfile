# Pinned by digest-less tag plus a lockfile; bump deliberately.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js ./
COPY plugins/ ./plugins/

ENV DOCS_ROOT=/docs \
    PORT=8080 \
    HOST=0.0.0.0 \
    NODE_ENV=production

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/_healthz || exit 1

CMD ["node", "server.js"]
