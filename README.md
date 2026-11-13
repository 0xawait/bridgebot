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

### 5. 内置关键词配置

内置词库在 `config/builtinKeywords.json` 中按分类维护，每个分类可单独开关，并支持「关键词子串匹配」与「正则匹配」：

```json
{
  "categories": [
    {
      "name": "黑灰产与违规广告",
      "enabled": true,
      "keywords": ["跑分", "四件套", "盘口"],
      "regexes": ["加\\s*(?:微|v|V|薇|威)[信x]?", "(?:日赚|日入|日结)\\s*\\d+"]
    }
  ]
}
```

- `name`：分类名，会显示在「关键词配置」面板中。
- `enabled`：设为 `false` 可整体关闭该分类，无需删词。
- `keywords`：按子串匹配，不区分大小写，适合普通敏感词。
- `regexes`：支持两种写法，`"出\\s*[uU]"` 这样的纯 pattern，或 `"/^@.*bot$/i"` 这样的字面量（自动解析 pattern 与 flags）；统一按不区分大小写编译，`g`/`y` 标记会被剔除，非法正则跳过并输出告警日志。
- 正则会对消息整段内容和每一行分别测试，因此 `^...$` 这类锚点规则可匹配单行内容。
- 关键词与正则共用「关键词消息」这一自动删除规则，规则开启后才会删除。
- 兼容旧的顶层 `keywords` / `regexes` 对象格式与纯字符串数组格式。
- 该文件在机器人启动时读取，修改后需重启机器人。
- 群组守卫配置缓存 `group:guard:<chatId>` 有效期为 10 分钟，重启后若未立即生效，可等待缓存过期或手动删除对应 Key。
- Docker 部署时 `docker-compose.yml` 已将 `./config` 挂载到容器 `/app/config`，修改后执行 `docker compose restart bot` 即可。
- 内置词库对所有群组统一生效；单群组的自定义关键词仍在「群组管理 → 关键词」面板中维护。

词库维护建议：

- 避免使用 `兼职`、`招聘`、`客服`、`代理`、`全套`、`网络` 这类泛词，正常业务对话会大量误杀，改用带上下文的精确正则（如 `加\s*(微信|vx|v)`）。
- 条目中不要保留 `/`、`@`、`=`、`*`、空格等列表切分残留符号，这类写法几乎不可能命中原文。
- 新增词条优先放进对应分类，便于按业务场景整体开关。

## 开发教程

### 目录结构

```text
script/initDB.js        数据库初始化脚本（建表、补字段）
config/                 内置关键词配置（builtinKeywords.json）
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

## 数据库变更记录

### 2026-11-13 新增群组管理数据表

```sql
CREATE TABLE IF NOT EXISTS `sk_group` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',
  `chat_id` bigint NOT NULL COMMENT '群组 ID',
  `title` varchar(255) NOT NULL DEFAULT '' COMMENT '群组标题',
  `username` varchar(64) NOT NULL DEFAULT '' COMMENT '群组公开用户名，无公开用户名时为空串',
  `type` enum('group','supergroup') NOT NULL DEFAULT 'supergroup' COMMENT '群组类型',
  `status` enum('enable','disable') NOT NULL DEFAULT 'enable' COMMENT '群组状态：enable=机器人已在群内，disable=机器人已退出',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_chat_id` (`chat_id`),
  KEY `idx_status_created` (`status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='机器人已加入群组';
```

### 2026-11-13 群组管理新增自动删除规则字段

```sql
ALTER TABLE `sk_group`
  ADD COLUMN `del_keyword` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '关键词消息删除：enable=开启，disable=关闭' AFTER `status`,
  ADD COLUMN `del_link` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '链接消息删除：enable=开启，disable=关闭' AFTER `del_keyword`,
  ADD COLUMN `del_forward` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '转发消息删除：enable=开启，disable=关闭' AFTER `del_link`,
  ADD COLUMN `del_sticker` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '贴纸消息删除：enable=开启，disable=关闭' AFTER `del_forward`,
  ADD COLUMN `del_photo` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '图片消息删除：enable=开启，disable=关闭' AFTER `del_sticker`,
  ADD COLUMN `del_video` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '视频消息删除：enable=开启，disable=关闭' AFTER `del_photo`,
  ADD COLUMN `del_file` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '文件消息删除：enable=开启，disable=关闭' AFTER `del_video`;
```

### 2026-11-13 新增群组关键词过滤表

```sql
CREATE TABLE IF NOT EXISTS `sk_group_keyword` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',
  `chat_id` bigint NOT NULL COMMENT '群组 ID',
  `keyword` varchar(64) NOT NULL COMMENT '关键词',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_chat_keyword` (`chat_id`, `keyword`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='群组关键词过滤配置';
```

### 2026-11-13 群组管理新增内联/引用/身份/名片规则字段

```sql
ALTER TABLE `sk_group`
  ADD COLUMN `del_inline` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '内联消息删除：enable=开启，disable=关闭' AFTER `del_file`,
  ADD COLUMN `del_reply_chat` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '引用频道或群组消息删除：enable=开启，disable=关闭' AFTER `del_inline`,
  ADD COLUMN `del_sender_chat` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '频道或群组身份消息删除：enable=开启，disable=关闭' AFTER `del_reply_chat`,
  ADD COLUMN `del_contact` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '名片消息删除：enable=开启，disable=关闭' AFTER `del_sender_chat`;
```

### 2026-11-13 新增反刷屏长文本配置与白名单表

```sql
ALTER TABLE `sk_group`
  ADD COLUMN `del_long_text` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '长文本消息删除：enable=开启，disable=关闭' AFTER `del_contact`,
  ADD COLUMN `max_text_length` int unsigned NOT NULL DEFAULT 500 COMMENT '长文本删除阈值（字符数）' AFTER `del_long_text`;

CREATE TABLE IF NOT EXISTS `sk_group_whitelist` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',
  `chat_id` bigint NOT NULL COMMENT '群组 ID',
  `user_id` bigint NOT NULL COMMENT '白名单用户 ID',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_chat_user` (`chat_id`, `user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='群组白名单用户';
```