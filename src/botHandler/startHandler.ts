import type { Bot, Context } from 'grammy';
import { BOT_CONFIG } from '../config/index.js';
import logger from '../services/loggerService.js';
import { getWelcomeConfig } from '../services/welcomeService.js';
import { buildWelcomeKeyboard } from '../utils/welcomeKeyboard.js';
import { ensureUserTopic } from './bridgeHandler.js';

/** start payload 处理函数签名 */
type StartPayloadHandler = (ctx: Context, payload: string) => Promise<void>;

/**
 * 发送欢迎语
 * @param ctx 机器人上下文
 * @returns 回复完成后的 Promise
 */
async function sendWelcomeMessage(ctx: Context): Promise<void> {
    const { content, buttons } = await getWelcomeConfig();

    if (!content) {
        logger.info('未配置欢迎语文字，跳过欢迎语回复');
        return;
    }

    await ctx.reply(content, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(buttons.length ? { reply_markup: buildWelcomeKeyboard(buttons) } : {}),
    });
}

/**
 * 回复配置说明，仅超级管理员可见
 * @param ctx 机器人上下文
 * @returns 回复完成后的 Promise
 */
async function handleConfig(ctx: Context): Promise<void> {
    const fromId = ctx.from?.id;
    if (!BOT_CONFIG.superAdminId || fromId !== BOT_CONFIG.superAdminId) {
        await ctx.reply('无权限查看配置。');
        return;
    }

    const configStr = `
<tg-emoji emoji-id="4999434394599948988">🎮</tg-emoji><b> 配置说明</b>
1. 创建一个<b>群组</b>
2. 将我添加进群组，并设为<b>管理员</b>
3. 将群组类型修改为「话题（<b>列表</b>）」模式
4. 在群组管理员中找到我并点击，确认已开启「<b>管理话题</b>」权限
5. 向我发送 <code>/config</code> 命令，配置会话ID即可
<b>至此配置完成...</b>
`;

    await ctx.reply(configStr, {
        parse_mode: 'HTML',
    });
}

/** start payload 与处理函数的映射表 */
const payloadHandlers: Map<string, StartPayloadHandler> = new Map([
    ['config', handleConfig],
]);

/**
 * 深链接携带 payload start 命令处理器
 * @param bot 机器人实例
 * @returns 注册完成后的 Promise
 */
export function registerStartHandler(bot: Bot): void {
    bot.command('start', async (ctx: Context): Promise<void> => {
        const rawPayload = typeof ctx.match === 'string' ? ctx.match : '';
        const payload = rawPayload.trim().toLowerCase();

        logger.info(`收到 start 命令: userId=${ctx.from?.id}, payload=${payload || '(空)'}`);

        try {
            if (!payload) {
                if (ctx.chat?.type === 'private') {
                    try {
                        await ensureUserTopic(ctx);
                    } catch (err) {
                        logger.error(`创建用户话题失败: ${err instanceof Error ? err.stack : err}`);
                    }
                }

                await sendWelcomeMessage(ctx);
                return;
            }

            await payloadHandlers.get(payload)?.(ctx, payload);
        } catch (err) {
            logger.error(`start 命令处理失败: ${err instanceof Error ? err.stack : err}`);
            await ctx.reply('处理失败，请稍后重试。');
        }
    });
}
