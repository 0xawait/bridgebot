import { InlineKeyboard, type Bot, type Context } from 'grammy';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import logger from '../services/loggerService.js';
import redis from '../services/redisService.js';
import { escapeHtml } from '../utils/html.js';
import {
    AD_MAX_ROWS,
    addAdButtons,
    buildNextPushAt,
    ensureDefaultAdConfig,
    getAdButtons,
    getAdConfig,
    removeAdButton,
    removeExpiredAdButtons,
    resetAdConfig,
    setAdImageFileId,
    setAdPushMinute,
    setAdStatus,
    setAdText,
    type AdButton,
    type AdButtonInput,
    type AdConfig,
    type AdPushMinute,
} from '../services/adService.js';
import { pushAdNow, sendAdPreview } from '../services/adSchedulerService.js';
import { isSuperAdmin } from './configHandler.js';

dayjs.extend(customParseFormat);

/** 广告文字最大长度（图片消息 caption 上限） */
const MAX_AD_TEXT_LENGTH = 1024;
/** 按钮文字最大长度 */
const MAX_BUTTON_TEXT_LENGTH = 32;
/** 按钮链接最大长度 */
const MAX_BUTTON_URL_LENGTH = 512;
/** 预览消息自动删除延迟（毫秒） */
const PREVIEW_AUTO_DELETE_MS = 10000;

/** 广告配置等待的输入类型 */
type AdStateType = 'awaitAdText' | 'awaitAdImage' | 'awaitAdButton';

/** 广告配置等待的输入状态 */
type AdState = {
    type: AdStateType;
    /** 原面板消息所在会话 ID */
    panelChatId?: number | undefined;
    /** 原面板消息 ID */
    panelMessageId?: number | undefined;
    /** 输入提示消息 ID */
    promptMessageId?: number | undefined;
};

/** 已支持的输入类型 */
const AD_STATE_TYPES: AdStateType[] = ['awaitAdText', 'awaitAdImage', 'awaitAdButton'];

/** 面板消息定位信息 */
type PanelTarget = { chatId: number; messageId: number };

/** 输入状态缓存 Key 前缀 */
const AD_STATE_KEY_PREFIX = 'bot:ad:state:';
/** 输入状态有效期（秒） */
const AD_STATE_TTL_SECONDS = 600;

/**
 * 拼接输入状态的 Redis Key
 * @param userId 用户 ID
 * @returns Redis Key
 */
function buildStateKey(userId: number): string {
    return `${AD_STATE_KEY_PREFIX}${userId}`;
}

/**
 * 写入输入状态
 * @param userId 用户 ID
 * @param state 输入状态
 * @returns 写入完成后的 Promise
 */
async function setPendingState(userId: number, state: AdState): Promise<void> {
    await redis.set(buildStateKey(userId), JSON.stringify(state), 'EX', AD_STATE_TTL_SECONDS);
}

/**
 * 读取输入状态
 * @param userId 用户 ID
 * @returns 输入状态，不存在或数据异常时返回 null
 */
async function getPendingState(userId: number): Promise<AdState | null> {
    const key = buildStateKey(userId);
    let raw: string | null;

    try {
        raw = await redis.get(key);
    } catch (err) {
        logger.error(`读取广告配置状态失败: ${err instanceof Error ? err.stack : err}`);
        return null;
    }

    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw) as AdState;
        if (AD_STATE_TYPES.includes(parsed.type)) {
            return parsed;
        }
    } catch {
        // 数据异常时按无状态处理
    }

    await redis.del(key).catch(() => undefined);
    return null;
}

/**
 * 清除输入状态
 * @param userId 用户 ID
 * @returns 清除完成后的 Promise
 */
async function deletePendingState(userId: number): Promise<void> {
    await redis.del(buildStateKey(userId));
}

/**
 * 判断按钮是否仍在有效期内
 * @param expireAt 到期时间字符串
 * @returns 是否有效
 */
function isButtonActive(expireAt: string | null): boolean {
    return expireAt === null || dayjs(expireAt).isAfter(dayjs());
}

/**
 * 格式化到期时间用于展示
 * @param expireAt 到期时间字符串
 * @returns 展示文案
 */
function formatExpireLabel(expireAt: string | null): string {
    if (!expireAt) return '永久';
    const expired = !isButtonActive(expireAt);
    return `${expireAt.slice(0, 16)}${expired ? '（已过期）' : ''}`;
}

/**
 * 按行分组按钮
 * @param buttons 按钮列表
 * @returns 二维数组，外层为行
 */
function groupButtonsByRow(buttons: AdButton[]): AdButton[][] {
    const rows: AdButton[][] = [];
    for (const button of buttons) {
        const lastRow = rows[rows.length - 1];
        if (lastRow && lastRow[0]?.rowIndex === button.rowIndex) {
            lastRow.push(button);
        } else {
            rows.push([button]);
        }
    }
    return rows;
}

/**
 * 统计按钮占用的行数
 * @param buttons 按钮列表
 * @returns 行数
 */
function countRows(buttons: AdButton[]): number {
    return groupButtonsByRow(buttons).length;
}

/**
 * 构建广告主面板文案
 * @param config 广告配置
 * @param buttons 按钮列表
 * @returns 面板文案（HTML）
 */
function buildPanelText(config: AdConfig, buttons: AdButton[]): string {
    const activeCount = buttons.filter((button) => isButtonActive(button.expireAt)).length;
    const expiredCount = buttons.length - activeCount;
    const minuteLabel = String(config.pushMinute).padStart(2, '0');
    const text = config.text.trim() ? config.text : '<i>-</i>';

    return [
        '<tg-emoji emoji-id="5260268501515377807">📣</tg-emoji><b> 广告推送配置</b>',
        '',
        `状态：${config.enabled ? '<b>已开启</b>' : '<b>已暂停</b>'}`,
        `推送档位：每小时 <code>${minuteLabel}</code> 分`,
        `图片：${config.imageFileId ? '自定义图片' : '默认图片'}`,
        `按钮：有效 ${activeCount} 个 / 已过期 ${expiredCount} 个`,
        '',
        '<b>广告文字</b>',
        text,
        '',
        '<i>文字与图片长期有效，仅按钮按到期时间失效</i>',
    ].join('\n');
}

/**
 * 构建广告主面板键盘
 * @param config 广告配置
 * @returns 内联键盘
 */
function buildPanelKeyboard(config: AdConfig): InlineKeyboard {
    const minuteLabel = String(config.pushMinute).padStart(2, '0');

    return new InlineKeyboard()
        .text('修改文字', 'ad:text')
        .text('修改图片', 'ad:image')
        .row()
        .text('按钮管理', 'ad:buttons')
        .text(`切换档位：${minuteLabel} 分`, 'ad:minute')
        .row()
        .text('立即推送', 'ad:push')
        .text('预览', 'ad:preview')
        .row()
        .text(config.enabled ? '暂停推送' : '开启推送', 'ad:toggle')
        .text('清空', 'ad:clear');
}

/**
 * 构建按钮管理面板文案
 * @param buttons 按钮列表
 * @returns 面板文案（HTML）
 */
function buildButtonsText(buttons: AdButton[]): string {
    const rows = groupButtonsByRow(buttons);
    const lines = rows.length
        ? rows.map(
            (row, index) =>
                `第 ${index + 1} 行：${row
                    .map((button) => `${escapeHtml(button.text)}（${formatExpireLabel(button.expireAt)}）`)
                    .join(' | ')}`
        )
        : ['<i>暂无按钮，点击下方「添加」新增</i>'];

    return [
        '<tg-emoji emoji-id="5226513232549664618">🔢</tg-emoji><b> 广告按钮管理</b>',
        '',
        ...lines,
        '',
        `<i>最多 ${AD_MAX_ROWS} 行，同一行可放多个按钮；仅按钮会按到期时间失效</i>`,
    ].join('\n');
}

/**
 * 构建按钮管理面板键盘
 * @param buttons 按钮列表
 * @returns 内联键盘
 */
function buildButtonsKeyboard(buttons: AdButton[]): InlineKeyboard {
    const keyboard = new InlineKeyboard();

    for (const button of buttons) {
        const label = button.text.length > 20 ? `${button.text.slice(0, 20)}…` : button.text;
        keyboard.text(`删除：${label}`, `ad:del:${button.id}`).row();
    }
    if (countRows(buttons) < AD_MAX_ROWS) {
        keyboard.text('添加按钮', 'ad:add').row();
    }
    if (buttons.some((button) => !isButtonActive(button.expireAt))) {
        keyboard.text('清理过期按钮', 'ad:clean').row();
    }
    keyboard.text('返回', 'ad:panel');
    return keyboard;
}

/**
 * 编辑面板消息，内容未变化时忽略错误
 * @param ctx 机器人上下文
 * @param text 新文案
 * @param keyboard 新键盘
 * @param target 需要编辑的原面板消息，传入时以此为准
 * @returns 编辑完成后的 Promise
 */
async function editPanel(
    ctx: Context,
    text: string,
    keyboard: InlineKeyboard,
    target?: PanelTarget
): Promise<void> {
    try {
        if (target) {
            await ctx.api.editMessageText(target.chatId, target.messageId, text, {
                parse_mode: 'HTML',
                reply_markup: keyboard,
            });
            return;
        }
        await ctx.editMessageText(text, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
        });
    } catch (err) {
        logger.warn(`编辑广告配置面板失败: ${err instanceof Error ? err.message : err}`);
    }
}

/**
 * 从输入状态中提取原面板消息定位信息
 * @param state 输入状态
 * @returns 面板消息定位信息，缺失时返回 undefined
 */
function buildPanelTarget(state: AdState): PanelTarget | undefined {
    if (!state.panelChatId || !state.panelMessageId) return undefined;
    return { chatId: state.panelChatId, messageId: state.panelMessageId };
}

/**
 * 发送输入提示并记录面板与提示消息信息
 * @param ctx 机器人上下文
 * @param fromId 操作者用户 ID
 * @param type 输入类型
 * @param promptText 提示文案
 * @returns 发送完成后的 Promise
 */
async function sendInputPrompt(
    ctx: Context,
    fromId: number,
    type: AdStateType,
    promptText: string
): Promise<void> {
    const prompt = await ctx.reply(promptText);
    await setPendingState(fromId, {
        type,
        panelChatId: ctx.chat?.id,
        panelMessageId: ctx.callbackQuery?.message?.message_id,
        promptMessageId: prompt.message_id,
    });
}

/**
 * 删除输入提示消息与用户回复的消息
 * @param ctx 机器人上下文
 * @param state 输入状态
 * @returns 删除完成后的 Promise
 */
async function deleteInputMessages(ctx: Context, state: AdState): Promise<void> {
    const targets: PanelTarget[] = [];
    if (state.panelChatId && state.promptMessageId) {
        targets.push({ chatId: state.panelChatId, messageId: state.promptMessageId });
    }
    const replyChatId = ctx.chat?.id;
    const replyMessageId = ctx.message?.message_id;
    if (replyChatId && replyMessageId) {
        targets.push({ chatId: replyChatId, messageId: replyMessageId });
    }

    for (const target of targets) {
        try {
            await ctx.api.deleteMessage(target.chatId, target.messageId);
        } catch (err) {
            logger.warn(`删除广告配置输入消息失败: ${err instanceof Error ? err.message : err}`);
        }
    }
}

/**
 * 输入完成后刷新原面板，原面板信息缺失时改为发送新面板
 * @param ctx 机器人上下文
 * @param state 输入状态
 * @returns 刷新完成后的 Promise
 */
async function refreshPanelAfterInput(ctx: Context, state: AdState): Promise<void> {
    const target = buildPanelTarget(state);
    const [config, buttons] = await Promise.all([getAdConfig(), getAdButtons()]);
    const text = buildPanelText(config, buttons);
    const keyboard = buildPanelKeyboard(config);

    if (!target) {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
        return;
    }
    await editPanel(ctx, text, keyboard, target);
}

/**
 * 解析按钮到期时间输入
 * 支持 30m / 12h / 7d、YYYY-MM-DD HH:mm，空或 off 表示永久
 * @param raw 原始输入
 * @returns 解析结果
 */
function parseExpireInput(raw: string): { ok: true; value: string | null } | { ok: false; message: string } {
    const value = raw.trim();
    if (!value || value.toLowerCase() === 'off' || value === '永久') {
        return { ok: true, value: null };
    }

    const relative = /^(\d+)([mhd])$/i.exec(value);
    if (relative) {
        const amount = Number(relative[1]);
        const unitMap = { m: 'minute', h: 'hour', d: 'day' } as const;
        const unit = unitMap[relative[2]!.toLowerCase() as keyof typeof unitMap];
        if (!Number.isSafeInteger(amount) || amount <= 0) {
            return { ok: false, message: '到期时间格式不正确，请使用 30m / 12h / 7d 或 YYYY-MM-DD HH:mm。' };
        }
        return { ok: true, value: dayjs().add(amount, unit).format('YYYY-MM-DD HH:mm:ss') };
    }

    const formats = ['YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD'];
    for (const format of formats) {
        const parsed = dayjs(value, format, true);
        if (!parsed.isValid()) continue;
        if (!parsed.isAfter(dayjs())) {
            return { ok: false, message: '到期时间必须晚于当前时间，请重新发送。' };
        }
        return { ok: true, value: parsed.format('YYYY-MM-DD HH:mm:ss') };
    }

    return { ok: false, message: '到期时间格式不正确，请使用 30m / 12h / 7d 或 YYYY-MM-DD HH:mm。' };
}

/**
 * 执行推送并向管理员发送结果通知
 * @param bot 机器人实例
 * @param adminId 管理员用户 ID
 * @param label 操作名称
 * @returns 推送完成后的 Promise
 */
async function pushAndReport(bot: Bot, adminId: number, label: string): Promise<void> {
    try {
        const result = await pushAdNow(bot);
        if (result.skipped) {
            await bot.api.sendMessage(adminId, `${label}：已有推送任务进行中，本次跳过。`);
            return;
        }
        await bot.api.sendMessage(
            adminId,
            `${label}完成：成功 ${result.success} 个群组，失败 ${result.fail} 个。`
        );
    } catch (err) {
        logger.error(`广告推送失败: ${err instanceof Error ? err.stack : err}`);
        await bot.api.sendMessage(adminId, `${label}失败，请查看日志。`).catch(() => undefined);
    }
}

/**
 * 注册 /ad 广告推送配置命令与相关回调，仅超级管理员可用
 * @param bot 机器人实例
 * @returns 注册完成后的 Promise
 */
export function registerAdHandler(bot: Bot): void {
    // /ad 命令：打开广告推送配置面板
    bot.command('ad', async (ctx: Context): Promise<void> => {
        if (!isSuperAdmin(ctx)) {
            await ctx.reply('无权限使用该命令。');
            return;
        }

        try {
            if (ctx.from?.id !== undefined) {
                await deletePendingState(ctx.from.id);
            }
            await ensureDefaultAdConfig();
            const [config, buttons] = await Promise.all([getAdConfig(), getAdButtons()]);
            await ctx.reply(buildPanelText(config, buttons), {
                parse_mode: 'HTML',
                reply_markup: buildPanelKeyboard(config),
            });
        } catch (err) {
            logger.error(`打开广告配置面板失败: ${err instanceof Error ? err.stack : err}`);
            await ctx.reply('打开广告配置面板失败，请稍后重试。');
        }
    });

    // 面板按钮回调
    bot.callbackQuery(/^ad:/, async (ctx): Promise<void> => {
        const fromId = ctx.from?.id;
        if (fromId === undefined || !isSuperAdmin(ctx)) {
            await ctx.answerCallbackQuery({ text: '无权限', show_alert: true });
            return;
        }

        const action = ctx.callbackQuery.data.slice('ad:'.length);
        await ctx.answerCallbackQuery();

        try {
            if (action === 'panel') {
                await deletePendingState(fromId);
                const [config, buttons] = await Promise.all([getAdConfig(), getAdButtons()]);
                await editPanel(ctx, buildPanelText(config, buttons), buildPanelKeyboard(config));
                return;
            }

            if (action === 'text') {
                await sendInputPrompt(
                    ctx,
                    fromId,
                    'awaitAdText',
                    `请发送新的广告文字（支持 Telegram HTML，最多 ${MAX_AD_TEXT_LENGTH} 个字符）。\n` +
                    '文字长期有效。\n发送 /cancel 取消操作。'
                );
                return;
            }

            if (action === 'image') {
                await sendInputPrompt(
                    ctx,
                    fromId,
                    'awaitAdImage',
                    '请直接发送新的广告图片。\n图片长期有效，发送 /cancel 取消操作。'
                );
                return;
            }

            if (action === 'buttons') {
                await deletePendingState(fromId);
                const buttons = await getAdButtons();
                await editPanel(ctx, buildButtonsText(buttons), buildButtonsKeyboard(buttons));
                return;
            }

            if (action === 'add') {
                const buttons = await getAdButtons();
                if (countRows(buttons) >= AD_MAX_ROWS) {
                    await ctx.reply(`按钮行数已达上限（${AD_MAX_ROWS} 行），请先删除后再添加。`);
                    return;
                }
                await sendInputPrompt(
                    ctx,
                    fromId,
                    'awaitAdButton',
                    '请发送按钮信息，每行代表键盘的一行，同一行多个按钮用 & 分隔：\n' +
                    '按钮文字|链接|到期时间\n' +
                    '广告位A|https://example.com|7d\n' +
                    '广告位B|https://example.com|2026-12-31 23:59&广告位C|https://example.com\n\n' +
                    '到期时间可省略或填 off 表示永久，支持 30m / 12h / 7d 或 YYYY-MM-DD HH:mm。\n' +
                    `最多 ${AD_MAX_ROWS} 行，发送 /cancel 取消操作。`
                );
                return;
            }

            if (action === 'minute') {
                const config = await getAdConfig();
                const nextMinute: AdPushMinute = config.pushMinute === 0 ? 30 : 0;
                await setAdPushMinute(
                    nextMinute,
                    config.enabled ? buildNextPushAt(nextMinute) : null
                );
                const [nextConfig, buttons] = await Promise.all([getAdConfig(), getAdButtons()]);
                await editPanel(ctx, buildPanelText(nextConfig, buttons), buildPanelKeyboard(nextConfig));
                return;
            }

            if (action === 'toggle') {
                const config = await getAdConfig();
                if (config.enabled) {
                    await setAdStatus(false, null);
                    logger.info(`超级管理员暂停广告推送: userId=${fromId}`);
                    const [nextConfig, buttons] = await Promise.all([getAdConfig(), getAdButtons()]);
                    await editPanel(ctx, buildPanelText(nextConfig, buttons), buildPanelKeyboard(nextConfig));
                    return;
                }

                if (!config.text.trim()) {
                    await ctx.reply('广告文字不能为空，请先配置文字。');
                    return;
                }

                await setAdStatus(true, buildNextPushAt(config.pushMinute));
                logger.info(`超级管理员开启广告推送: userId=${fromId}`);
                const [nextConfig, buttons] = await Promise.all([getAdConfig(), getAdButtons()]);
                await editPanel(ctx, buildPanelText(nextConfig, buttons), buildPanelKeyboard(nextConfig));
                void pushAndReport(bot, fromId, '广告推送开启');
                return;
            }

            if (action === 'push') {
                const config = await getAdConfig();
                if (!config.text.trim()) {
                    await ctx.reply('广告文字不能为空，请先配置文字。');
                    return;
                }
                void pushAndReport(bot, fromId, '立即推送');
                return;
            }

            if (action === 'preview') {
                const previewMessage = await sendAdPreview(bot, ctx.chat?.id ?? fromId);
                setTimeout(() => {
                    ctx.api.deleteMessage(previewMessage.chat.id, previewMessage.message_id).catch((err) => {
                        logger.warn(`删除广告预览消息失败: ${err instanceof Error ? err.message : err}`);
                    });
                }, PREVIEW_AUTO_DELETE_MS);
                return;
            }

            if (action === 'clear') {
                await deletePendingState(fromId);
                await editPanel(
                    ctx,
                    '确认清空广告配置（文字恢复默认、图片恢复默认、删除全部按钮并暂停推送）？此操作不可恢复。',
                    new InlineKeyboard()
                        .text('确认清空', 'ad:clear:confirm')
                        .row()
                        .text('返回', 'ad:panel')
                );
                return;
            }

            if (action === 'clear:confirm') {
                await deletePendingState(fromId);
                await resetAdConfig();
                logger.info(`超级管理员清空广告配置: userId=${fromId}`);
                const [config, buttons] = await Promise.all([getAdConfig(), getAdButtons()]);
                await editPanel(
                    ctx,
                    `广告配置已清空。\n\n${buildPanelText(config, buttons)}`,
                    buildPanelKeyboard(config)
                );
                return;
            }

            if (action === 'clean') {
                const removed = await removeExpiredAdButtons();
                logger.info(`超级管理员清理过期广告按钮: userId=${fromId}, removed=${removed}`);
                const buttons = await getAdButtons();
                await editPanel(
                    ctx,
                    `已清理 ${removed} 个过期按钮。\n\n${buildButtonsText(buttons)}`,
                    buildButtonsKeyboard(buttons)
                );
                return;
            }

            if (action.startsWith('del:')) {
                const id = Number(action.slice('del:'.length));
                if (!Number.isInteger(id) || id <= 0) {
                    await ctx.reply('按钮参数无效。');
                    return;
                }
                await deletePendingState(fromId);
                await removeAdButton(id);
                logger.info(`超级管理员删除广告按钮: userId=${fromId}, buttonId=${id}`);
                const buttons = await getAdButtons();
                await editPanel(ctx, buildButtonsText(buttons), buildButtonsKeyboard(buttons));
                return;
            }
        } catch (err) {
            logger.error(`广告配置回调处理失败: ${err instanceof Error ? err.stack : err}`);
            await ctx.reply('操作失败，请稍后重试。');
        }
    });

    // 接收超级管理员发送的广告图片
    bot.on('message:photo', async (ctx: Context, next): Promise<void> => {
        const fromId = ctx.from?.id;
        if (fromId === undefined) {
            await next();
            return;
        }

        const state = await getPendingState(fromId);
        if (!state || state.type !== 'awaitAdImage') {
            await next();
            return;
        }

        if (!isSuperAdmin(ctx)) {
            await deletePendingState(fromId);
            return;
        }

        const photos = ctx.message?.photo;
        const largest = photos?.[photos.length - 1];
        if (!largest) {
            await ctx.reply('未获取到图片，请重新发送。');
            return;
        }

        try {
            await setAdImageFileId(largest.file_id);
            await deletePendingState(fromId);
            logger.info(`超级管理员更新广告图片: userId=${fromId}`);
            await deleteInputMessages(ctx, state);
            await refreshPanelAfterInput(ctx, state);
        } catch (err) {
            logger.error(`广告图片保存失败: ${err instanceof Error ? err.stack : err}`);
            await ctx.reply('图片保存失败，请稍后重试。');
        }
    });

    // 接收超级管理员发送的配置文字
    bot.on('message:text', async (ctx: Context, next): Promise<void> => {
        const fromId = ctx.from?.id;
        if (fromId === undefined || !ctx.message?.text) {
            await next();
            return;
        }

        const text = ctx.message.text.trim();

        try {
            const state = await getPendingState(fromId);
            if (!state) {
                await next();
                return;
            }

            if (!isSuperAdmin(ctx)) {
                await deletePendingState(fromId);
                return;
            }

            if (text === '/cancel') {
                await deletePendingState(fromId);
                await deleteInputMessages(ctx, state);
                return;
            }

            if (text.startsWith('/')) return;

            if (state.type === 'awaitAdImage') {
                await ctx.reply('请直接发送图片，或发送 /cancel 取消操作。');
                return;
            }

            if (state.type === 'awaitAdText') {
                if (!text) {
                    await ctx.reply('广告文字不能为空，请重新发送，或发送 /cancel 取消操作。');
                    return;
                }
                if (text.length > MAX_AD_TEXT_LENGTH) {
                    await ctx.reply(`广告文字过长，最多 ${MAX_AD_TEXT_LENGTH} 个字符。`);
                    return;
                }

                await setAdText(text);
                await deletePendingState(fromId);
                logger.info(`超级管理员更新广告文字: userId=${fromId}, length=${text.length}`);
                await deleteInputMessages(ctx, state);
                await refreshPanelAfterInput(ctx, state);
                return;
            }

            // 按钮输入：每行一个键盘行，行内多个按钮以 & 分隔，单个按钮为 文字|链接|到期时间
            const inputLines = text
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean);

            if (!inputLines.length) {
                await ctx.reply('格式不正确，请按「按钮文字|链接|到期时间」发送，或发送 /cancel 取消操作。');
                return;
            }
            if (inputLines.length > AD_MAX_ROWS) {
                await ctx.reply(`一次最多发送 ${AD_MAX_ROWS} 行按钮。`);
                return;
            }

            const parsedRows: AdButtonInput[][] = [];
            for (const line of inputLines) {
                const segments = line
                    .split('&')
                    .map((item) => item.trim())
                    .filter(Boolean);
                const row: AdButtonInput[] = [];

                for (const segment of segments) {
                    const parts = segment.split('|');
                    const buttonText = (parts[0] ?? '').trim();
                    const url = (parts[1] ?? '').trim();
                    const expireRaw = parts.slice(2).join('|').trim();

                    if (!buttonText || !url) {
                        await ctx.reply(
                            `格式不正确：「${segment}」，请按「按钮文字|链接|到期时间」发送，或发送 /cancel 取消操作。`
                        );
                        return;
                    }
                    if (buttonText.length > MAX_BUTTON_TEXT_LENGTH) {
                        await ctx.reply(
                            `按钮文字过长（「${buttonText}」），最多 ${MAX_BUTTON_TEXT_LENGTH} 个字符。`
                        );
                        return;
                    }
                    if (!/^https?:\/\/\S+$/i.test(url) || url.length > MAX_BUTTON_URL_LENGTH) {
                        await ctx.reply(
                            `链接无效（「${url}」），请提供以 http:// 或 https:// 开头且长度不超过 ${MAX_BUTTON_URL_LENGTH} 的链接。`
                        );
                        return;
                    }

                    const expireResult = parseExpireInput(expireRaw);
                    if (!expireResult.ok) {
                        await ctx.reply(`${expireResult.message}\n或发送 /cancel 取消操作。`);
                        return;
                    }

                    row.push({ text: buttonText, url, expireAt: expireResult.value });
                }

                if (!row.length) continue;
                parsedRows.push(row);
            }

            if (!parsedRows.length) {
                await ctx.reply('未解析到有效按钮，请按「按钮文字|链接|到期时间」发送，或发送 /cancel 取消操作。');
                return;
            }

            const buttons = await getAdButtons();
            if (countRows(buttons) + parsedRows.length > AD_MAX_ROWS) {
                await ctx.reply(
                    `按钮行数超出上限（最多 ${AD_MAX_ROWS} 行），当前已有 ${countRows(buttons)} 行，` +
                    `本次最多可添加 ${AD_MAX_ROWS - countRows(buttons)} 行。`
                );
                return;
            }

            await addAdButtons(parsedRows);
            await deletePendingState(fromId);
            logger.info(`超级管理员新增广告按钮: userId=${fromId}, rows=${parsedRows.length}`);
            await deleteInputMessages(ctx, state);
            await refreshPanelAfterInput(ctx, state);
        } catch (err) {
            logger.error(`广告配置保存失败: ${err instanceof Error ? err.stack : err}`);
            await ctx.reply('配置保存失败，请稍后重试。');
        }
    });
}
