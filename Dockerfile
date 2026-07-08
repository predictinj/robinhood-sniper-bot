# ---- build stage ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY tests ./tests
RUN npm run build && npm prune --omit=dev

# ---- runtime stage ----
FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY docs ./docs
# SQLite data lives here — mount a volume to persist it
RUN mkdir -p /app/data
VOLUME ["/app/data"]
ENV DB_PATH=/app/data/bot.db
# default: long-running scanner + pipeline in whatever MODE the env provides (paper by default)
CMD ["node", "dist/src/index.js"]
