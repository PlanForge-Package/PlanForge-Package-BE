# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# 의존성 — 여기만 lockfile 에 의존하므로 소스가 바뀌어도 캐시가 살아남는다.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# 빌드
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN pnpm prisma:generate && pnpm build

# 런타임에 필요 없는 것을 떨궈 이미지와 공격면을 줄인다.
RUN pnpm prune --prod

# ---------------------------------------------------------------------------
# 런타임
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# Prisma 쿼리 엔진이 OpenSSL 을 찾는다. slim 이미지에는 들어 있지 않다.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3001

# root 로 돌리지 않는다. node 이미지에 이미 uid 1000 의 node 사용자가 있다.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x ./docker-entrypoint.sh

USER node
EXPOSE 3001

# 오케스트레이터가 준비 상태를 알 수 있게 한다. 헬스체크는 DB 연결까지 본다.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
