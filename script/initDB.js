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
