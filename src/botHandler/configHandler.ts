import { InlineKeyboard, type Bot, type Context } from 'grammy';
import { BOT_CONFIG } from '../config/index.js';
import logger from '../services/loggerService.js';
import {
    addWelcomeButtons,
    clearWelcome,
    getWelcomeButtons,
    getWelcomeConfig,
    removeWelcomeButton,
    setWelcomeContent,
    WELCOME_MAX_ROWS,
    type WelcomeButton,
    type WelcomeButtonInput,
} from '../services/welcomeService.js';
import { buildWelcomeKeyboard } from '../utils/welcomeKeyboard.js';
import { getGroupChatId, setGroupChatId } from '../services/groupConfigService.js';
import redis from '../services/redisService.js';
import { escapeHtml } from '../utils/html.js';

/** 欢迎语文字最大长度 */
const MAX_CONTENT_LENGTH = 3500;
/** 按钮文字最大长度 */
const MAX_BUTTON_TEXT_LENGTH = 32;
/** 按钮链接最大长度 */
const MAX_BUTTON_URL_LENGTH = 512;
/** 预览消息自动删除延迟（毫秒） */
const PREVIEW_AUTO_DELETE_MS = 5000;

/** 配置操作等待的输入类型 */
type ConfigStateType = 'awaitText' | 'awaitButton' | 'awaitGroupId';

/** 配置操作等待的输入状态 */
type ConfigState = {
    type: ConfigStateType;
    /** 原面板消息所在会话 ID */
    panelChatId?: number | undefined;
    /** 原面板消息 ID */
    panelMessageId?: number | undefined;
    /** 输入提示消息 ID */
    promptMessageId?: number | undefined;
};

/** 已支持的配置输入类型 */
const CONFIG_STATE_TYPES: ConfigStateType[] = ['awaitText', 'awaitButton', 'awaitGroupId'];

/** 面板消息定位信息 */
type PanelTarget = { chatId: number; messageId: number };

/** 配置输入状态缓存 Key 前缀 */
const CONFIG_STATE_KEY_PREFIX = 'bot:config:state:';
/** 配置输入状态有效期（秒） */
const CONFIG_STATE_TTL_SECONDS = 600;

/**
 * 拼接配置输入状态的 Redis Key
 * @param userId 用户 ID
 * @returns Redis Key
 */
function buildStateKey(userId: number): string {
    return `${CONFIG_STATE_KEY_PREFIX}${userId}`;
}

/**
 * 写入配置输入状态
 * @param userId 用户 ID
 * @param state 输入状态
 * @returns 写入完成后的 Promise
 */
async function setPendingState(userId: number, state: ConfigState): Promise<void> {
    await redis.set(buildStateKey(userId), JSON.stringify(state), 'EX', CONFIG_STATE_TTL_SECONDS);
}

/**
 * 读取配置输入状态
 * @param userId 用户 ID
 * @returns 输入状态，不存在或数据异常时返回 null
 */
async function getPendingState(userId: number): Promise<ConfigState | null> {
    const key = buildStateKey(userId);
    let raw: string | null;

    try {
        raw = await redis.get(key);
    } catch (err) {
        logger.error(`读取配置输入状态失败: ${err instanceof Error ? err.stack : err}`);
        return null;
    }

    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw) as ConfigState;
        if (CONFIG_STATE_TYPES.includes(parsed.type)) {
            return parsed;
        }
    } catch {
        // 数据异常时按无状态处理
    }

    await redis.del(key).catch(() => undefined);
    return null;
}

/**
 * 清除配置输入状态
 * @param userId 用户 ID
 * @returns 清除完成后的 Promise
 */
async function deletePendingState(userId: number): Promise<void> {
    await redis.del(buildStateKey(userId));
}

/**
 * 判断当前操作者是否为超级管理员
 * @param ctx 机器人上下文
 * @returns 是否具备超级管理员权限
 */
export function isSuperAdmin(ctx: Context): boolean {
    return Boolean(BOT_CONFIG.superAdminId) && ctx.from?.id === BOT_CONFIG.superAdminId;
}

/**
 * 按行分组按钮
 * @param buttons 按钮列表
 * @returns 二维数组，外层为行，内层为同一行的按钮
 */
function groupButtonsByRow(buttons: WelcomeButton[]): WelcomeButton[][] {
    const rows: WelcomeButton[][] = [];
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
function countRows(buttons: WelcomeButton[]): number {
    return groupButtonsByRow(buttons).length;
}

/**
 * 构建配置面板文案
 * @param content 欢迎语文字
 * @param buttons 按钮列表
 * @param chatId 已配置的群组 ID，未配置时为 null
 * @returns 面板文案（HTML）
 */
function buildPanelText(content: string, buttons: WelcomeButton[], chatId: number | null): string {
    const contentText = content ? content : '<i>-</i>';
    const chatIdText = chatId === null ? '<i>-</i>' : `<code>${chatId}</code>`;
    const rowsText = groupButtonsByRow(buttons).map(
        (row, index) => `${index + 1}. ${row.map((button) => escapeHtml(button.text)).join(' | ')}`
    );

    return [
        '<tg-emoji emoji-id="4996755833950831347">🎉</tg-emoji><b> 机器人配置</b>',
        '',
        '<b>群组 ID</b>',
        chatIdText,
        '',
        '<b>欢迎文字</b>',
        contentText,
        '',
        `<b>按钮（${buttons.length} 个 / ${rowsText.length} 行，最多 ${WELCOME_MAX_ROWS} 行）</b>`,
        rowsText.length ? rowsText.join('\n') : '<i>-</i>',
        '',
        '<i>仅对无参 /start 命令生效</i>',
    ].join('\n');
}

/**
 * 构建配置主面板键盘
 * @returns 内联键盘
 */
function buildPanelKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
        .text('配置双向群组ID', 'wcfg:group')
        .icon('5260687681733533075')
        .row()
        .text('修改文字', 'wcfg:text')
        .icon('5258215635996908355')
        .text('修改按钮', 'wcfg:buttons')
        .icon('5258215635996908355')
        .row()
        .text('预览', 'wcfg:preview')
        .icon('5258254475386167466')
        .text('清空', 'wcfg:clear')
        .icon('5258130763148172425')
        .row()
        .text('群组管理', 'gcfg:panel')
        .icon('5258513401784573443');
}

/**
 * 构建按钮管理面板文案
 * @param buttons 按钮列表
 * @returns 面板文案（HTML）
 */
function buildButtonsText(buttons: WelcomeButton[]): string {
    const rows = groupButtonsByRow(buttons);
    const lines = rows.length
        ? rows.map(
            (row, index) =>
                `第 ${index + 1} 行：${row.map((button) => escapeHtml(button.text)).join(' | ')}`
        )
        : ['<i>暂无按钮，点击下方「添加」新增</i>'];

    return [
        '<tg-emoji emoji-id="5226513232549664618">🔢</tg-emoji><b> 按钮管理</b>',
        '',
        ...lines,
        '',
        `<i>按钮最多 ${WELCOME_MAX_ROWS} 行，仅支持 URL 链接</i>`,
    ].join('\n');
}

/**
 * 构建按钮管理面板键盘
 * @param buttons 按钮列表
 * @returns 内联键盘
 */
function buildButtonsKeyboard(buttons: WelcomeButton[]): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    for (const button of buttons) {
        const label = button.text.length > 20 ? `${button.text.slice(0, 20)}…` : button.text;
        keyboard.text(`删除：${label}`, `wcfg:del:${button.id}`).icon('5258130763148172425').row();
    }
    if (countRows(buttons) < WELCOME_MAX_ROWS) {
        keyboard.text('添加', 'wcfg:add').icon('5258108352008823107').row();
    }
    keyboard.text('返回', 'wcfg:panel').icon('5258236805890710909');
    return keyboard;
}

/**
 * 发送配置主面板（新消息）
 * @param ctx 机器人上下文
 * @returns 发送完成后的 Promise
 */
async function replyPanel(ctx: Context): Promise<void> {
    const [{ content, buttons }, chatId] = await Promise.all([getWelcomeConfig(), getGroupChatId()]);
    await ctx.reply(buildPanelText(content, buttons, chatId), {
        parse_mode: 'HTML',
        reply_markup: buildPanelKeyboard(),
    });
}

/**
 * 编辑当前面板消息，内容未变化时忽略错误
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
        logger.warn(`编辑配置面板失败: ${err instanceof Error ? err.message : err}`);
    }
}

/**
 * 从输入状态中提取原面板消息定位信息
 * @param state 输入状态
 * @returns 面板消息定位信息，缺失时返回 undefined
 */
function buildPanelTarget(state: ConfigState): PanelTarget | undefined {
    if (!state.panelChatId || !state.panelMessageId) return undefined;
    return { chatId: state.panelChatId, messageId: state.panelMessageId };
}

/**
 * 发送输入提示并记录原面板与提示消息信息，便于输入完成后就地刷新面板
 * @param ctx 机器人上下文
 * @param fromId 操作者用户 ID
 * @param type 输入类型
 * @param promptText 提示文案
 * @returns 发送完成后的 Promise
 */
async function sendInputPrompt(
    ctx: Context,
    fromId: number,
    type: ConfigStateType,
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
async function deleteInputMessages(ctx: Context, state: ConfigState): Promise<void> {
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
            logger.warn(`删除配置输入消息失败: ${err instanceof Error ? err.message : err}`);
        }
    }
}

/**
 * 输入完成后刷新原面板，原面板信息缺失时改为发送新面板
 * @param ctx 机器人上下文
 * @param state 输入状态
 * @returns 刷新完成后的 Promise
 */
async function refreshPanelAfterInput(ctx: Context, state: ConfigState): Promise<void> {
    const target = buildPanelTarget(state);
    const [{ content, buttons }, chatId] = await Promise.all([getWelcomeConfig(), getGroupChatId()]);
    const text = buildPanelText(content, buttons, chatId);

    if (!target) {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: buildPanelKeyboard() });
        return;
    }
    await editPanel(ctx, text, buildPanelKeyboard(), target);
}

/**
 * 注册超级管理员命令菜单，使 /config 仅对超级管理员可见
 * @param bot 机器人实例
 * @returns 注册完成后的 Promise
 */
async function registerSuperAdminCommands(bot: Bot): Promise<void> {
    if (!BOT_CONFIG.superAdminId) return;

    try {
        await bot.init();
        await bot.api.setMyCommands(
            [
                { command: 'start', description: '开始使用' },
                { command: 'config', description: '机器人配置' },
            ],
            { scope: { type: 'chat', chat_id: BOT_CONFIG.superAdminId } }
        );
        logger.info('超级管理员命令菜单注册完成');
    } catch (err) {
        logger.error(`超级管理员命令菜单注册失败: ${err instanceof Error ? err.stack : err}`);
    }
}

/**
 * 注册 /config 命令与相关回调，仅超级管理员可用
 * @param bot 机器人实例
 * @returns 注册完成后的 Promise
 */
export function registerConfigHandler(bot: Bot): void {
    // /config 命令：打开欢迎语配置面板
    bot.command('config', async (ctx: Context): Promise<void> => {
        if (!isSuperAdmin(ctx)) {
            await ctx.reply('无权限使用该命令。');
            return;
        }

        try {
            if (ctx.from?.id !== undefined) {
                await deletePendingState(ctx.from.id);
            }
            await replyPanel(ctx);
        } catch (err) {
            logger.error(`打开欢迎语配置面板失败: ${err instanceof Error ? err.stack : err}`);
            await ctx.reply('打开配置面板失败，请稍后重试。');
        }
    });

    // 面板按钮回调
    bot.callbackQuery(/^wcfg:/, async (ctx): Promise<void> => {
        const fromId = ctx.from?.id;
        if (fromId === undefined || !isSuperAdmin(ctx)) {
            await ctx.answerCallbackQuery({ text: '无权限', show_alert: true });
            return;
        }

        const action = ctx.callbackQuery.data.slice('wcfg:'.length);
        await ctx.answerCallbackQuery();

        try {
            if (action === 'panel') {
                await deletePendingState(fromId);
                const [{ content, buttons }, chatId] = await Promise.all([
                    getWelcomeConfig(),
                    getGroupChatId(),
                ]);
                await editPanel(ctx, buildPanelText(content, buttons, chatId), buildPanelKeyboard());
                return;
            }

            if (action === 'group') {
                await sendInputPrompt(
                    ctx,
                    fromId,
                    'awaitGroupId',
                    '请发送要配置的群组 ID（可在目标群组中发送 /id 获取）。\n发送 /cancel 取消操作。'
                );
                return;
            }

            if (action === 'buttons') {
                await deletePendingState(fromId);
                const buttons = await getWelcomeButtons();
                await editPanel(ctx, buildButtonsText(buttons), buildButtonsKeyboard(buttons));
                return;
            }

            if (action === 'text') {
                await sendInputPrompt(
                    ctx,
                    fromId,
                    'awaitText',
                    '请发送新的欢迎语文字（支持 Telegram HTML 格式）。\n发送 /cancel 取消操作。'
                );
                return;
            }

            if (action === 'add') {
                const buttons = await getWelcomeButtons();
                if (countRows(buttons) >= WELCOME_MAX_ROWS) {
                    await ctx.reply(`按钮行数已达上限（${WELCOME_MAX_ROWS} 行），请先删除后再添加。`);
                    return;
                }
                await sendInputPrompt(
                    ctx,
                    fromId,
                    'awaitButton',
                    '请发送按钮信息，每行代表键盘的一行，同一行多个按钮用 & 分隔：\n' +
                    '官方网站|https://example.com\n' +
                    '官方网站|https://example.com&帮助中心|https://example.com/help\n\n' +
                    `最多 ${WELCOME_MAX_ROWS} 行，发送 /cancel 取消操作。`
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
                await removeWelcomeButton(id);
                logger.info(`超级管理员删除欢迎语按钮: userId=${fromId}, buttonId=${id}`);
                const buttons = await getWelcomeButtons();
                await editPanel(ctx, buildButtonsText(buttons), buildButtonsKeyboard(buttons));
                return;
            }

            if (action === 'preview') {
                const { content, buttons } = await getWelcomeConfig();
                if (!content) {
                    await ctx.reply('尚未配置欢迎语文字，请先设置文字后再预览。');
                    return;
                }
                const previewMessage = await ctx.reply(content, {
                    parse_mode: 'HTML',
                    link_preview_options: { is_disabled: true },
                    ...(buttons.length ? { reply_markup: buildWelcomeKeyboard(buttons) } : {}),
                });

                setTimeout(() => {
                    ctx.api.deleteMessage(previewMessage.chat.id, previewMessage.message_id).catch((err) => {
                        logger.warn(`删除预览消息失败: ${err instanceof Error ? err.message : err}`);
                    });
                }, PREVIEW_AUTO_DELETE_MS);
                return;
            }

            if (action === 'clear') {
                await deletePendingState(fromId);
                await editPanel(
                    ctx,
                    '确认清空欢迎语配置（文字与按钮）？此操作不可恢复。',
                    new InlineKeyboard().text('✅ 确认清空', 'wcfg:clear:confirm').row().text('« 返回', 'wcfg:panel')
                );
                return;
            }

            if (action === 'clear:confirm') {
                await deletePendingState(fromId);
                await clearWelcome();
                logger.info(`超级管理员清空欢迎语配置: userId=${fromId}`);
                const [{ content, buttons }, chatId] = await Promise.all([
                    getWelcomeConfig(),
                    getGroupChatId(),
                ]);
                await editPanel(
                    ctx,
                    `欢迎语配置已清空。\n\n${buildPanelText(content, buttons, chatId)}`,
                    buildPanelKeyboard()
                );
                return;
            }
        } catch (err) {
            logger.error(`欢迎语配置回调处理失败: ${err instanceof Error ? err.stack : err}`);
            await ctx.reply('操作失败，请稍后重试。');
        }
    });

    // 接收超级管理员发送的配置内容
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

            if (state.type === 'awaitText') {
                if (!text) {
                    await ctx.reply('欢迎语文字不能为空，请重新发送，或发送 /cancel 取消操作。');
                    return;
                }
                if (text.length > MAX_CONTENT_LENGTH) {
                    await ctx.reply(`欢迎语文字过长，最多 ${MAX_CONTENT_LENGTH} 个字符。`);
                    return;
                }

                await setWelcomeContent(text);
                await deletePendingState(fromId);
                logger.info(`超级管理员更新欢迎语文字: userId=${fromId}, length=${text.length}`);
                await deleteInputMessages(ctx, state);
                await refreshPanelAfterInput(ctx, state);
                return;
            }

            if (state.type === 'awaitGroupId') {
                if (!/^-?\d{1,20}$/.test(text)) {
                    await ctx.reply('群组 ID 格式不正确，请发送数字形式的群组 ID（负数），或发送 /cancel 取消操作。');
                    return;
                }

                const chatId = Number(text);
                if (!Number.isSafeInteger(chatId) || chatId === 0) {
                    await ctx.reply('群组 ID 无效，请重新发送，或发送 /cancel 取消操作。');
                    return;
                }

                await setGroupChatId(chatId);
                await deletePendingState(fromId);
                logger.info(`超级管理员更新群组 ID: userId=${fromId}, chatId=${chatId}`);
                await deleteInputMessages(ctx, state);
                await refreshPanelAfterInput(ctx, state);
                return;
            }

            // 按钮输入：每行一个键盘行，行内多个按钮以 & 分隔
            const inputLines = text
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean);

            if (!inputLines.length) {
                await ctx.reply('格式不正确，请按「按钮文字|链接」发送，或发送 /cancel 取消操作。');
                return;
            }
            if (inputLines.length > WELCOME_MAX_ROWS) {
                await ctx.reply(`一次最多发送 ${WELCOME_MAX_ROWS} 行按钮。`);
                return;
            }

            const parsedRows: WelcomeButtonInput[][] = [];
            for (const line of inputLines) {
                const segments = line
                    .split('&')
                    .map((item) => item.trim())
                    .filter(Boolean);
                const row: WelcomeButtonInput[] = [];

                for (const segment of segments) {
                    const [rawText, ...rest] = segment.split(/[|｜]/);
                    const buttonText = (rawText ?? '').trim();
                    const url = rest.join('|').trim();

                    if (!buttonText || !url) {
                        await ctx.reply(`格式不正确：「${segment}」，请按「按钮文字|链接」发送，或发送 /cancel 取消操作。`);
                        return;
                    }
                    if (buttonText.length > MAX_BUTTON_TEXT_LENGTH) {
                        await ctx.reply(`按钮文字过长（「${buttonText}」），最多 ${MAX_BUTTON_TEXT_LENGTH} 个字符。`);
                        return;
                    }
                    if (!/^https?:\/\/\S+$/i.test(url) || url.length > MAX_BUTTON_URL_LENGTH) {
                        await ctx.reply(
                            `链接无效（「${url}」），请提供以 http:// 或 https:// 开头且长度不超过 ${MAX_BUTTON_URL_LENGTH} 的链接。`
                        );
                        return;
                    }

                    row.push({ text: buttonText, url });
                }

                if (!row.length) continue;
                parsedRows.push(row);
            }

            if (!parsedRows.length) {
                await ctx.reply('未解析到有效按钮，请按「按钮文字|链接」发送，或发送 /cancel 取消操作。');
                return;
            }

            const buttons = await getWelcomeButtons();
            if (countRows(buttons) + parsedRows.length > WELCOME_MAX_ROWS) {
                await ctx.reply(
                    `按钮行数超出上限（最多 ${WELCOME_MAX_ROWS} 行），当前已有 ${countRows(buttons)} 行，本次最多可添加 ${WELCOME_MAX_ROWS - countRows(buttons)} 行。`
                );
                return;
            }

            await addWelcomeButtons(parsedRows);
            await deletePendingState(fromId);
            logger.info(`超级管理员新增欢迎语按钮: userId=${fromId}, rows=${parsedRows.length}`);
            await deleteInputMessages(ctx, state);
            await refreshPanelAfterInput(ctx, state);
        } catch (err) {
            logger.error(`欢迎语配置保存失败: ${err instanceof Error ? err.stack : err}`);
            await ctx.reply('配置保存失败，请稍后重试。');
        }
    });

    void registerSuperAdminCommands(bot);
}
