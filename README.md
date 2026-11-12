# 随行鲨双向机器人

## 部署教程

### 1. 准备环境变量

```bash
cp .env.example .env
```

按需填写以下配置：

| 变量 | 说明 |
| --- | --- |
| `BOT_TOKEN` | Telegram Bot Token，必填 |
| `BOT_API_ROOT` | Telegram Bot API 根地址，可留空 |
| `BOT_SUPER_ADMIN_ID` | 超级管理员 Telegram 用户 ID |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_DATABASE` | MySQL 连接配置 |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` / `REDIS_DB` | Redis 连接配置 |

### 2. Docker 部署（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

- `initdb` 服务在 MySQL 健康检查通过后执行 `script/initDB.js` 完成建表，成功退出后 `bot` 服务才会启动。
- `docker-compose.yml` 会覆盖 `DB_HOST=mysql`、`DB_USER=root`、`REDIS_HOST=redis`、`REDIS_PORT=6379`，`.env` 中只需填写 `DB_PASSWORD`、`DB_DATABASE`、`BOT_TOKEN` 等业务配置。

常用命令：

```bash
docker compose ps              # 查看服务状态
docker compose logs -f bot     # 查看机器人日志
docker compose down            # 停止并删除容器，保留数据卷
docker compose down -v         # 停止并同时删除 MySQL/Redis/日志数据卷
```

### 3. 本地部署

前置要求：Node.js 20+、可用的 MySQL 与 Redis。

```bash
cp .env.example .env      # 填写配置
npm install               # 安装依赖
npm run initDB            # 初始化数据库表结构
npm run start             # 编译并启动
```

### 4. 机器人使用前提

- 机器人需加入客服群组并设为管理员，开启「管理话题」权限，群组需为话题模式。
- 在目标群组发送 `/id` 获取群组 ID，再由超级管理员在私聊中通过 `/config` 保存群组 ID。

## 开发教程

### 目录结构

```text
script/initDB.js        数据库初始化脚本（建表、补字段）
src/main.ts             程序入口
src/botHandler/         命令与消息处理（start / config / id / bridge）
src/services/           MySQL、Redis、日志、业务数据访问
src/config/             环境变量配置
src/utils/              工具函数（HTML 处理、键盘构建）
```

### 常用脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 开发模式，tsx 热重载运行 `src/main.ts` |
| `npm run build` | 使用 tsc 编译到 `dist/` |
| `npm run typecheck` | 仅做类型检查，不产出文件 |
| `npm run start` | 编译后运行 |
| `npm run initDB` | 初始化/补齐数据库表结构 |

### 开发约定

- 使用 ES Modules 与 `async/await`，所有函数补充 JSDoc 注释。
- 数据库统一通过 `src/services/mysqlService.ts` 的连接池与事务方法访问，SQL 必须参数化。
- 表名前缀统一为 `sk_`，建表语句需与 `script/initDB.js` 保持一致。
- 新增环境变量必须同步更新 `.env.example`。
- 修改后可使用 `npm run typecheck` 做静态校验。