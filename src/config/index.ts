import dotenv from 'dotenv';
dotenv.config();

/**
 * 读取字符串类型环境变量
 * @param key 环境变量名
 * @param fallback 未配置时的默认值
 * @returns 环境变量值或默认值
 */
function readString(key: string, fallback = ''): string {
    return process.env[key] || fallback;
}

/**
 * 读取数字类型环境变量
 * @param key 环境变量名
 * @param fallback 未配置或非数字时的默认值
 * @returns 环境变量值或默认值
 */
function readNumber(key: string, fallback: number): number {
    const value = Number(process.env[key]);
    return Number.isFinite(value) ? value : fallback;
}

/**
 * 读取可选字符串环境变量
 * @param key 环境变量名
 * @returns 环境变量值，未配置或为空时返回 undefined
 */
function readOptionalString(key: string): string | undefined {
    const value = process.env[key];
    return value ? value : undefined;
}

/**
 * 读取可选数字环境变量
 * @param key 环境变量名
 * @returns 环境变量值，未配置或非数字时返回 undefined
 */
function readOptionalNumber(key: string): number | undefined {
    const raw = process.env[key];
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
}

/** Telegram 机器人配置 */
export const BOT_CONFIG = {
    token: readString('BOT_TOKEN'),
    /** Bot API 根地址 */
    apiRoot: readString('BOT_API_ROOT', 'https://api.telegram.org'),
    /** 超级管理员 TGID */
    superAdminId: readOptionalNumber('BOT_SUPER_ADMIN_ID'),
};

/** MySQL 连接配置，未配置项交由 mysql2 使用默认值 */
export const DB_CONFIG: {
    host: string | undefined;
    port: number | undefined;
    user: string | undefined;
    password: string | undefined;
    database: string | undefined;
} = {
    host: readOptionalString('DB_HOST'),
    port: readOptionalNumber('DB_PORT'),
    user: readOptionalString('DB_USER'),
    password: readOptionalString('DB_PASSWORD'),
    database: readOptionalString('DB_DATABASE'),
};

/** Redis 连接配置 */
export const REDIS_CONFIG: {
    host: string;
    port: number;
    db: number;
    password: string | undefined;
} = {
    host: readString('REDIS_HOST', '127.0.0.1'),
    port: readNumber('REDIS_PORT', 6379),
    db: readNumber('REDIS_DB', 0),
    password: readOptionalString('REDIS_PASSWORD'),
};

/** 日志配置：单文件按天滚动，自动压缩归档 */
export const LOG_CONFIG = {
    /** 日志文件路径模板 */
    filename: 'log/%DATE%-app.log',
    /** 按天滚动 */
    datePattern: 'YYYY-MM-DD',
    /** 归档文件压缩 */
    zippedArchive: true,
    /** 单文件最大体积 */
    maxSize: '20m',
    /** 文件保留时长 */
    maxFiles: '14d',
    /** 日志级别 */
    level: 'info',
    /** 时间戳格式 */
    timestampFormat: 'YYYY-MM-DD HH:mm:ss',
};
