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

### 4. 一键部署
```bash
git clone https://github.com/0xawait/bridgebot.git && cd bridgebot && printf '%s\n' 'BOT_TOKEN=替换为机器人token' 'BOT_SUPER_ADMIN_ID=替换为超级管理员id' 'DB_PASSWORD=bridgebot' 'DB_DATABASE=bridgebot' > .env && docker compose up -d --build
```

## 开发说明

### 目录结构

```text
script/initDB.js        数据库初始化脚本（建表、补字段）
config/                 内置关键词配置（builtinKeywords.json）
static/img/             默认广告图片（ad.png）
src/main.ts             程序入口
src/botHandler/         命令与消息处理（start / config / ad / id / bridge）
src/services/           MySQL、Redis、日志、业务数据访问、广告调度
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

### 数据库变更记录

新增群组自动删除规则「访客机器人消息」，为 `sk_group` 增加字段：

```sql
ALTER TABLE `sk_group`
  ADD COLUMN `del_guest_bot` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '访客机器人消息删除：enable=开启，disable=关闭' AFTER `del_inline`;
```

新增定时广告推送模块（超级管理员 `/ad` 配置），创建广告配置表与广告按钮表：

```sql
CREATE TABLE IF NOT EXISTS `sk_ad_config` (
  `id` tinyint unsigned NOT NULL DEFAULT 1 COMMENT '主键，固定为 1（单条广告）',
  `text` text NOT NULL COMMENT '广告文字，支持 HTML，长期有效',
  `image_file_id` varchar(255) NOT NULL DEFAULT '' COMMENT '广告图片 file_id，空串表示使用项目默认图片',
  `push_minute` tinyint unsigned NOT NULL DEFAULT 0 COMMENT '每小时推送分钟档位，只允许 0 或 30',
  `next_push_at` datetime DEFAULT NULL COMMENT '下次推送时间',
  `last_push_at` datetime DEFAULT NULL COMMENT '最近一次推送时间',
  `status` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '推送状态：enable=开启，disable=暂停',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  KEY `idx_status_next_push` (`status`, `next_push_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='定时广告配置';

CREATE TABLE IF NOT EXISTS `sk_ad_button` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',
  `text` varchar(64) NOT NULL COMMENT '按钮文字',
  `url` varchar(512) NOT NULL COMMENT '按钮跳转链接',
  `row_index` int unsigned NOT NULL DEFAULT 0 COMMENT '所在行序号，同一行序号的按钮展示在同一行',
  `sort_order` int unsigned NOT NULL DEFAULT 0 COMMENT '行内展示顺序',
  `expire_at` datetime DEFAULT NULL COMMENT '按钮到期时间，NULL 表示永久有效',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT '定时广告按钮';
```