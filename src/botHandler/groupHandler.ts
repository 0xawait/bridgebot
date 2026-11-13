import { InlineKeyboard, InputFile, type Bot, type Context } from 'grammy';
import logger from '../services/loggerService.js';
import {
    addGroupKeywords,
    addGroupWhitelistUsers,
    BUILTIN_GROUP_KEYWORDS,
    BUILTIN_GROUP_REGEXES,
    BUILTIN_KEYWORD_CATEGORIES,
    findEnabledGroup,
    getGroupMaxTextLength,
    getGroupRules,
    GROUP_RULE_KEYS,
    listEnabledGroups,
    listGroupKeywordRows,
    listGroupWhitelist,
    markGroupLeft,
    removeGroupKeywords,
    removeGroupWhitelistUsers,
    saveGroup,
    setGroupMaxTextLength,
    setGroupRule,
    type GroupInfo,
    type GroupRuleConfig,
    type GroupRuleKey,
} from '../services/groupService.js';
import { escapeHtml } from '../utils/html.js';
import {
    clearGroupGuardCache,
    DEFAULT_MAX_TEXT_LENGTH,
    refreshGroupGuardCache,
} from '../services/groupGuardCacheService.js';
import redis from '../services/redisService.js';
import { isSuperAdmin } from './configHandler.js';

/** 群组管理回调前缀 */
const GROUP_CALLBACK_PREFIX = 'gcfg:';

/** 群组按钮每行展示数量 */
const GROUPS_PER_ROW = 2;

/** 群组规则按钮每行展示数量 */
const GROUP_RULES_PER_ROW = 2;

/** 群组管理数量上限 */
const MAX_MANAGE_GROUPS = 20;

/** 群组按钮文字最大长度 */
const MAX_GROUP_BUTTON_TEXT_LENGTH = 24;

/** 单个关键词最大长度 */
const MAX_KEYWORD_LENGTH = 64;

/** 长文本阈值最小值（字符数） */
const MIN_TEXT_LENGTH = 10;

/** 长文本阈值最大值（字符数，与 Telegram 单条消息上限一致） */
const MAX_TEXT_LENGTH = 4096;

/** 群组管理输入状态缓存 Key 前缀 */
const GROUP_STATE_KEY_PREFIX = 'group:admin:state:';

/** 群组管理输入状态有效期（秒） */
const GROUP_STATE_TTL_SECONDS = 600;

/** 群组管理等待输入的输入类型 */
type GroupPendingStateType =
    | 'maxTextLength'
    | 'addKeyword'
    | 'delKeyword'
    | 'addWhitelist'
    | 'delWhitelist';

/** 已支持的群组管理输入类型 */
const GROUP_PENDING_STATE_TYPES: GroupPendingStateType[] = [
    'maxTextLength',
    'addKeyword',
    'delKeyword',
    'addWhitelist',
    'delWhitelist',
];

/** 群组管理等待输入状态 */
type GroupPendingState = {
    type: GroupPendingStateType;
    chatId: number;
    /** 原面板消息所在会话 ID */
    panelChatId?: number | undefined;
    /** 原面板消息 ID */
    panelMessageId?: number | undefined;
    /** 输入提示消息 ID */
    promptMessageId?: number | undefined;
};

/** 面板消息定位信息 */
type PanelTarget = { chatId: number; messageId: number };

/**
 * 拼接群组管理输入状态缓存 Key
 * @param userId 用户 ID
 * @returns Redis Key
 */
function buildStateKey(userId: number): string {
    return `${GROUP_STATE_KEY_PREFIX}${userId}`;
}

/**
 * 写入群组管理输入状态
 * @param userId 用户 ID
 * @param state 输入状态
 * @returns 写入完成后的 Promise
 */
async function setPendingState(userId: number, state: GroupPendingState): Promise<void> {
    await redis.set(buildStateKey(userId), JSON.stringify(state), 'EX', GROUP_STATE_TTL_SECONDS);
}

/**
 * 读取群组管理输入状态
 * @param userId 用户 ID
 * @returns 输入状态，不存在或数据异常时返回 null
 */
async function getPendingState(userId: number): Promise<GroupPendingState | null> {
    const key = buildStateKey(userId);
    let raw: string | null;

    try {
        raw = await redis.get(key);
    } catch (err) {
        logger.error(`读取群组管理输入状态失败: ${err instanceof Error ? err.stack : err}`);
        return null;
    }

    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw) as GroupPendingState;
        if (
            Number.isSafeInteger(parsed.chatId) &&
            GROUP_PENDING_STATE_TYPES.includes(parsed.type)
        ) {
            return parsed;
        }
    } catch {
        // 数据异常时按无状态处理
    }

    await redis.del(key).catch(() => undefined);
    return null;
}

/**
 * 清除群组管理输入状态
 * @param userId 用户 ID
 * @returns 清除完成后的 Promise
 */
async function deletePendingState(userId: number): Promise<void> {
    await redis.del(buildStateKey(userId));
}

/**
 * 从输入状态中提取原面板消息定位信息
 * @param state 输入状态
 * @returns 面板消息定位信息，缺失时返回 undefined
 */
function buildPanelTarget(state: GroupPendingState): PanelTarget | undefined {
    if (!state.panelChatId || !state.panelMessageId) return undefined;
    return { chatId: state.panelChatId, messageId: state.panelMessageId };
}

/**
 * 删除输入提示消息与用户回复的消息
 * @param ctx 机器人上下文
 * @param state 输入状态
 * @returns 删除完成后的 Promise
 */
async function deleteInputMessages(ctx: Context, state: GroupPendingState): Promise<void> {
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
            logger.warn(`删除群组管理输入消息失败: ${err instanceof Error ? err.message : err}`);
        }
    }
}

/**
 * 导出群组自定义关键词为 txt 文件
 * @param ctx 机器人上下文
 * @param chatId 群组 ID
 * @returns 导出完成后的 Promise
 */
async function exportGroupKeywords(ctx: Context, chatId: number): Promise<void> {
    const rows = await listGroupKeywordRows(chatId);
    if (!rows.length) {
        await ctx.reply('暂无可导出的自定义关键词。');
        return;
    }

    const content = rows.map((row) => row.keyword).join('\n');
    const file = new InputFile(new TextEncoder().encode(content), `group-${chatId}-keywords.txt`);
    await ctx.replyWithDocument(file, { caption: `共 ${rows.length} 个自定义关键词` });
}

/**
 * 导出群组白名单用户为 txt 文件
 * @param ctx 机器人上下文
 * @param chatId 群组 ID
 * @returns 导出完成后的 Promise
 */
async function exportGroupWhitelist(ctx: Context, chatId: number): Promise<void> {
    const whitelist = await listGroupWhitelist(chatId);
    if (!whitelist.length) {
        await ctx.reply('暂无可导出的白名单用户。');
        return;
    }

    const content = whitelist.join('\n');
    const file = new InputFile(new TextEncoder().encode(content), `group-${chatId}-whitelist.txt`);
    await ctx.replyWithDocument(file, { caption: `共 ${whitelist.length} 个白名单用户` });
}

/**
 * 发送输入提示并记录原面板与提示消息信息，便于输入完成后就地刷新面板
 * @param ctx 机器人上下文
 * @param fromId 操作者用户 ID
 * @param state 输入状态（类型与群组 ID）
 * @param promptText 提示文案
 * @returns 发送完成后的 Promise
 */
async function sendInputPrompt(
    ctx: Context,
    fromId: number,
    state: Pick<GroupPendingState, 'type' | 'chatId'>,
    promptText: string
): Promise<void> {
    const prompt = await ctx.reply(promptText);
    await setPendingState(fromId, {
        ...state,
        panelChatId: ctx.chat?.id,
        panelMessageId: ctx.callbackQuery?.message?.message_id,
        promptMessageId: prompt.message_id,
    });
}

/** 群组自动删除规则名称 */
const GROUP_RULE_LABELS: Record<GroupRuleKey, string> = {
    keyword: '关键词消息',
    link: '链接消息',
    forward: '转发消息',
    sticker: '贴纸消息',
    photo: '图片消息',
    video: '视频消息',
    file: '文件消息',
    inline: '内联消息',
    reply_chat: '引用消息',
    sender_chat: '马甲消息',
    contact: '名片消息',
    long_text: '长文本消息',
};

/** 邀请机器人入群时申请的管理员权限 */
const GROUP_INVITE_ADMIN_RIGHTS = [
    'change_info',
    'post_messages',
    'edit_messages',
    'delete_messages',
    'restrict_members',
    'invite_users',
    'pin_messages',
    'manage_topics',
    'manage_video_chats',
    'manage_chat',
    'post_stories',
    'edit_stories',
    'delete_stories',
    'manage_direct_messages',
    'manage_tags',
].join('+');

/**
 * 构建邀请机器人入群的链接
 * @param botUsername 机器人用户名
 * @returns startgroup 邀请链接
 */
function buildInviteLink(botUsername: string): string {
    return `https://t.me/${botUsername}?startgroup=true&admin=${GROUP_INVITE_ADMIN_RIGHTS}`;
}

/**
 * 构建群组管理面板文案
 * @param groups 已加入的群组列表
 * @returns 面板文案（HTML）
 */
function buildGroupsText(groups: GroupInfo[]): string {
    const lines = groups.length
        ? groups.length >= MAX_MANAGE_GROUPS
            ? [`<i>群组数量已达管理上限（${MAX_MANAGE_GROUPS} 个），暂不可添加新群组</i>`]
            : []
        : ['<i>暂无已加入的群组</i>'];

    return [
        '<tg-emoji emoji-id="5258513401784573443">👥</tg-emoji> <b>群组管理</b>',
        '',
        `<b>已加入群组（${groups.length} 个）</b>`,
        ...lines,
        '',
        '<i>机器人被拉入新群组后会自动同步至此列表</i>',
        `<i>作者懒得写翻页 因此最多管理${MAX_MANAGE_GROUPS}个群组</i>`,
    ].join('\n');
}

/**
 * 构建群组按钮文字，超长时截断
 * @param title 群组标题
 * @returns 按钮文字
 */
function buildGroupButtonText(title: string): string {
    return title.length > MAX_GROUP_BUTTON_TEXT_LENGTH
        ? `${title.slice(0, MAX_GROUP_BUTTON_TEXT_LENGTH)}…`
        : title;
}

/**
 * 构建群组管理面板键盘
 * @param groups 已加入的群组列表
 * @param inviteLink 邀请机器人入群链接，无法获取机器人用户名时为 null
 * @returns 内联键盘
 */
function buildGroupsKeyboard(groups: GroupInfo[], inviteLink: string | null): InlineKeyboard {
    const keyboard = new InlineKeyboard();

    // 群组按钮每行两个
    groups.forEach((group, index) => {
        keyboard
            .text(buildGroupButtonText(group.title), `${GROUP_CALLBACK_PREFIX}group:${group.chatId}`)
            .icon('5258513401784573443');
        if (index % GROUPS_PER_ROW === GROUPS_PER_ROW - 1) {
            keyboard.row();
        }
    });
    if (groups.length % GROUPS_PER_ROW !== 0) {
        keyboard.row();
    }

    // 达到管理上限后不再展示添加按钮
    if (inviteLink && groups.length < MAX_MANAGE_GROUPS) {
        keyboard.url('添加新群组', inviteLink).icon('5323404142809467476').row();
    }
    return keyboard
        .text('刷新列表', `${GROUP_CALLBACK_PREFIX}panel`)
        .icon('5258420634785947640')
        .text('返回', 'wcfg:panel')
        .icon('5258236805890710909');
}

/**
 * 渲染群组管理面板
 * @param ctx 机器人上下文
 * @param edit 是否编辑当前消息（false 时发送新消息）
 * @returns 渲染完成后的 Promise
 */
async function renderGroupsPanel(ctx: Context, edit: boolean): Promise<void> {
    const groups = await listEnabledGroups();
    const botUsername = ctx.me.username;
    const text = buildGroupsText(groups);
    const keyboard = buildGroupsKeyboard(groups, botUsername ? buildInviteLink(botUsername) : null);

    if (!edit) {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
        return;
    }

    try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch (err) {
        logger.warn(`编辑群组管理面板失败: ${err instanceof Error ? err.message : err}`);
    }
}

/**
 * 构建群组配置面板文案
 * @param group 群组信息
 * @param rules 自动删除规则开关
 * @param maxTextLength 长文本删除阈值
 * @returns 面板文案（HTML）
 */
function buildGroupConfigText(
    group: GroupInfo,
    rules: GroupRuleConfig,
    maxTextLength: number
): string {
    const enabledCount = GROUP_RULE_KEYS.filter((rule) => rules[rule]).length;

    return [
        '<tg-emoji emoji-id="5258513401784573443">👥</tg-emoji> <b>群组配置</b>',
        '',
        `<b>群组</b>：${escapeHtml(group.title)}`,
        `<b>ID</b>：<code>${group.chatId}</code>`,
        '',
        `<b>自动删除规则（已开启 ${enabledCount} / ${GROUP_RULE_KEYS.length}）</b>`,
        `<b>长文本阈值</b>：${maxTextLength} 字符`,
        '<i>点击下方按钮切换对应规则的开启状态</i>',
    ].join('\n');
}

/**
 * 构建群组配置面板键盘
 * @param group 群组信息
 * @param rules 自动删除规则开关
 * @param maxTextLength 长文本删除阈值
 * @returns 内联键盘
 */
function buildGroupConfigKeyboard(
    group: GroupInfo,
    rules: GroupRuleConfig,
    maxTextLength: number
): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    GROUP_RULE_KEYS.forEach((rule, index) => {
        const enabled = rules[rule];
        const button = keyboard.text(
            `${GROUP_RULE_LABELS[rule]}${enabled ? '(开)' : '(关)'}`,
            `${GROUP_CALLBACK_PREFIX}rule:${group.chatId}:${rule}`
        );
        if (enabled) {
            button.style('success');
        }
        if (index % GROUP_RULES_PER_ROW === GROUP_RULES_PER_ROW - 1) {
            keyboard.row();
        }
    });
    if (GROUP_RULE_KEYS.length % GROUP_RULES_PER_ROW !== 0) {
        keyboard.row();
    }

    return keyboard
        .text(`长文本阈值：${maxTextLength}`, `${GROUP_CALLBACK_PREFIX}maxtext:${group.chatId}`)
        .icon('5258215635996908355')
        .row()
        .text('关键词配置', `${GROUP_CALLBACK_PREFIX}kw:${group.chatId}`)
        .icon('5258108352008823107')
        .row()
        .text('白名单', `${GROUP_CALLBACK_PREFIX}wl:${group.chatId}`)
        .icon('5258430848218176413')
        .row()
        .text('返回', `${GROUP_CALLBACK_PREFIX}panel`)
        .icon('5258236805890710909');
}

/**
 * 构建关键词配置面板文案
 * @param group 群组信息
 * @param keywordCount 自定义关键词数量
 * @returns 面板文案（HTML）
 */
function buildKeywordsText(group: GroupInfo, keywordCount: number): string {
    const builtinLines = BUILTIN_KEYWORD_CATEGORIES.length
        ? BUILTIN_KEYWORD_CATEGORIES.map(
            (category) =>
                `· ${escapeHtml(category.name)}：${category.keywords.length} 词 / ${category.regexes.length} 正则`
        )
        : ['<i>暂无内置词库</i>'];

    return [
        '<tg-emoji emoji-id="5296385246579670377">🏷</tg-emoji><b>关键词配置</b>',
        '',
        `<b>群组</b>：${escapeHtml(group.title)}`,
        `<b>ID</b>：<code>${group.chatId}</code>`,
        '',
        `<b>内置词库（${BUILTIN_GROUP_KEYWORDS.length} 词 / ${BUILTIN_GROUP_REGEXES.length} 正则）</b>`,
        ...builtinLines,
        '<i>维护于 config/builtinKeywords.json，对所有群组生效</i>',
        '',
        `<b>自定义关键词：${keywordCount} 个</b>`,
        '<i>点击下方「导出关键词」查看明细</i>',
        '',
        '<i>同步生效于「关键词消息」规则，需开启该规则才会删除</i>',
    ].join('\n');
}

/**
 * 构建关键词配置面板键盘
 * @param group 群组信息
 * @param keywordCount 自定义关键词数量
 * @returns 内联键盘
 */
function buildKeywordsKeyboard(group: GroupInfo, keywordCount: number): InlineKeyboard {
    const keyboard = new InlineKeyboard()
        .text('添加关键词', `${GROUP_CALLBACK_PREFIX}kw:add:${group.chatId}`)
        .icon('5258108352008823107')
        .row();

    if (keywordCount > 0) {
        keyboard
            .text('删除关键词', `${GROUP_CALLBACK_PREFIX}kw:del:${group.chatId}`)
            .icon('5258130763148172425')
            .text('导出关键词', `${GROUP_CALLBACK_PREFIX}kw:export:${group.chatId}`)
            .icon('5260379144167890225')
            .row();
    }

    return keyboard
        .text('返回', `${GROUP_CALLBACK_PREFIX}group:${group.chatId}`)
        .icon('5258236805890710909');
}

/**
 * 构建白名单面板文案
 * @param group 群组信息
 * @param whitelistCount 白名单用户数量
 * @returns 面板文案（HTML）
 */
function buildWhitelistText(group: GroupInfo, whitelistCount: number): string {
    return [
        '<tg-emoji emoji-id="5258430848218176413">🎭</tg-emoji><b>白名单</b>',
        '',
        `<b>群组</b>：${escapeHtml(group.title)}`,
        `<b>ID</b>：<code>${group.chatId}</code>`,
        '',
        `<b>白名单用户：${whitelistCount} 个</b>`,
        '<i>点击下方「导出白名单」查看明细</i>',
        '',
        '<i>白名单用户发送的消息不会触发任何自动删除规则</i>',
    ].join('\n');
}

/**
 * 构建白名单面板键盘
 * @param group 群组信息
 * @param whitelistCount 白名单用户数量
 * @returns 内联键盘
 */
function buildWhitelistKeyboard(group: GroupInfo, whitelistCount: number): InlineKeyboard {
    const keyboard = new InlineKeyboard()
        .text('添加白名单用户', `${GROUP_CALLBACK_PREFIX}wl:add:${group.chatId}`)
        .icon('5258108352008823107')
        .row();

    if (whitelistCount > 0) {
        keyboard
            .text('删除白名单用户', `${GROUP_CALLBACK_PREFIX}wl:del:${group.chatId}`)
            .icon('5258130763148172425')
            .text('导出白名单', `${GROUP_CALLBACK_PREFIX}wl:export:${group.chatId}`)
            .icon('5260379144167890225')
            .row();
    }

    return keyboard
        .text('返回', `${GROUP_CALLBACK_PREFIX}group:${group.chatId}`)
        .icon('5258236805890710909');
}

/**
 * 发送或编辑面板消息，编辑内容未变化时忽略错误
 * @param ctx 机器人上下文
 * @param text 面板文案
 * @param keyboard 面板键盘
 * @param edit 是否编辑当前消息（false 时发送新消息）
 * @param target 需要编辑的原面板消息，传入时以此为准
 * @returns 渲染完成后的 Promise
 */
async function renderPanel(
    ctx: Context,
    text: string,
    keyboard: InlineKeyboard,
    edit: boolean,
    target?: PanelTarget
): Promise<void> {
    if (!edit) {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
        return;
    }

    try {
        if (target) {
            await ctx.api.editMessageText(target.chatId, target.messageId, text, {
                parse_mode: 'HTML',
                reply_markup: keyboard,
            });
            return;
        }
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch (err) {
        logger.warn(`编辑群组面板失败: ${err instanceof Error ? err.message : err}`);
    }
}

/**
 * 渲染群组配置面板
 * @param ctx 机器人上下文
 * @param chatId 群组 ID
 * @param edit 是否编辑当前消息
 * @param target 需要编辑的原面板消息
 * @returns 渲染完成后的 Promise
 */
async function renderGroupConfigPanel(
    ctx: Context,
    chatId: number,
    edit = true,
    target?: PanelTarget
): Promise<void> {
    const [group, rules, maxTextLength] = await Promise.all([
        findEnabledGroup(chatId),
        getGroupRules(chatId),
        getGroupMaxTextLength(chatId),
    ]);

    if (!group || !rules) {
        await renderPanel(
            ctx,
            '该群组不存在或机器人已退出。',
            new InlineKeyboard().text('返回', `${GROUP_CALLBACK_PREFIX}panel`),
            edit,
            target
        );
        return;
    }

    const limit = maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
    await renderPanel(
        ctx,
        buildGroupConfigText(group, rules, limit),
        buildGroupConfigKeyboard(group, rules, limit),
        edit,
        target
    );
}

/**
 * 渲染关键词配置面板
 * @param ctx 机器人上下文
 * @param chatId 群组 ID
 * @param edit 是否编辑当前消息
 * @param target 需要编辑的原面板消息
 * @returns 渲染完成后的 Promise
 */
async function renderKeywordsPanel(
    ctx: Context,
    chatId: number,
    edit = true,
    target?: PanelTarget
): Promise<void> {
    const [group, keywords] = await Promise.all([
        findEnabledGroup(chatId),
        listGroupKeywordRows(chatId),
    ]);

    if (!group) {
        await renderPanel(
            ctx,
            '该群组不存在或机器人已退出。',
            new InlineKeyboard().text('返回', `${GROUP_CALLBACK_PREFIX}panel`),
            edit,
            target
        );
        return;
    }

    await renderPanel(
        ctx,
        buildKeywordsText(group, keywords.length),
        buildKeywordsKeyboard(group, keywords.length),
        edit,
        target
    );
}

/**
 * 渲染白名单面板
 * @param ctx 机器人上下文
 * @param chatId 群组 ID
 * @param edit 是否编辑当前消息
 * @param target 需要编辑的原面板消息
 * @returns 渲染完成后的 Promise
 */
async function renderWhitelistPanel(
    ctx: Context,
    chatId: number,
    edit = true,
    target?: PanelTarget
): Promise<void> {
    const [group, whitelist] = await Promise.all([
        findEnabledGroup(chatId),
        listGroupWhitelist(chatId),
    ]);

    if (!group) {
        await renderPanel(
            ctx,
            '该群组不存在或机器人已退出。',
            new InlineKeyboard().text('返回', `${GROUP_CALLBACK_PREFIX}panel`),
            edit,
            target
        );
        return;
    }

    await renderPanel(
        ctx,
        buildWhitelistText(group, whitelist.length),
        buildWhitelistKeyboard(group, whitelist.length),
        edit,
        target
    );
}

/**
 * 注册群组管理：机器人入群/退群同步群组列表，以及群组管理面板回调
 * @param bot 机器人实例
 * @returns 注册完成后的 Promise
 */
export function registerGroupHandler(bot: Bot): void {
    // 机器人入群/退群事件：维护已加入群组列表
    bot.on('my_chat_member', async (ctx): Promise<void> => {
        const update = ctx.myChatMember;
        const chat = update.chat;
        if (chat.type !== 'group' && chat.type !== 'supergroup') return;

        const oldStatus = update.old_chat_member.status;
        const newStatus = update.new_chat_member.status;
        const wasInChat = oldStatus === 'member' || oldStatus === 'administrator' || oldStatus === 'creator';
        const isInChat =
            newStatus === 'member' ||
            newStatus === 'administrator' ||
            (newStatus === 'restricted' && update.new_chat_member.is_member);

        try {
            if (isInChat && !wasInChat) {
                await saveGroup({
                    chatId: chat.id,
                    title: chat.title,
                    username: chat.username ?? '',
                    type: chat.type,
                });
                logger.info(`机器人加入群组: chatId=${chat.id}, title=${chat.title ?? ''}`);
                await refreshGroupGuardCache(chat.id);
            } else if (!isInChat && wasInChat) {
                await markGroupLeft(chat.id);
                logger.info(`机器人退出群组: chatId=${chat.id}`);
                await clearGroupGuardCache(chat.id);
            }
        } catch (err) {
            logger.error(`同步群组状态失败: ${err instanceof Error ? err.stack : err}`);
        }
    });

    // 群组管理面板回调
    bot.callbackQuery(/^gcfg:/, async (ctx): Promise<void> => {
        if (!isSuperAdmin(ctx)) {
            await ctx.answerCallbackQuery({ text: '无权限', show_alert: true });
            return;
        }

        const action = ctx.callbackQuery.data.slice(GROUP_CALLBACK_PREFIX.length);
        const fromId = ctx.from?.id;
        await ctx.answerCallbackQuery();

        if (fromId === undefined) return;

        try {
            if (action === 'panel') {
                await renderGroupsPanel(ctx, true);
                return;
            }

            // 进入群组配置面板
            if (action.startsWith('group:')) {
                const chatId = Number(action.slice('group:'.length));
                if (!Number.isSafeInteger(chatId) || chatId === 0) return;
                await renderGroupConfigPanel(ctx, chatId);
                return;
            }

            // 切换群组自动删除规则
            if (action.startsWith('rule:')) {
                const [, chatIdText, ruleText] = action.split(':');
                const chatId = Number(chatIdText);
                if (!Number.isSafeInteger(chatId) || chatId === 0) return;
                if (!GROUP_RULE_KEYS.includes(ruleText as GroupRuleKey)) return;

                const rule = ruleText as GroupRuleKey;
                const rules = await getGroupRules(chatId);
                if (!rules) {
                    await renderGroupConfigPanel(ctx, chatId);
                    return;
                }

                await setGroupRule(chatId, rule, !rules[rule]);
                logger.info(
                    `更新群组自动删除规则: chatId=${chatId}, rule=${rule}, enabled=${!rules[rule]}`
                );
                await refreshGroupGuardCache(chatId);
                await renderGroupConfigPanel(ctx, chatId);
                return;
            }

            // 设置长文本阈值：进入等待输入
            if (action.startsWith('maxtext:')) {
                const chatId = Number(action.slice('maxtext:'.length));
                if (!Number.isSafeInteger(chatId) || chatId === 0) return;

                await sendInputPrompt(
                    ctx,
                    fromId,
                    { type: 'maxTextLength', chatId },
                    `请发送新的长文本阈值（${MIN_TEXT_LENGTH} ~ ${MAX_TEXT_LENGTH} 字符）。\n发送 /cancel 取消操作。`
                );
                return;
            }

            // 关键词配置面板及关键词操作
            if (action.startsWith('kw:')) {
                const parts = action.split(':');

                // kw:<chatId> 打开面板
                if (parts.length === 2) {
                    const chatId = Number(parts[1]);
                    if (!Number.isSafeInteger(chatId) || chatId === 0) return;
                    await renderKeywordsPanel(ctx, chatId);
                    return;
                }

                const sub = parts[1];
                const chatId = Number(parts[2]);
                if (!Number.isSafeInteger(chatId) || chatId === 0) return;

                if (sub === 'add') {
                    await sendInputPrompt(
                        ctx,
                        fromId,
                        { type: 'addKeyword', chatId },
                        '请发送要添加的关键词，多个关键词可用换行或逗号分隔，重复关键词会自动忽略，单个关键词最多 ' +
                        `${MAX_KEYWORD_LENGTH} 个字符。\n发送 /cancel 取消操作。`
                    );
                    return;
                }

                if (sub === 'export') {
                    await exportGroupKeywords(ctx, chatId);
                    return;
                }

                if (sub === 'del') {
                    await sendInputPrompt(
                        ctx,
                        fromId,
                        { type: 'delKeyword', chatId },
                        '请发送要删除的关键词，多个关键词可用换行或逗号分隔。\n发送 /cancel 取消操作。'
                    );
                    return;
                }
            }

            // 白名单面板及白名单操作
            if (action.startsWith('wl:')) {
                const parts = action.split(':');

                // wl:<chatId> 打开面板
                if (parts.length === 2) {
                    const chatId = Number(parts[1]);
                    if (!Number.isSafeInteger(chatId) || chatId === 0) return;
                    await renderWhitelistPanel(ctx, chatId);
                    return;
                }

                const sub = parts[1];
                const chatId = Number(parts[2]);
                if (!Number.isSafeInteger(chatId) || chatId === 0) return;

                if (sub === 'add') {
                    await sendInputPrompt(
                        ctx,
                        fromId,
                        { type: 'addWhitelist', chatId },
                        '请发送要加入白名单的用户 ID，多个 ID 可用换行、空格或逗号分隔。\n发送 /cancel 取消操作。'
                    );
                    return;
                }

                if (sub === 'export') {
                    await exportGroupWhitelist(ctx, chatId);
                    return;
                }

                if (sub === 'del') {
                    await sendInputPrompt(
                        ctx,
                        fromId,
                        { type: 'delWhitelist', chatId },
                        '请发送要移出白名单的用户 ID，多个 ID 可用换行、空格或逗号分隔。\n发送 /cancel 取消操作。'
                    );
                    return;
                }
            }
        } catch (err) {
            logger.error(`群组管理回调处理失败: ${err instanceof Error ? err.stack : err}`);
            await ctx.reply('操作失败，请稍后重试。');
        }
    });

    // 接收超级管理员发送的群组管理输入内容
    bot.on('message:text', async (ctx: Context, next): Promise<void> => {
        const fromId = ctx.from?.id;
        const text = ctx.message?.text?.trim();
        if (fromId === undefined || !text) {
            await next();
            return;
        }

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

        // 输入状态中不处理其他命令
        if (text.startsWith('/')) return;

        try {
            if (state.type === 'maxTextLength') {
                const length = Number(text);
                if (!/^\d{1,4}$/.test(text) || length < MIN_TEXT_LENGTH || length > MAX_TEXT_LENGTH) {
                    await ctx.reply(
                        `阈值无效，请输入 ${MIN_TEXT_LENGTH} ~ ${MAX_TEXT_LENGTH} 之间的整数，或发送 /cancel 取消操作。`
                    );
                    return;
                }

                await setGroupMaxTextLength(state.chatId, length);
                await refreshGroupGuardCache(state.chatId);
                await deletePendingState(fromId);
                logger.info(`更新长文本删除阈值: chatId=${state.chatId}, maxTextLength=${length}`);
                const target = buildPanelTarget(state);
                await deleteInputMessages(ctx, state);
                await renderGroupConfigPanel(ctx, state.chatId, Boolean(target), target);
                return;
            }

            if (state.type === 'addKeyword') {
                const items = text
                    .split(/[\n,，]/)
                    .map((item) => item.trim())
                    .filter(Boolean);

                if (!items.length) {
                    await ctx.reply('未解析到关键词，请重新发送，或发送 /cancel 取消操作。');
                    return;
                }

                const tooLong = items.find((item) => item.length > MAX_KEYWORD_LENGTH);
                if (tooLong) {
                    await ctx.reply(
                        `关键词「${tooLong}」过长，单个关键词最多 ${MAX_KEYWORD_LENGTH} 个字符，或发送 /cancel 取消操作。`
                    );
                    return;
                }

                const unique = [...new Set(items)];
                await addGroupKeywords(state.chatId, unique);
                await refreshGroupGuardCache(state.chatId);
                await deletePendingState(fromId);
                logger.info(`新增群组关键词: chatId=${state.chatId}, count=${unique.length}`);
                const target = buildPanelTarget(state);
                await deleteInputMessages(ctx, state);
                await renderKeywordsPanel(ctx, state.chatId, Boolean(target), target);
                return;
            }

            if (state.type === 'delKeyword') {
                const items = text
                    .split(/[\n,，]/)
                    .map((item) => item.trim())
                    .filter(Boolean);

                if (!items.length) {
                    await ctx.reply('未解析到关键词，请重新发送，或发送 /cancel 取消操作。');
                    return;
                }

                const removed = await removeGroupKeywords(state.chatId, [...new Set(items)]);
                await refreshGroupGuardCache(state.chatId);
                await deletePendingState(fromId);
                logger.info(
                    `删除群组关键词: chatId=${state.chatId}, requested=${items.length}, removed=${removed}`
                );
                const target = buildPanelTarget(state);
                await deleteInputMessages(ctx, state);
                await renderKeywordsPanel(ctx, state.chatId, Boolean(target), target);
                return;
            }

            if (state.type === 'addWhitelist') {
                const items = text
                    .split(/[\s,，]+/)
                    .map((item) => item.trim())
                    .filter(Boolean);
                const userIds = items.map((item) => Number(item));

                if (
                    !userIds.length ||
                    userIds.some((userId) => !Number.isSafeInteger(userId) || userId <= 0)
                ) {
                    await ctx.reply('用户 ID 格式不正确，请发送纯数字的用户 ID，或发送 /cancel 取消操作。');
                    return;
                }

                const unique = [...new Set(userIds)];
                await addGroupWhitelistUsers(state.chatId, unique);
                await refreshGroupGuardCache(state.chatId);
                await deletePendingState(fromId);
                logger.info(`新增群组白名单用户: chatId=${state.chatId}, count=${unique.length}`);
                const target = buildPanelTarget(state);
                await deleteInputMessages(ctx, state);
                await renderWhitelistPanel(ctx, state.chatId, Boolean(target), target);
                return;
            }

            if (state.type === 'delWhitelist') {
                const items = text
                    .split(/[\s,，]+/)
                    .map((item) => item.trim())
                    .filter(Boolean);
                const userIds = items.map((item) => Number(item));

                if (
                    !userIds.length ||
                    userIds.some((userId) => !Number.isSafeInteger(userId) || userId <= 0)
                ) {
                    await ctx.reply('用户 ID 格式不正确，请发送纯数字的用户 ID，或发送 /cancel 取消操作。');
                    return;
                }

                const unique = [...new Set(userIds)];
                const removed = await removeGroupWhitelistUsers(state.chatId, unique);
                await refreshGroupGuardCache(state.chatId);
                await deletePendingState(fromId);
                logger.info(
                    `移除群组白名单用户: chatId=${state.chatId}, requested=${unique.length}, removed=${removed}`
                );
                const target = buildPanelTarget(state);
                await deleteInputMessages(ctx, state);
                await renderWhitelistPanel(ctx, state.chatId, Boolean(target), target);
                return;
            }
        } catch (err) {
            logger.error(`群组管理输入处理失败: ${err instanceof Error ? err.stack : err}`);
            await ctx.reply('保存失败，请稍后重试。');
        }
    });
}
