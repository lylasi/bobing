# 月满博饼 · 单实例生产镜像（Node 24 + SQLite 文件数据库）
#
# 构建阶段：安装全部依赖并执行完整前后端构建（Vite 前端 + tsc 后端）。
# 运行阶段：只保留生产依赖与 dist/dist-server，数据目录挂载为卷。
#
# 注意：本版本使用 node:sqlite 的单文件数据库，只能启动一个副本。

# ---------- 构建阶段 ----------
FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.base.json tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY shared ./shared
COPY server ./server
COPY src ./src
RUN npm run build

# ---------- 运行阶段 ----------
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3001 \
    DATA_DIR=/app/data

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3001
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 直接运行构建产物，不在容器里重复调用 tsc（因此运行阶段不需要 devDependencies）
CMD ["node", "dist-server/server/index.js"]
