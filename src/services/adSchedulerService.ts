import { existsSync } from 'node:fs';
import cron, { type ScheduledTask } from 'node-cron';
import dayjs from 'dayjs';
import { InputFile, type Bot } from 'grammy';
import { buildAdKeyboard } from '../utils/adKeyboard.js';
import logger from './loggerService.js';
import {
    cacheAdImageFileId,
    claimPushSlot,
    DEFAULT_AD_IMAGE_PATH,
    DEFAULT_AD_TEXT,
    ensureDefaultAdConfig,
    getActiveAdButtons,
    getAdConfig,
    getAdMessageId,
    saveAdMessageId,
    type AdConfig,
} from './adService.js';
import { listEnabledGroups, markGroupLeft } from './groupService.js';

/** 定时任务时区 */
const PUSH_TIMEZONE = 'Asia/Shanghai';

/** 单条消息发送间隔（毫秒），控制发送速率 */
const SEND_INTERVAL_MS = 50;

/** 触发限流后的最大重试次数 */
const MAX_RETRY = 3;

/** 定时任务实例 */
let scheduledTask: ScheduledTask | null = null;

/** 是否正在推送，避免定时与手动推送并发 */
let isPushing = false;

/** 推送结果 */
export interface AdPushResult {
    /** 成功群组数 */
    success: number;
    /** 失败群组数 */
    fail: number;
    /** 是否因并发推送被跳过 */
    skipped: boolean;
}

/** 发送结果消息的最小结构 */
interface SentMessage {
    message_id: number;
    chat: { id: number };
}

/** 图片消息的最小结构 */
interface PhotoMessageLike {
    photo?: Array<{ file_id: string }>;
}

/**
 * 延时等待
 * @param ms 毫秒数
 * @returns 等待完成后的 Promise
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * 读取 Telegram 错误码
 * @param err 异常对象
 * @returns 错误码，不存在时返回 undefined
 */
function getErrorCode(err: unknown): number | undefined {
    if (typeof err === 'object' && err !== null && 'error_code' in err) {
        const code = (err as { error_code?: unknown }).error_code;
        if (typeof code === 'number') return code;
    }
    return undefined;
}

/**
 * 读取 Telegram 限流等待秒数
 * @param err 异常对象
 * @returns 等待秒数，不存在时返回 null
 */
function getRetryAfter(err: unknown): number | null {
    if (typeof err === 'object' && err !== null && 'parameters' in err) {
        const params = (err as { parameters?: { retry_after?: unknown } }).parameters;
        if (typeof params?.retry_after === 'number') return params.retry_after;
    }
    return null;
}

/**
 * 从图片消息中提取图片 file_id
 * @param message 发送结果消息
 * @returns 最大尺寸图片的 file_id，缺失时返回 null
 */
function extractPhotoFileId(message: SentMessage): string | null {
    const photos = (message as SentMessage & PhotoMessageLike).photo;
    const largest = photos?.[photos.length - 1];
    return largest?.file_id ?? null;
}

/**
 * 解析广告图片发送源
 * @param config 广告配置
 * @returns 自定义 file_id、默认图片文件或 null（无可用图片）
 */
function resolvePhotoSource(config: AdConfig): string | InputFile | null {
    if (config.imageFileId) return config.imageFileId;
    if (existsSync(DEFAULT_AD_IMAGE_PATH)) return new InputFile(DEFAULT_AD_IMAGE_PATH);
    return null;
}

/**
 * 发送单条广告，遇到限流时按 retry_after 退避重试
 * @param bot 机器人实例
 * @param chatId 目标会话 ID
 * @param text 广告文字
 * @param photo 图片发送源
 * @param keyboard 内联键盘
 * @returns 发送结果消息
 */
async function sendAdWithRetry(
    bot: Bot,
    chatId: number,
    text: string,
    photo: string | InputFile | null,
    keyboard: ReturnType<typeof buildAdKeyboard>
): Promise<SentMessage & PhotoMessageLike> {
    for (let attempt = 0; ; attempt += 1) {
        try {
            if (photo) {
                return await bot.api.sendPhoto(chatId, photo, {
                    caption: text,
                    parse_mode: 'HTML',
                    ...(keyboard ? { reply_markup: keyboard } : {}),
                });
            }
            return await bot.api.sendMessage(chatId, text, {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
                ...(keyboard ? { reply_markup: keyboard } : {}),
            });
        } catch (err) {
            const retryAfter = getRetryAfter(err);
            if (getErrorCode(err) === 429 && retryAfter !== null && attempt < MAX_RETRY) {
                logger.warn(`广告推送触发限流，${retryAfter} 秒后重试: chatId=${chatId}`);
                await sleep(retryAfter * 1000);
                continue;
            }
            throw err;
        }
    }
}

/**
 * 删除群组上一条广告消息，失败时仅记录告警，避免影响本轮推送
 * @param bot 机器人实例
 * @param chatId 群组 ID
 * @param messageId 上一条广告消息 ID
 * @returns 删除完成后的 Promise
 */
async function deletePreviousAd(bot: Bot, chatId: number, messageId: number): Promise<void> {
    try {
        await bot.api.deleteMessage(chatId, messageId);
    } catch (err) {
        // 消息已被手动删除、超过可删除时限或机器人无删除权限时忽略，不影响新广告
        logger.warn(
            `删除上一条广告消息失败: chatId=${chatId}, messageId=${messageId}, ` +
                `${err instanceof Error ? err.message : String(err)}`
        );
    }
}

/**
 * 立即执行一轮广告推送
 * @param bot 机器人实例
 * @returns 推送结果
 */
export async function pushAdNow(bot: Bot): Promise<AdPushResult> {
    if (isPushing) {
        return { success: 0, fail: 0, skipped: true };
    }

    isPushing = true;
    try {
        const config = await getAdConfig();
        const [buttons, groups] = await Promise.all([getActiveAdButtons(), listEnabledGroups()]);
        const keyboard = buildAdKeyboard(buttons);
        const text = config.text.trim() ? config.text : DEFAULT_AD_TEXT;
        const photo = resolvePhotoSource(config);

        let success = 0;
        let fail = 0;
        let cachedFileId: string | null = null;

        for (const group of groups) {
            try {
                // 发送前先取出上一条广告消息 ID，发送成功后再删除，发送失败时保留旧广告
                const previousMessageId = await getAdMessageId(group.chatId).catch((err: unknown) => {
                    logger.warn(
                        `读取上一条广告消息记录失败: chatId=${group.chatId}, ` +
                            `${err instanceof Error ? err.message : err}`
                    );
                    return null;
                });
                const message = await sendAdWithRetry(bot, group.chatId, text, photo, keyboard);
                if (!config.imageFileId && !cachedFileId) {
                    const fileId = extractPhotoFileId(message);
                    if (fileId) {
                        cachedFileId = fileId;
                        await cacheAdImageFileId(fileId).catch((err: unknown) => {
                            logger.warn(
                                `缓存默认广告图片 file_id 失败: ${err instanceof Error ? err.message : err}`
                            );
                        });
                    }
                }
                await saveAdMessageId(group.chatId, message.message_id).catch((err: unknown) => {
                    logger.warn(
                        `记录广告消息 ID 失败: chatId=${group.chatId}, ` +
                            `${err instanceof Error ? err.message : err}`
                    );
                });
                if (previousMessageId) {
                    await deletePreviousAd(bot, group.chatId, previousMessageId);
                }
                success += 1;
            } catch (err) {
                fail += 1;
                if (getErrorCode(err) === 403) {
                    await markGroupLeft(group.chatId).catch((markErr: unknown) => {
                        logger.warn(
                            `标记群组退出失败: chatId=${group.chatId}, ${markErr instanceof Error ? markErr.message : markErr}`
                        );
                    });
                }
                logger.error(
                    `广告推送失败: chatId=${group.chatId}, title=${group.title}, ` +
                        `${err instanceof Error ? err.message : String(err)}`
                );
            }
            await sleep(SEND_INTERVAL_MS);
        }

        logger.info(`广告推送完成: 成功=${success}, 失败=${fail}, 群组总数=${groups.length}`);
        return { success, fail, skipped: false };
    } finally {
        isPushing = false;
    }
}

/**
 * 向指定会话发送一条广告预览
 * @param bot 机器人实例
 * @param chatId 目标会话 ID
 * @returns 发送结果消息
 */
export async function sendAdPreview(bot: Bot, chatId: number): Promise<SentMessage> {
    const config = await getAdConfig();
    const buttons = await getActiveAdButtons();
    const keyboard = buildAdKeyboard(buttons);
    const text = config.text.trim() ? config.text : DEFAULT_AD_TEXT;
    const photo = resolvePhotoSource(config);

    return await sendAdWithRetry(bot, chatId, text, photo, keyboard);
}

/**
 * 启动广告定时推送任务，每小时 00、30 分检查一次档位
 * @param bot 机器人实例
 * @returns 启动完成后的 Promise
 */
export function startAdScheduler(bot: Bot): void {
    if (scheduledTask) return;

    // 启动时同步默认广告配置，确保升级后的默认文案及时生效
    void ensureDefaultAdConfig().catch((err: unknown) => {
        logger.warn(`同步广告默认配置失败: ${err instanceof Error ? err.message : err}`);
    });

    scheduledTask = cron.schedule(
        '0,30 * * * *',
        async (): Promise<void> => {
            try {
                const config = await getAdConfig();
                if (!config.enabled) return;
                if (dayjs().minute() !== config.pushMinute) return;
                if (isPushing) return;

                const claimed = await claimPushSlot();
                if (!claimed) return;

                await pushAdNow(bot);
            } catch (err) {
                logger.error(`广告定时任务执行失败: ${err instanceof Error ? err.stack : err}`);
            }
        },
        { timezone: PUSH_TIMEZONE, name: 'ad-push', noOverlap: true }
    );

    logger.info('广告定时推送任务已启动（每小时 00 / 30 分检查档位）');
}

/**
 * 停止广告定时推送任务
 * @returns 停止完成后的 Promise
 */
export async function stopAdScheduler(): Promise<void> {
    if (!scheduledTask) return;
    await scheduledTask.stop();
    scheduledTask = null;
    logger.info('广告定时推送任务已停止');
}
