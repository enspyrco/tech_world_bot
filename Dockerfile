## ── Build stage ──────────────────────────────
FROM node:20-slim AS build

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

## ── Runtime stage ────────────────────────────
FROM node:20

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist/ ./dist/

ENV NODE_ENV=production

# Health endpoint (src/server.ts); nothing probes it on OCI today
EXPOSE 8080

CMD ["node", "dist/index.js", "start"]
