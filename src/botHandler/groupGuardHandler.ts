import type { Bot, Context } from 'grammy';
import type { Message, MessageEntity } from 'grammy/types';
import logger from '../services/loggerService.js';
import { getGroupGuardConfig } from '../services/groupGuardCacheService.js';
import type { GroupRuleConfig, GroupRuleKey } from '../services/groupService.js';

/**
 * 读取消息中被 Telegram 解析出的实体（正文与媒体说明）
 * @param message 群消息
 * @returns 消息实体列表
 */
function getMessageEntities(message: Message): MessageEntity[] {
    const entities = 'entities' in message ? message.entities ?? [] : [];
    const captionEntities = 'caption_entities' in message ? message.caption_entities ?? [] : [];
    return [...entities, ...captionEntities];
}

/**
 * 读取消息的文本内容（正文与媒体说明）
 * @param message 群消息
 * @returns 拼接后的文本内容
 */
function getMessageContent(message: Message): string {
    const text = 'text' in message ? message.text ?? '' : '';
    const caption = 'caption' in message ? message.caption ?? '' : '';
    return `${text}\n${caption}`;
}

/**
 * 判断消息是否包含链接
 * @param message 群消息
 * @returns 是否包含 URL 或文本链接
 */
function hasLink(message: Message): boolean {
    return getMessageEntities(message).some(
        (entity) => entity.type === 'url' || entity.type === 'text_link'
    );
}

/**
 * 判断消息是否命中关键词或正则（不区分大小写）
 * 正则同时对整条内容与每一行进行测试，便于 ^...$ 之类的锚点规则匹配单行
 * @param message 群消息
 * @param keywords 该群配置的关键词列表
 * @param regexes 内置正则列表
 * @returns 是否命中关键词或正则
 */
function hasKeyword(message: Message, keywords: string[], regexes: RegExp[]): boolean {
    if (!keywords.length && !regexes.length) return false;

    const content = getMessageContent(message).toLowerCase();
    if (!content.trim()) return false;

    if (keywords.some((keyword) => keyword && content.includes(keyword.toLowerCase()))) return true;
    if (!regexes.length) return false;

    const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const candidates = [content, ...lines];

    return regexes.some((regex) => candidates.some((candidate) => regex.test(candidate)));
}

/**
 * 判断消息是否引用了频道或群组消息
 * 说明：external_reply 表示回复的目标消息来自其他频道/群组，origin 为 chat/channel 时视为引用群组或频道消息
 * @param message 群消息
 * @returns 是否引用了频道或群组消息
 */
function isReplyToChat(message: Message): boolean {
    if (!('external_reply' in message) || !message.external_reply) return false;

    const originType = message.external_reply.origin.type;
    return originType === 'chat' || originType === 'channel';
}

/**
 * 判断消息命中的自动删除规则
 * @param message 群消息
 * @param rules 规则开关
 * @param keywords 该群配置的关键词列表
 * @param regexes 内置正则列表
 * @param maxTextLength 长文本删除阈值（字符数）
 * @returns 命中的规则标识，未命中时返回 null
 */
function detectViolation(
    message: Message,
    rules: GroupRuleConfig,
    keywords: string[],
    regexes: RegExp[],
    maxTextLength: number
): GroupRuleKey | null {
    if (rules.forward && 'forward_origin' in message && message.forward_origin) return 'forward';
    if (rules.sticker && 'sticker' in message && message.sticker) return 'sticker';
    if (rules.photo && 'photo' in message && message.photo) return 'photo';
    if (rules.video && 'video' in message && message.video) return 'video';
    if (rules.file && 'document' in message && message.document) return 'file';
    if (rules.inline && 'via_bot' in message && message.via_bot) return 'inline';
    if (rules.reply_chat && isReplyToChat(message)) return 'reply_chat';
    if (rules.sender_chat && 'sender_chat' in message && message.sender_chat) return 'sender_chat';
    if (rules.contact && 'contact' in message && message.contact) return 'contact';
    if (rules.link && hasLink(message)) return 'link';
    if (rules.keyword && hasKeyword(message, keywords, regexes)) return 'keyword';
    if (rules.long_text && getMessageContent(message).trim().length > maxTextLength) return 'long_text';
    return null;
}

/**
 * 注册群消息守卫：按群组配置的规则监听群消息并自动删除违规消息
 * @param bot 机器人实例
 * @returns 注册完成后的 Promise
 */
export function registerGroupGuardHandler(bot: Bot): void {
    bot.on('message', async (ctx: Context, next): Promise<void> => {
        const message = ctx.message;
        const chat = ctx.chat;
        if (!message || !chat) {
            await next();
            return;
        }
        if (chat.type !== 'group' && chat.type !== 'supergroup') {
            await next();
            return;
        }

        if (ctx.from?.is_bot) {
            await next();
            return;
        }

        try {
            const config = await getGroupGuardConfig(chat.id);
            // 未登记的群组或机器人已退出时不做处理
            if (!config) {
                await next();
                return;
            }

            const { rules, keywords, regexes, whitelist, maxTextLength } = config;

            // 白名单用户的消息不做任何删除
            if (ctx.from && whitelist.includes(ctx.from.id)) {
                await next();
                return;
            }

            // 全部规则关闭时直接放行
            if (!Object.values(rules).some(Boolean)) {
                await next();
                return;
            }

            const rule = detectViolation(message, rules, keywords, regexes, maxTextLength);
            if (!rule) {
                await next();
                return;
            }

            try {
                await ctx.api.deleteMessage(chat.id, message.message_id);
                logger.info(
                    `群消息自动删除: chatId=${chat.id}, messageId=${message.message_id}, rule=${rule}, userId=${ctx.from?.id ?? 0}`
                );
                return;
            } catch (err) {
                logger.warn(
                    `群消息删除失败: chatId=${chat.id}, messageId=${message.message_id}, rule=${rule}, ${err instanceof Error ? err.message : err}`
                );
                await next();
            }
        } catch (err) {
            logger.error(`群消息规则检测失败: ${err instanceof Error ? err.stack : err}`);
            await next();
        }
    });
}
