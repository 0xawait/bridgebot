# 依赖安装阶段：安装全部依赖（含编译期依赖）
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# 构建阶段：编译 TypeScript 到 dist
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 生产依赖阶段：仅保留运行期依赖
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 运行阶段
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    TZ=Asia/Shanghai
WORKDIR /app

# 时区数据，保证日志时间与容器内时间正确
RUN apk add --no-cache tzdata

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY script ./script
COPY config ./config

# 日志目录，使用非 root 用户运行
RUN mkdir -p /app/log && chown -R node:node /app
USER node

CMD ["node", "dist/main.js"]
