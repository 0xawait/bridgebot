import type { Bot, Context } from 'grammy';
import logger from '../services/loggerService.js';

/**
 * 注册 /id 命令，在群组中回复当前群组 ID
 * @param bot 机器人实例
 * @returns 注册完成后的 Promise
 */
export function registerIdHandler(bot: Bot): void {
    bot.command('id', async (ctx: Context): Promise<void> => {
        const chat = ctx.chat;
        if (!chat) return;
        console.log(chat);

        if (chat.type !== 'group' && chat.type !== 'supergroup') {
            await ctx.reply('请在群组中使用该命令获取群组 ID。');
            return;
        }

        logger.info(`收到 id 命令: chatId=${chat.id}, userId=${ctx.from?.id}`);
        await ctx.reply(`当前群组 ID：<code>${chat.id}</code>`, { parse_mode: 'HTML' });
    });
}
