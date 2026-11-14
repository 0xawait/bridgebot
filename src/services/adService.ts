import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dayjs from 'dayjs';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import dbQuery, { withTransaction } from './mysqlService.js';
import redis from './redisService.js';

/** 默认广告文字，文字长期有效 */
export const DEFAULT_AD_TEXT = '<tg-emoji emoji-id="5240228673738527951">🏷</tg-emoji> <b>以下均为付费广告，请自行甄别信息真伪。</b>';

/** 旧版本写入数据库的默认广告文字，升级时自动清空以跟随代码默认值 */
const LEGACY_DEFAULT_AD_TEXT = '以下均为付费广告，请自行甄别信息真伪。';

/** 默认广告图片路径，未配置自定义图片时使用 */
export const DEFAULT_AD_IMAGE_PATH = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../static/img/ad.png'
);

/** 广告按钮最大行数 */
export const AD_MAX_ROWS = 10;

/** 允许的每小时推送分钟档位 */
export const AD_PUSH_MINUTES = [0, 30] as const;

/** 推送分钟档位 */
export type AdPushMinute = (typeof AD_PUSH_MINUTES)[number];

/** 广告按钮 */
export interface AdButton {
    /** 按钮主键 */
    id: number;
    /** 按钮文字 */
    text: string;
    /** 跳转链接 */
    url: string;
    /** 所在行序号 */
    rowIndex: number;
    /** 到期时间（YYYY-MM-DD HH:mm:ss），null 表示永久有效 */
    expireAt: string | null;
}

/** 待写入的广告按钮 */
export interface AdButtonInput {
    /** 按钮文字 */
    text: string;
    /** 跳转链接 */
    url: string;
    /** 到期时间（YYYY-MM-DD HH:mm:ss），null 表示永久有效 */
    expireAt: string | null;
}

/** 广告配置 */
export interface AdConfig {
    /** 广告文字 */
    text: string;
    /** 自定义图片 file_id，空串表示使用默认图片 */
    imageFileId: string;
    /** 每小时推送分钟档位 */
    pushMinute: AdPushMinute;
    /** 下次推送时间 */
    nextPushAt: string | null;
    /** 最近一次推送时间 */
    lastPushAt: string | null;
    /** 是否已开启推送 */
    enabled: boolean;
}

/** 广告配置查询结果行 */
interface AdConfigRow extends RowDataPacket {
    text: string;
    image_file_id: string;
    push_minute: number;
    next_push_at: string | null;
    last_push_at: string | null;
    status: 'enable' | 'disable';
}

/** 广告按钮查询结果行 */
interface AdButtonRow extends RowDataPacket {
    id: number;
    text: string;
    url: string;
    row_index: number;
    expire_at: string | null;
}

/** 广告按钮查询字段，统一格式化为字符串避免时区转换差异 */
const AD_BUTTON_SELECT = 'SELECT `id`, `text`, `url`, `row_index`, ' +
    "DATE_FORMAT(`expire_at`, '%Y-%m-%d %H:%i:%s') AS `expire_at` FROM `sk_ad_button`";

/**
 * 确保广告配置行存在，并让默认文案始终跟随代码中的 DEFAULT_AD_TEXT
 * 数据库中的空串表示使用默认文案
 * @returns 初始化完成后的 Promise
 */
export async function ensureDefaultAdConfig(): Promise<void> {
    await dbQuery<ResultSetHeader>(
        'INSERT IGNORE INTO `sk_ad_config` (`id`, `text`) VALUES (1, \'\')'
    );
    // 历史版本曾把默认文案写入数据库，这里清空后由代码默认值统一维护
    await dbQuery<ResultSetHeader>(
        'UPDATE `sk_ad_config` SET `text` = \'\' WHERE `id` = 1 AND `text` IN (?, ?)',
        [LEGACY_DEFAULT_AD_TEXT, DEFAULT_AD_TEXT]
    );
}

/**
 * 查询广告配置
 * @returns 广告配置，未初始化时返回默认值
 */
export async function getAdConfig(): Promise<AdConfig> {
    const rows = await dbQuery<AdConfigRow[]>(
        'SELECT `text`, `image_file_id`, `push_minute`, ' +
        "DATE_FORMAT(`next_push_at`, '%Y-%m-%d %H:%i:%s') AS `next_push_at`, " +
        "DATE_FORMAT(`last_push_at`, '%Y-%m-%d %H:%i:%s') AS `last_push_at`, " +
        '`status` FROM `sk_ad_config` WHERE `id` = 1 LIMIT 1'
    );
    const row = rows[0];
    if (!row) {
        return {
            text: DEFAULT_AD_TEXT,
            imageFileId: '',
            pushMinute: 0,
            nextPushAt: null,
            lastPushAt: null,
            enabled: false,
        };
    }

    return {
        text: row.text.trim() ? row.text : DEFAULT_AD_TEXT,
        imageFileId: row.image_file_id,
        pushMinute: row.push_minute === 30 ? 30 : 0,
        nextPushAt: row.next_push_at,
        lastPushAt: row.last_push_at,
        enabled: row.status === 'enable',
    };
}

/**
 * 保存广告文字
 * @param text 广告文字，支持 HTML
 * @returns 保存完成后的 Promise
 */
export async function setAdText(text: string): Promise<void> {
    await dbQuery<ResultSetHeader>('UPDATE `sk_ad_config` SET `text` = ? WHERE `id` = 1', [text]);
}

/**
 * 保存自定义广告图片
 * @param fileId Telegram 图片 file_id
 * @returns 保存完成后的 Promise
 */
export async function setAdImageFileId(fileId: string): Promise<void> {
    await dbQuery<ResultSetHeader>('UPDATE `sk_ad_config` SET `image_file_id` = ? WHERE `id` = 1', [
        fileId,
    ]);
}

/**
 * 缓存默认图片首次上传后返回的 file_id，仅当当前未配置自定义图片时写入
 * @param fileId Telegram 图片 file_id
 * @returns 缓存完成后的 Promise
 */
export async function cacheAdImageFileId(fileId: string): Promise<void> {
    await dbQuery<ResultSetHeader>(
        "UPDATE `sk_ad_config` SET `image_file_id` = ? WHERE `id` = 1 AND `image_file_id` = ''",
        [fileId]
    );
}

/**
 * 设置推送分钟档位与下次推送时间
 * @param minute 推送分钟档位
 * @param nextPushAt 下次推送时间，null 表示暂停时不计算
 * @returns 更新完成后的 Promise
 */
export async function setAdPushMinute(
    minute: AdPushMinute,
    nextPushAt: string | null
): Promise<void> {
    await dbQuery<ResultSetHeader>(
        'UPDATE `sk_ad_config` SET `push_minute` = ?, `next_push_at` = ? WHERE `id` = 1',
        [minute, nextPushAt]
    );
}

/**
 * 设置推送开关与下次推送时间
 * @param enabled 是否开启推送
 * @param nextPushAt 下次推送时间，关闭时传 null
 * @returns 更新完成后的 Promise
 */
export async function setAdStatus(enabled: boolean, nextPushAt: string | null): Promise<void> {
    await dbQuery<ResultSetHeader>(
        'UPDATE `sk_ad_config` SET `status` = ?, `next_push_at` = ? WHERE `id` = 1',
        [enabled ? 'enable' : 'disable', nextPushAt]
    );
}

/**
 * 恢复默认广告配置并清空按钮
 * @returns 重置完成后的 Promise
 */
export async function resetAdConfig(): Promise<void> {
    await dbQuery<ResultSetHeader>(
        "UPDATE `sk_ad_config` SET `text` = '', `image_file_id` = '', `push_minute` = 0, " +
            "`status` = 'disable', `next_push_at` = NULL, `last_push_at` = NULL WHERE `id` = 1"
    );
    await clearAdButtons();
}

/**
 * 计算下一个匹配档位的推送时间
 * @param minute 推送分钟档位
 * @returns 下次推送时间（YYYY-MM-DD HH:mm:ss）
 */
export function buildNextPushAt(minute: AdPushMinute): string {
    const now = dayjs();
    let next = now.minute(minute).second(0).millisecond(0);
    if (!next.isAfter(now)) {
        next = next.add(1, 'hour');
    }
    return next.format('YYYY-MM-DD HH:mm:ss');
}

/**
 * 查询全部广告按钮
 * @returns 按行与行内顺序排列的按钮列表
 */
export async function getAdButtons(): Promise<AdButton[]> {
    const rows = await dbQuery<AdButtonRow[]>(
        `${AD_BUTTON_SELECT} ORDER BY \`row_index\` ASC, \`sort_order\` ASC, \`id\` ASC`
    );
    return mapAdButtonRows(rows);
}

/**
 * 查询当前未到期的广告按钮
 * @returns 按行与行内顺序排列的有效按钮列表
 */
export async function getActiveAdButtons(): Promise<AdButton[]> {
    const rows = await dbQuery<AdButtonRow[]>(
        `${AD_BUTTON_SELECT} WHERE \`expire_at\` IS NULL OR \`expire_at\` > NOW() ` +
        'ORDER BY `row_index` ASC, `sort_order` ASC, `id` ASC'
    );
    return mapAdButtonRows(rows);
}

/**
 * 将查询结果行转换为广告按钮
 * @param rows 查询结果行
 * @returns 广告按钮列表
 */
function mapAdButtonRows(rows: AdButtonRow[]): AdButton[] {
    return rows.map((row) => ({
        id: Number(row.id),
        text: row.text,
        url: row.url,
        rowIndex: Number(row.row_index),
        expireAt: row.expire_at,
    }));
}

/**
 * 批量新增广告按钮，按二维数组分行写入，每行追加到现有行之后
 * @param rows 按钮行数据，外层为行，内层为同一行的按钮
 * @returns 新增完成后的 Promise
 */
export async function addAdButtons(rows: AdButtonInput[][]): Promise<void> {
    if (!rows.length) return;

    await withTransaction(async (conn) => {
        const [maxRows] = await conn.query<RowDataPacket[]>(
            'SELECT COALESCE(MAX(`row_index`), -1) AS `maxRow` FROM `sk_ad_button`'
        );
        const startRow = Number(maxRows[0]?.maxRow ?? -1) + 1;

        for (let rowOffset = 0; rowOffset < rows.length; rowOffset += 1) {
            const row = rows[rowOffset] ?? [];
            for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
                const item = row[columnIndex];
                if (!item) continue;
                await conn.query<ResultSetHeader>(
                    'INSERT INTO `sk_ad_button` (`text`, `url`, `row_index`, `sort_order`, `expire_at`) ' +
                    'VALUES (?, ?, ?, ?, ?)',
                    [item.text, item.url, startRow + rowOffset, columnIndex, item.expireAt]
                );
            }
        }
    });
}

/**
 * 删除指定广告按钮
 * @param id 按钮主键
 * @returns 删除完成后的 Promise
 */
export async function removeAdButton(id: number): Promise<void> {
    await dbQuery<ResultSetHeader>('DELETE FROM `sk_ad_button` WHERE `id` = ?', [id]);
}

/**
 * 清空全部广告按钮
 * @returns 清空完成后的 Promise
 */
export async function clearAdButtons(): Promise<void> {
    await dbQuery<ResultSetHeader>('DELETE FROM `sk_ad_button`');
}

/**
 * 清理已到期的广告按钮
 * @returns 实际删除的条数
 */
export async function removeExpiredAdButtons(): Promise<number> {
    const result = await dbQuery<ResultSetHeader>(
        'DELETE FROM `sk_ad_button` WHERE `expire_at` IS NOT NULL AND `expire_at` <= NOW()'
    );
    return result.affectedRows;
}

/**
 * 原子抢占本轮推送资格，避免多实例重复推送
 * @returns 是否抢占成功
 */
export async function claimPushSlot(): Promise<boolean> {
    const result = await dbQuery<ResultSetHeader>(
        "UPDATE `sk_ad_config` SET `next_push_at` = DATE_ADD(NOW(), INTERVAL 1 HOUR), " +
        "`last_push_at` = NOW() WHERE `id` = 1 AND `status` = 'enable' AND `next_push_at` <= NOW()"
    );
    return result.affectedRows === 1;
}

/** 群组上一条广告消息缓存 Key 前缀 */
const AD_MESSAGE_KEY_PREFIX = 'ad:message:';

/** 上一条广告消息缓存有效期（秒），超过 Telegram 可删除时限后无需保留 */
const AD_MESSAGE_TTL_SECONDS = 3 * 24 * 60 * 60;

/**
 * 拼接群组广告消息缓存 Key
 * @param chatId 群组 ID
 * @returns Redis Key
 */
function buildAdMessageKey(chatId: number): string {
    return `${AD_MESSAGE_KEY_PREFIX}${chatId}`;
}

/**
 * 查询群组上一条广告消息 ID
 * @param chatId 群组 ID
 * @returns 消息 ID，无缓存或数据异常时返回 null
 */
export async function getAdMessageId(chatId: number): Promise<number | null> {
    const raw = await redis.get(buildAdMessageKey(chatId));
    if (raw === null) return null;

    const messageId = Number(raw);
    return Number.isSafeInteger(messageId) && messageId > 0 ? messageId : null;
}

/**
 * 记录群组最新一条广告消息 ID，用于下一轮推送时删除上一条
 * @param chatId 群组 ID
 * @param messageId 消息 ID
 * @returns 写入完成后的 Promise
 */
export async function saveAdMessageId(chatId: number, messageId: number): Promise<void> {
    await redis.set(
        buildAdMessageKey(chatId),
        String(messageId),
        'EX',
        AD_MESSAGE_TTL_SECONDS
    );
}
