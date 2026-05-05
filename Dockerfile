FROM oven/bun:1.3.9 AS deps
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS build
WORKDIR /app

COPY tsconfig.json ./
COPY drizzle ./drizzle
COPY src ./src
RUN bun run build

FROM oven/bun:1.3.9 AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATABASE_URL=/data/opengecko.db

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY drizzle ./drizzle

EXPOSE 3000

CMD ["bun", "dist/src/server.js"]
