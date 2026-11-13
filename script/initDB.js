import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

/** 建表语句，与线上结构保持一致 */
const CREATE_TABLE_SQLS = [
    `CREATE TABLE IF NOT EXISTS \`sk_welcome_config\` (
  \`id\` tinyint unsigned NOT NULL DEFAULT 1 COMMENT '主键，固定为 1（单行配置）',
  \`content\` text NOT NULL COMMENT '欢迎语文字，支持 HTML',
  \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='欢迎语文字配置'`,
    `CREATE TABLE IF NOT EXISTS \`sk_welcome_button\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',
  \`text\` varchar(64) NOT NULL COMMENT '按钮文字',
  \`url\` varchar(512) NOT NULL COMMENT '按钮跳转链接',
  \`row_index\` int unsigned NOT NULL DEFAULT 0 COMMENT '所在行序号，同一行序号的按钮展示在同一行',
  \`sort_order\` int unsigned NOT NULL DEFAULT 0 COMMENT '行内展示顺序',
  \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='欢迎语按钮配置'`,
    `CREATE TABLE IF NOT EXISTS \`sk_group_config\` (
  \`id\` tinyint unsigned NOT NULL DEFAULT 1 COMMENT '主键，固定为 1（单行配置）',
  \`chat_id\` bigint NOT NULL COMMENT '配置的群组 ID',
  \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='群组配置'`,
    `CREATE TABLE IF NOT EXISTS \`sk_group\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',
  \`chat_id\` bigint NOT NULL COMMENT '群组 ID',
  \`title\` varchar(255) NOT NULL DEFAULT '' COMMENT '群组标题',
  \`username\` varchar(64) NOT NULL DEFAULT '' COMMENT '群组公开用户名，无公开用户名时为空串',
  \`type\` enum('group','supergroup') NOT NULL DEFAULT 'supergroup' COMMENT '群组类型',
  \`status\` enum('enable','disable') NOT NULL DEFAULT 'enable' COMMENT '群组状态：enable=机器人已在群内，disable=机器人已退出',
  \`del_keyword\` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '关键词消息删除：enable=开启，disable=关闭',
  \`del_link\` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '链接消息删除：enable=开启，disable=关闭',
  \`del_forward\` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '转发消息删除：enable=开启，disable=关闭',
  \`del_sticker\` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '贴纸消息删除：enable=开启，disable=关闭',
  \`del_photo\` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '图片消息删除：enable=开启，disable=关闭',
  \`del_video\` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '视频消息删除：enable=开启，disable=关闭',
  \`del_file\` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '文件消息删除：enable=开启，disable=关闭',
  \`del_inline\` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '内联消息删除：enable=开启，disable=关闭',
  \`del_reply_chat\` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '引用频道或群组消息删除：enable=开启，disable=关闭',
  \`del_sender_chat\` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '频道或群组身份消息删除：enable=开启，disable=关闭',
  \`del_contact\` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '名片消息删除：enable=开启，disable=关闭',
  \`del_long_text\` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '长文本消息删除：enable=开启，disable=关闭',
  \`max_text_length\` int unsigned NOT NULL DEFAULT 500 COMMENT '长文本删除阈值（字符数）',
  \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_chat_id\` (\`chat_id\`),
  KEY \`idx_status_created\` (\`status\`, \`created_at\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='机器人已加入群组'`,
    `CREATE TABLE IF NOT EXISTS \`sk_group_keyword\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',
  \`chat_id\` bigint NOT NULL COMMENT '群组 ID',
  \`keyword\` varchar(64) NOT NULL COMMENT '关键词',
  \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_chat_keyword\` (\`chat_id\`, \`keyword\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='群组关键词过滤配置'`,
    `CREATE TABLE IF NOT EXISTS \`sk_group_whitelist\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',
  \`chat_id\` bigint NOT NULL COMMENT '群组 ID',
  \`user_id\` bigint NOT NULL COMMENT '白名单用户 ID',
  \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_chat_user\` (\`chat_id\`, \`user_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='群组白名单用户'`,
    `CREATE TABLE IF NOT EXISTS \`sk_user_topic\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',
  \`user_id\` bigint NOT NULL COMMENT 'Telegram 用户 ID',
  \`chat_id\` bigint NOT NULL COMMENT '话题所在群组 ID',
  \`message_thread_id\` bigint NOT NULL COMMENT '话题（Topic）ID',
  \`username\` varchar(64) NOT NULL DEFAULT '' COMMENT '用户用户名，无用户名时为空串',
  \`nickname\` varchar(128) NOT NULL DEFAULT '' COMMENT '用户昵称',
  \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_user_id\` (\`user_id\`),
  KEY \`idx_chat_thread\` (\`chat_id\`, \`message_thread_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户与客服话题映射'`,
];

/** 存量库字段补齐语句，保证初始化脚本与线上结构一致 */
const COLUMN_SQLS = [
    {
        table: 'sk_welcome_button',
        column: 'row_index',
        sql: `ALTER TABLE \`sk_welcome_button\`
  ADD COLUMN \`row_index\` int unsigned NOT NULL DEFAULT 0 COMMENT '所在行序号，同一行序号的按钮展示在同一行' AFTER \`url\``,
    },
    {
        table: 'sk_group',
        column: 'del_keyword',
        sql: `ALTER TABLE \`sk_group\`
  ADD COLUMN \`del_keyword\` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '关键词消息删除：enable=开启，disable=关闭' AFTER \`status\``,
    },
    {
        table: 'sk_group',
        column: 'del_link',
        sql: `ALTER TABLE \`sk_group\`
  ADD COLUMN \`del_link\` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '链接消息删除：enable=开启，disable=关闭' AFTER \`del_keyword\``,
    },
    {
        table: 'sk_group',
        column: 'del_forward',
        sql: `ALTER TABLE \`sk_group\`
  ADD COLUMN \`del_forward\` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '转发消息删除：enable=开启，disable=关闭' AFTER \`del_link\``,
    },
    {
        table: 'sk_group',
        column: 'del_sticker',
        sql: `ALTER TABLE \`sk_group\`
  ADD COLUMN \`del_sticker\` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '贴纸消息删除：enable=开启，disable=关闭' AFTER \`del_forward\``,
    },
    {
        table: 'sk_group',
        column: 'del_photo',
        sql: `ALTER TABLE \`sk_group\`
  ADD COLUMN \`del_photo\` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '图片消息删除：enable=开启，disable=关闭' AFTER \`del_sticker\``,
    },
    {
        table: 'sk_group',
        column: 'del_video',
        sql: `ALTER TABLE \`sk_group\`
  ADD COLUMN \`del_video\` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '视频消息删除：enable=开启，disable=关闭' AFTER \`del_photo\``,
    },
    {
        table: 'sk_group',
        column: 'del_file',
        sql: `ALTER TABLE \`sk_group\`
  ADD COLUMN \`del_file\` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '文件消息删除：enable=开启，disable=关闭' AFTER \`del_video\``,
    },
    {
        table: 'sk_group',
        column: 'del_inline',
        sql: `ALTER TABLE \`sk_group\`
  ADD COLUMN \`del_inline\` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '内联消息删除：enable=开启，disable=关闭' AFTER \`del_file\``,
    },
    {
        table: 'sk_group',
        column: 'del_reply_chat',
        sql: `ALTER TABLE \`sk_group\`
  ADD COLUMN \`del_reply_chat\` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '引用频道或群组消息删除：enable=开启，disable=关闭' AFTER \`del_inline\``,
    },
    {
        table: 'sk_group',
        column: 'del_sender_chat',
        sql: `ALTER TABLE \`sk_group\`
  ADD COLUMN \`del_sender_chat\` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '频道或群组身份消息删除：enable=开启，disable=关闭' AFTER \`del_reply_chat\``,
    },
    {
        table: 'sk_group',
        column: 'del_contact',
        sql: `ALTER TABLE \`sk_group\`
  ADD COLUMN \`del_contact\` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '名片消息删除：enable=开启，disable=关闭' AFTER \`del_sender_chat\``,
    },
    {
        table: 'sk_group',
        column: 'del_long_text',
        sql: `ALTER TABLE \`sk_group\`
  ADD COLUMN \`del_long_text\` enum('enable','disable') NOT NULL DEFAULT 'disable' COMMENT '长文本消息删除：enable=开启，disable=关闭' AFTER \`del_contact\``,
    },
    {
        table: 'sk_group',
        column: 'max_text_length',
        sql: `ALTER TABLE \`sk_group\`
  ADD COLUMN \`max_text_length\` int unsigned NOT NULL DEFAULT 500 COMMENT '长文本删除阈值（字符数）' AFTER \`del_long_text\``,
    },
];

/**
 * 补齐存量表缺失的字段
 * @param {import('mysql2/promise').Connection} conn 数据库连接
 * @returns {Promise<void>}
 */
async function ensureColumns(conn) {
    for (const item of COLUMN_SQLS) {
        const [rows] = await conn.query(
            'SELECT COUNT(*) AS `total` FROM `information_schema`.`COLUMNS` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = ? AND `COLUMN_NAME` = ?',
            [item.table, item.column]
        );
        if (Number(rows[0]?.total) > 0) {
            console.log(`字段已存在: ${item.table}.${item.column}`);
            continue;
        }
        await conn.query(item.sql);
        console.log(`新增字段: ${item.table}.${item.column}`);
    }
}

/**
 * 执行数据库初始化
 * @returns 初始化完成后的 Promise
 */
async function initDB() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || '127.0.0.1',
        port: Number(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_DATABASE || 'bridgebot',
        charset: 'utf8mb4',
        multipleStatements: false,
    });

    try {
        for (const sql of CREATE_TABLE_SQLS) {
            await conn.query(sql);
            const tableName = sql.match(/`(sk_[a-z_]+)`/)?.[1] ?? 'unknown';
            console.log(`建表完成: ${tableName}`);
        }
        await ensureColumns(conn);
    } finally {
        await conn.end();
    }
}

initDB()
    .then(() => {
        console.log('数据库初始化完成');
        process.exit(0);
    })
    .catch((err) => {
        console.error('数据库初始化失败:', err instanceof Error ? err.stack : err);
        process.exit(1);
    });
