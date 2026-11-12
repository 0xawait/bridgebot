import { InlineKeyboard, type Bot } from 'grammy';
import { BOT_CONFIG } from '../config/index.js';
import logger from '../services/loggerService.js';
import { getGroupChatId } from '../services/groupConfigService.js';

/**
 * 向超级管理员发送启动通知
 * 仅在未配置客服群组 ID 时发送，已配置则跳过
 * @param bot 机器人实例
 * @returns 通知发送完成后的 Promise
 */
export async function notifySuperAdmin(bot: Bot): Promise<void> {
    const superAdminId = BOT_CONFIG.superAdminId;
    if (!superAdminId) {
        logger.warn('未配置超级管理员 ID，跳过启动通知');
        return;
    }

    try {
        const groupChatId = await getGroupChatId();
        if (groupChatId !== null) {
            logger.info(`已配置客服群组 ID: ${groupChatId}，跳过启动通知`);
            return;
        }

        await bot.init();

        const configKeyboard = new InlineKeyboard()
            .url('查看配置说明', `https://t.me/${bot.botInfo.username}?start=config`)
            .icon('5258216851472654189')
            .style('primary');

        await bot.api.sendMessage(superAdminId, '<tg-emoji emoji-id="4996755833950831347">🎉</tg-emoji><b>机器人已成功启动...</b>',
            {
                parse_mode: 'HTML',
                reply_markup: configKeyboard,
            },
        );
        logger.info(`启动通知已发送给超级管理员: ${superAdminId}`);
    } catch (err) {
        logger.error(`启动通知发送失败: ${err instanceof Error ? err.stack : err}`);
    }
}