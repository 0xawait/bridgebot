import { InlineKeyboard, type Api, type Bot, type Context } from 'grammy';
import { BOT_CONFIG } from '../config/index.js';
import logger from '../services/loggerService.js';
import { getGroupChatId } from '../services/groupConfigService.js';
import {
    deleteUserTopic,
    findUserTopicByThread,
    findUserTopicByUserId,
    saveUserTopic,
    type UserTopic,
} from '../services/userTopicService.js';
import {
    getUserMuteRemainingSeconds,
    isUserSessionMuted,
    muteUserSession,
    unmuteUserSession,
} from '../services/sessionMuteService.js';
import { escapeHtml } from '../utils/html.js';

/** Telegram 用户信息类型 */
type TelegramUser = NonNullable<Context['from']>;

/** 话题名称最大长度，与 Telegram 限制保持一致 */
const TOPIC_NAME_MAX_LENGTH = 128;

/** 相册聚合等待时长（毫秒）：Telegram 将相册拆成多条更新推送，需短暂聚合后整组发送 */
const MEDIA_GROUP_WAIT_MS = 1000;

/** 相册消息转发方向 */
type MediaGroupDirection = 'toTopic' | 'toUser';

/** 待聚合的相册消息 */
interface PendingMediaGroup {
    /** Bot API 实例 */
    api: Api;
    /** 消息来源会话 */
    fromChatId: number;
    /** 目标会话 */
    toChatId: number;
    /** 目标话题 ID，仅转发到话题时使用 */
    messageThreadId: number | undefined;
    /** 已收集的消息 ID，按到达顺序 */
    messageIds: number[];
    /** 转发方向 */
    direction: MediaGroupDirection;
    /** 聚合定时器 */
    timer: ReturnType<typeof setTimeout>;
}

/** 按 media_group_id 聚合中的相册消息 */
const pendingMediaGroups: Map<string, PendingMediaGroup> = new Map();

/**
 * 将聚合完成的相册消息整组发送，保留相册分组
 * @param key 聚合 Key
 * @returns 发送完成后的 Promise
 */
async function flushMediaGroup(key: string): Promise<void> {
    const pending = pendingMediaGroups.get(key);
    if (!pending) return;
    pendingMediaGroups.delete(key);

    // 并发处理更新时收集顺序可能与 message_id 顺序不一致，API 要求严格递增，此处去重并升序排序
    const messageIds = [...new Set(pending.messageIds)].sort((a, b) => a - b);

    try {
        if (pending.direction === 'toTopic') {
            await pending.api.forwardMessages(
                pending.toChatId,
                pending.fromChatId,
                messageIds,
                pending.messageThreadId === undefined ? {} : { message_thread_id: pending.messageThreadId }
            );
        } else {
            await pending.api.copyMessages(pending.toChatId, pending.fromChatId, messageIds);
        }
    } catch (err) {
        logger.error(`相册消息整组转发失败: ${err instanceof Error ? err.stack : err}`);
    }
}

/**
 * 将相册消息加入聚合队列，同一 media_group_id 聚合后整组发送
 * @param key 聚合 Key
 * @param pending 待聚合消息（不含定时器）
 * @returns 无
 */
function enqueueMediaGroup(key: string, pending: Omit<PendingMediaGroup, 'timer'>): void {
    const existing = pendingMediaGroups.get(key);
    if (existing) {
        existing.messageIds.push(...pending.messageIds);
        return;
    }

    const timer = setTimeout(() => {
        void flushMediaGroup(key);
    }, MEDIA_GROUP_WAIT_MS);

    pendingMediaGroups.set(key, { ...pending, timer });
}

/**
 * 拼接用户昵称
 * @param user Telegram 用户
 * @returns 昵称为空时返回用户 ID 字符串
 */
function buildNickname(user: TelegramUser): string {
    const nickname = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
    return nickname || String(user.id);
}

/**
 * 构造话题名称：昵称(用户名)
 * @param user Telegram 用户
 * @returns 符合长度限制的话题名称
 */
function buildTopicName(user: TelegramUser): string {
    const nickname = buildNickname(user);
    const name = user.username ? `${nickname}(@${user.username})` : nickname;
    return name.slice(0, TOPIC_NAME_MAX_LENGTH);
}

/** 屏蔽会话的可选时长 */
const MUTE_OPTIONS: { label: string; minutes: number }[] = [
    { label: '1小时', minutes: 60 },
    { label: '3小时', minutes: 180 },
    { label: '1天', minutes: 1440 },
    { label: '7天', minutes: 10080 },
];

/**
 * 构建会话操作键盘
 * @returns 内联键盘
 */
function buildSessionKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
        .text('屏蔽会话', 'bridge:mute')
        .icon('5258267368877989660')
        .style('primary')
        .text('关闭话题', 'bridge:close')
        .icon('5359629206948976159')
        .style('danger');
}

/**
 * 构建屏蔽时长选择键盘
 * @returns 内联键盘
 */
function buildMuteKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
        .text(MUTE_OPTIONS[0]!.label, `bridge:mute:${MUTE_OPTIONS[0]!.minutes}`)
        .icon('5258419835922030550')
        .text(MUTE_OPTIONS[1]!.label, `bridge:mute:${MUTE_OPTIONS[1]!.minutes}`)
        .icon('5258419835922030550')
        .row()
        .text(MUTE_OPTIONS[2]!.label, `bridge:mute:${MUTE_OPTIONS[2]!.minutes}`)
        .icon('5258419835922030550')
        .text(MUTE_OPTIONS[3]!.label, `bridge:mute:${MUTE_OPTIONS[3]!.minutes}`)
        .icon('5258419835922030550')
        .row()
        .text('解除屏蔽', 'bridge:unmute')
        .text('返回', 'bridge:back')
        .icon('5258236805890710909');
}

/**
 * 构建用户信息文本
 * @param info 用户昵称、用户名与 ID
 * @returns 用户信息文本（HTML）
 */
function buildUserInfoText(info: Pick<UserTopic, 'nickname' | 'username' | 'userId'>): string {
    return [
        '<tg-emoji emoji-id="5258362837411045098">👤</tg-emoji><b>用户会话</b>',
        `昵称：${escapeHtml(info.nickname)}`,
        `用户名：${info.username ? `@${escapeHtml(info.username)}` : '-'}`,
        `用户ID：<code>${info.userId}</code>`,
    ].join('\n');
}

/**
 * 格式化剩余屏蔽时长
 * @param seconds 剩余秒数
 * @returns 可读的时长描述
 */
function formatRemainingDuration(seconds: number): string {
    const totalMinutes = Math.max(1, Math.ceil(seconds / 60));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    const parts: string[] = [];
    if (days > 0) parts.push(`${days} 天`);
    if (hours > 0) parts.push(`${hours} 小时`);
    if (minutes > 0) parts.push(`${minutes} 分钟`);
    return parts.join(' ');
}

/**
 * 构建会话面板文本（用户信息 + 当前屏蔽状态）
 * @param topic 用户话题映射
 * @returns 面板文本（HTML）
 */
async function buildSessionPanelText(topic: UserTopic): Promise<string> {
    const remaining = await getUserMuteRemainingSeconds(topic.userId);
    const status =
        remaining > 0
            ? `<b>当前状态：已屏蔽</b>（剩余 ${formatRemainingDuration(remaining)}）`
            : '<b>当前状态：未屏蔽</b>';

    return [buildUserInfoText(topic), '', status].join('\n');
}

/**
 * 在指定话题中发送用户信息
 * @param ctx 机器人上下文
 * @param topic 目标群组与话题
 * @param user Telegram 用户
 * @returns 发送完成后的 Promise
 */
async function sendUserInfo(
    ctx: Context,
    topic: Pick<UserTopic, 'chatId' | 'messageThreadId'>,
    user: TelegramUser
): Promise<void> {
    const text = buildUserInfoText({
        nickname: buildNickname(user),
        username: user.username ?? '',
        userId: user.id,
    });

    await ctx.api.sendMessage(topic.chatId, text, {
        parse_mode: 'HTML',
        message_thread_id: topic.messageThreadId,
        reply_markup: buildSessionKeyboard(),
    });
}

/**
 * 为用户创建客服话题（已存在同群组话题时复用），并在话题中发送用户信息
 * @param ctx 机器人上下文
 * @returns 处理完成后的 Promise
 */
export async function ensureUserTopic(ctx: Context): Promise<void> {
    const from = ctx.from;
    if (!from) return;

    const chatId = await getGroupChatId();
    if (!chatId) {
        logger.warn(`未配置客服群组 ID，跳过话题创建: userId=${from.id}`);
        return;
    }

    const existing = await findUserTopicByUserId(from.id);
    if (existing && existing.chatId === chatId) {
        logger.info(`用户话题已存在: userId=${from.id}, threadId=${existing.messageThreadId}`);
        return;
    }

    const topic = await ctx.api.createForumTopic(chatId, buildTopicName(from));
    const messageThreadId = topic.message_thread_id;

    await saveUserTopic({
        userId: from.id,
        chatId,
        messageThreadId,
        username: from.username ?? '',
        nickname: buildNickname(from),
    });

    await sendUserInfo(ctx, { chatId, messageThreadId }, from);
    logger.info(`用户话题创建完成: userId=${from.id}, chatId=${chatId}, threadId=${messageThreadId}`);
}

/**
 * 判断操作者是否可管理会话（超级管理员或群管理员）
 * @param ctx 机器人上下文
 * @param chatId 话题所在群组 ID
 * @returns 是否具备管理权限
 */
async function canManageSession(ctx: Context, chatId: number): Promise<boolean> {
    const fromId = ctx.from?.id;
    if (fromId === undefined) return false;
    if (fromId === BOT_CONFIG.superAdminId) return true;

    try {
        const member = await ctx.api.getChatMember(chatId, fromId);
        return member.status === 'creator' || member.status === 'administrator';
    } catch (err) {
        logger.warn(`获取群成员身份失败: ${err instanceof Error ? err.message : err}`);
        return false;
    }
}

/**
 * 注册双向消息桥接：用户私聊消息转发到对应话题，话题内回复转发给用户
 * @param bot 机器人实例
 * @returns 注册完成后的 Promise
 */
export function registerBridgeHandler(bot: Bot): void {
    bot.on('message', async (ctx: Context, next): Promise<void> => {
        const message = ctx.message;
        const chat = ctx.chat;
        const from = ctx.from;
        if (!message || !chat || !from || from.is_bot) {
            await next();
            return;
        }

        try {
            // 用户私聊消息 → 对应话题
            if (chat.type === 'private') {
                // 跳过超级管理员消息与命令，交由其他处理器处理
                if (from.id === BOT_CONFIG.superAdminId || message.text?.startsWith('/')) {
                    await next();
                    return;
                }

                const topic = await findUserTopicByUserId(from.id);
                if (!topic) {
                    await ctx.reply('请先发送 /start 开始会话。');
                    return;
                }

                // 被屏蔽的用户消息静默忽略，不转发也不通知
                if (await isUserSessionMuted(from.id)) {
                    logger.info(`用户会话处于屏蔽中，忽略消息: userId=${from.id}`);
                    return;
                }

                if (message.media_group_id) {
                    enqueueMediaGroup(`toTopic:${chat.id}:${message.media_group_id}`, {
                        api: ctx.api,
                        fromChatId: chat.id,
                        toChatId: topic.chatId,
                        messageThreadId: topic.messageThreadId,
                        messageIds: [message.message_id],
                        direction: 'toTopic',
                    });
                    return;
                }

                await ctx.api.forwardMessage(topic.chatId, chat.id, message.message_id, {
                    message_thread_id: topic.messageThreadId,
                });
                return;
            }

            // 话题内管理员回复 → 用户私聊
            if (
                (chat.type === 'group' || chat.type === 'supergroup') &&
                message.is_topic_message &&
                message.message_thread_id !== undefined
            ) {
                const topic = await findUserTopicByThread(chat.id, message.message_thread_id);
                if (!topic) {
                    await next();
                    return;
                }

                if (message.media_group_id) {
                    enqueueMediaGroup(`toUser:${chat.id}:${message.media_group_id}`, {
                        api: ctx.api,
                        fromChatId: chat.id,
                        toChatId: topic.userId,
                        messageThreadId: undefined,
                        messageIds: [message.message_id],
                        direction: 'toUser',
                    });
                    return;
                }

                await ctx.api.copyMessage(topic.userId, chat.id, message.message_id);
                return;
            }

            await next();
        } catch (err) {
            logger.error(`消息桥接失败: ${err instanceof Error ? err.stack : err}`);
        }
    });

    // 话题内会话操作按钮：屏蔽会话 / 关闭并删除话题
    bot.callbackQuery(/^bridge:/, async (ctx): Promise<void> => {
        const callbackMessage = ctx.callbackQuery.message;
        const chatId = callbackMessage?.chat.id;
        const threadId =
            callbackMessage && 'message_thread_id' in callbackMessage
                ? callbackMessage.message_thread_id
                : undefined;

        if (chatId === undefined || threadId === undefined) {
            await ctx.answerCallbackQuery({ text: '无法定位当前话题', show_alert: true });
            return;
        }

        if (!(await canManageSession(ctx, chatId))) {
            await ctx.answerCallbackQuery({ text: '无权限操作', show_alert: true });
            return;
        }

        const action = ctx.callbackQuery.data;

        try {
            const topic = await findUserTopicByThread(chatId, threadId);
            if (!topic) {
                await ctx.answerCallbackQuery({ text: '会话映射不存在，可能已被删除', show_alert: true });
                return;
            }

            if (action === 'bridge:mute') {
                await ctx.editMessageText(await buildSessionPanelText(topic), {
                    parse_mode: 'HTML',
                    reply_markup: buildMuteKeyboard(),
                });
                await ctx.answerCallbackQuery();
                return;
            }

            if (action === 'bridge:back') {
                await ctx.editMessageText(await buildSessionPanelText(topic), {
                    parse_mode: 'HTML',
                    reply_markup: buildSessionKeyboard(),
                });
                await ctx.answerCallbackQuery();
                return;
            }

            if (action.startsWith('bridge:mute:')) {
                const minutes = Number(action.slice('bridge:mute:'.length));
                const option = MUTE_OPTIONS.find((item) => item.minutes === minutes);
                if (!option) {
                    await ctx.answerCallbackQuery({ text: '时长参数无效', show_alert: true });
                    return;
                }

                await muteUserSession(topic.userId, option.minutes * 60);
                logger.info(`会话已屏蔽: userId=${topic.userId}, minutes=${option.minutes}`);
                await ctx.editMessageText(await buildSessionPanelText(topic), {
                    parse_mode: 'HTML',
                    reply_markup: buildSessionKeyboard(),
                });
                await ctx.answerCallbackQuery({ text: `已屏蔽该用户会话 ${option.label}` });
                return;
            }

            if (action === 'bridge:unmute') {
                if (!(await isUserSessionMuted(topic.userId))) {
                    await ctx.answerCallbackQuery({ text: '该会话当前未被屏蔽' });
                    return;
                }

                await unmuteUserSession(topic.userId);
                logger.info(`会话已解除屏蔽: userId=${topic.userId}`);
                await ctx.editMessageText(await buildSessionPanelText(topic), {
                    parse_mode: 'HTML',
                    reply_markup: buildSessionKeyboard(),
                });
                await ctx.answerCallbackQuery({ text: '已解除屏蔽' });
                return;
            }

            if (action === 'bridge:close') {
                await ctx.api.deleteForumTopic(chatId, threadId);
                await deleteUserTopic(topic.userId);
                await unmuteUserSession(topic.userId);
                logger.info(`话题已关闭并删除: userId=${topic.userId}, threadId=${threadId}`);
                await ctx.answerCallbackQuery({ text: '话题已删除' });
                return;
            }

            await ctx.answerCallbackQuery();
        } catch (err) {
            logger.error(`会话操作失败: ${err instanceof Error ? err.stack : err}`);
            await ctx.answerCallbackQuery({ text: '操作失败，请稍后重试', show_alert: true }).catch(
                () => undefined
            );
        }
    });
}
