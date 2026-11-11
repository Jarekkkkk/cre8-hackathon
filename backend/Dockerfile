# CRE8 backend（Railway / 任何容器平台）
#
# 為什麼需要它：Railway 的預設 buildpack 會猜 `bun install` + `bun start`，但我們的啟動指令是
# `bun src/index.ts`，而且 `migrate` 必須在啟動前跑一次。寫死在這張 Dockerfile 裡比在平台上
# 點設定可靠（設定會漂移，Dockerfile 進版控）。
FROM oven/bun:1.4-alpine

WORKDIR /app

# 先只複製 manifest：依賴層可以在原始碼變動時重用快取。
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

COPY . .

ENV NODE_ENV=production
# migration 由 `scripts/prepare-deploy.ts` 放進 image 的 /app/migrations
# （`db/migrations` 在隔壁的 repo，正常 build context 拿不到 —— 這個路徑是部署目錄的產物）。
# 容器啟動時自己套用：Railway 的 Postgres 只在私有網路上，本地連不到，所以 migration
# 不可能當成「本機部署步驟」。
ENV MIGRATIONS_DIR=/app/migrations
EXPOSE 8081

# 同一個 image 兩種角色（api / scheduler），由 SERVICE_ROLE 決定 —— 見 docker-entrypoint.sh。
# api 啟動時會自己套用 migration（MIGRATIONS_DIR 指向 image 內的路徑）；
# 多實例同時啟動時 `schema_migrations` 的 advisory lock 讓後到的實例直接跳過。
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh
ENTRYPOINT ["/app/docker-entrypoint.sh"]
